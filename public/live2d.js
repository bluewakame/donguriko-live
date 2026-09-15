// Live2D (Cubism 4/5) 表示レイヤー。
// 依存: /vendor/live2dcubismcore.min.js, /vendor/pixi.min.js, /vendor/cubism4.min.js
// モデル: /live2d/Donguriko/Donguriko.model3.json
//
// このモデルで実際に変形が入っているのは6パラメータ:
//   ParamAngleX / ParamAngleY / ParamAngleZ / ParamEyeLOpen / ParamEyeROpen / ParamMouthOpenY
// まばたきは model3.json の EyeBlink グループを使ってライブラリ側が自動で行う。
// 呼吸ゆれ(updateNaturalMovements)も内部で ParamAngle* に加算される。

const DongurikoLive2D = (() => {
  const MODEL_URL = "/live2d/Donguriko/Donguriko.model3.json";
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  const target = { lookX: 0, lookY: 0, mouth: 0, speaking: false };
  let app = null;
  let model = null;
  let ready = false;
  let mouthShown = 0;
  let tiltPhase = 0;
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
    const rate = wanted > mouthShown ? 0.55 : 0.28;
    mouthShown += (wanted - mouthShown) * rate;
    core.setParameterValueById("ParamMouthOpenY", clamp(mouthShown, 0, 1));

    // 首の向き: -1..1 を -30..30 のパラメータ値へ
    core.setParameterValueById("ParamAngleX", clamp(target.lookX, -1, 1) * 30);
    core.setParameterValueById("ParamAngleY", clamp(-target.lookY, -1, 1) * 30);

    // 首の傾き: 物理演算が無いモデルなので、ゆっくりした揺れをコードで足す
    tiltPhase += dt * (target.speaking ? 1.9 : 0.9);
    const tilt = Math.sin(tiltPhase) * (target.speaking ? 9 : 5);
    core.setParameterValueById("ParamAngleZ", tilt + clamp(target.lookX, -1, 1) * 6);
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

    // モーション適用後・まばたき適用前にパラメータを書き込む
    model.internalModel.on("afterMotionUpdate", applyParams);

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
      return { app, model, placement };
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
