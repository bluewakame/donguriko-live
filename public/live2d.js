// Live2D (Cubism 4/5) 表示レイヤー。
// 依存: /vendor/live2dcubismcore.min.js, /vendor/pixi.min.js, /vendor/cubism4.min.js
// 既定モデル: /live2d/DongurikoArms/Donguriko_arms_rig.model3.json
// 従来の顔可動モデルへ戻す場合: URLに ?avatar=face を付ける
//
// 統合モデルでは ParamBodyAngleX / ParamEye* / ParamMouthOpenY が同時に動く。

const DongurikoLive2D = (() => {
  const requestedAvatar = new URLSearchParams(window.location.search).get("avatar");
  const avatarMode = ["face", "body"].includes(requestedAvatar) ? requestedAvatar : "arms";
  const MODEL_URL = avatarMode === "face"
    ? "/live2d/Donguriko/Donguriko.model3.json"
    : avatarMode === "body"
      ? "/live2d/DongurikoMcp/Donguriko_mcp_full_rig.model3.json"
      : "/live2d/DongurikoArms/Donguriko_arms_rig.model3.json";
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  const target = { lookX: 0, lookY: 0, mouth: 0, speaking: false };
  let app = null;
  let model = null;
  let ready = false;
  let mouthShown = 0;
  let tiltPhase = 0;
  let breathPhase = 0;
  let gesturePhase = 0;
  let gestureStrength = 0;
  let lastFrameAt = 0;
  let placement = { scale: 1, x: 0.5, y: 1, extra: 1 };

  function layout() {
    if (!app || !model) return;
    // PIXIのresizeToはタイミング次第で0のままになることがあるので、親要素から実寸を取り直す
    const host = app.view.parentElement;
    const w = host?.clientWidth || app.renderer.width / app.renderer.resolution;
    const h = host?.clientHeight || app.renderer.height / app.renderer.resolution;
    if (!w || !h) return;
    app.renderer.resize(w, h);
    const base = model.internalModel.originalHeight || 1;
    const fit = (h * placement.scale) / base;
    model.scale.set(fit * placement.extra);
    model.anchor.set(0.5, 1);
    model.position.set(w * placement.x, h * placement.y);
  }

  function applyParams() {
    if (!model) return;
    const core = model.internalModel.coreModel;
    const now = performance.now();
    const dt = lastFrameAt ? Math.min((now - lastFrameAt) / 1000, 0.1) : 0.016;
    lastFrameAt = now;

    // 口: 音量エンベロープを追従（開くのは速く、閉じるのはやや遅く）
    const wanted = clamp(target.mouth, 0, 1);
    const rate = 1 - Math.exp(-dt * (wanted > mouthShown ? 48 : 20));
    mouthShown += (wanted - mouthShown) * rate;
    core.setParameterValueById("ParamMouthOpenY", clamp(mouthShown, 0, 1));

    // 首の向き: -1..1 を -30..30 のパラメータ値へ
    core.setParameterValueById("ParamAngleX", clamp(target.lookX, -1, 1) * 30);
    core.setParameterValueById("ParamAngleY", clamp(-target.lookY, -1, 1) * 30);

    // 首の傾き: 物理演算が無いモデルなので、ゆっくりした揺れをコードで足す
    tiltPhase += dt * (target.speaking ? 1.9 : 0.9);
    const tilt = Math.sin(tiltPhase) * (target.speaking ? 9 : 5);
    core.setParameterValueById("ParamAngleZ", tilt + clamp(target.lookX, -1, 1) * 6);

    // 体: 待機中は小さく、発話中は少し大きく左右へ揺らす。
    // 顔可動モデルにはこの変形が無いが、未使用パラメータへの書き込みは無害。
    const bodySway = Math.sin(tiltPhase * 0.72) * (target.speaking ? 7 : 4)
      + clamp(target.lookX, -1, 1) * 2;
    core.setParameterValueById("ParamBodyAngleX", clamp(bodySway, -10, 10));

    breathPhase += dt * 1.45;
    core.setParameterValueById("ParamBreath", (Math.sin(breathPhase) + 1) * 0.5);

    // 発話の切替を滑らかにし、左右の腕に少し時間差を付ける。
    if (avatarMode === "arms") {
      gestureStrength += ((target.speaking ? 1 : 0) - gestureStrength) * (1 - Math.exp(-dt * 3));
      gesturePhase += dt * (0.9 + gestureStrength * 0.8);
      const shoulderBase = 0.3 + gestureStrength * 0.12;
      const shoulderRange = 0.035 + gestureStrength * 0.16;
      const elbowRange = 0.06 + gestureStrength * 0.24;
      core.setParameterValueById("ParamArmRAngle", clamp(shoulderBase + Math.sin(gesturePhase) * shoulderRange, 0, 1));
      core.setParameterValueById("ParamArmLAngle", clamp(shoulderBase + Math.sin(gesturePhase + 1.1) * shoulderRange, 0, 1));
      core.setParameterValueById("ParamElbowR", clamp(0.5 + Math.sin(gesturePhase * 1.15 + 0.7) * elbowRange, 0, 1));
      core.setParameterValueById("ParamElbowL", clamp(0.5 + Math.sin(gesturePhase * 1.15 + 2.0) * elbowRange, 0, 1));
    }
  }

  async function init(canvas) {
    if (!window.PIXI || !window.PIXI.live2d) throw new Error("pixi-live2d-display が読み込めていません");
    if (!window.Live2DCubismCore) throw new Error("Live2D Cubism Core が読み込めていません");

    app = new PIXI.Application({
      view: canvas,
      resizeTo: canvas.parentElement,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1
    });

    model = await PIXI.live2d.Live2DModel.from(MODEL_URL, { autoInteract: false });
    app.stage.addChild(model);

    // SDKの自動揺れ適用後に書き込み、まばたきの目パラメータは保持する。
    model.internalModel.on("beforeModelUpdate", applyParams);

    layout();
    // 初回はレイアウト確定前にsizeが0で取れることがあるので数フレーム追いかける
    for (let i = 1; i <= 4; i += 1) setTimeout(layout, i * 120);
    window.addEventListener("resize", layout);
    if (window.ResizeObserver && canvas.parentElement) {
      new ResizeObserver(() => layout()).observe(canvas.parentElement);
    }
    ready = true;
    return model;
  }

  return {
    init,
    // OBSでの位置調整・トラブル調査用
    debug() {
      return { app, model, placement, avatarMode, modelUrl: MODEL_URL };
    },
    get ready() {
      return ready;
    },
    setPlacement(next) {
      placement = { ...placement, ...next };
      layout();
    },
    setLook(x, y) {
      target.lookX = clamp(x, -1, 1);
      target.lookY = clamp(y, -1, 1);
      if (model) model.internalModel.focusController?.focus(target.lookX, -target.lookY);
    },
    setMouth(value) {
      target.mouth = clamp(value, 0, 1);
    },
    setSpeaking(value) {
      target.speaking = Boolean(value);
    }
  };
})();

window.DongurikoLive2D = DongurikoLive2D;
