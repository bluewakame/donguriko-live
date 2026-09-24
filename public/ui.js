const author = document.getElementById("author");
const comment = document.getElementById("comment");
const reply = document.getElementById("reply");
const status = document.getElementById("status");
const manualPanel = document.getElementById("manualPanel");
const manualText = document.getElementById("manualText");
const dongurikoSprite = document.getElementById("dongurikoSprite");
const dongurikoFace = document.getElementById("dongurikoFace");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const spriteFrameWidth = 256;
const spriteFrameHeight = 384;
const params = new URLSearchParams(window.location.search);
const isVerticalLayout = params.get("layout") === "vertical" || window.location.pathname === "/vertical";

const spriteStates = {
  idle: { row: 0, frames: 6, frameMs: 230 },
  waiting: { row: 6, frames: 6, frameMs: 260 },
  failed: { row: 5, frames: 8, frameMs: 170 },
  review: { row: 8, frames: 6, frameMs: 210 }
};

let petStateName = "waiting";
let petFrame = 0;
let petLastFrameAt = 0;
const defaultPetX = 50;
let petX = defaultPetX;
let petLastTrickAt = 0;
let petSpeaking = false;
let lookX = 0;
let lookY = 0;
let lookTargetX = 0;
let lookTargetY = 0;
let lookMode = "auto";
let lastKeyboardLookAt = 0;
let nextBlinkAt = performance.now() + 2200 + Math.random() * 2800;
let blinkUntil = 0;

const live2dCanvas = document.getElementById("live2dCanvas");
const numberParam = (name, fallback) => {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const audioVolume = clamp(numberParam("volume", 1), 0, 1);
const mouthGain = numberParam("mouthGain", 5.5) > 0 ? numberParam("mouthGain", 5.5) : 5.5;
let live2dReady = false;
let audioCtx = null;
let analyser = null;
let timeData = null;
let currentSource = null;
let lastAudioToken = "";
let audioBlocked = false;
let mouthEnvelope = [];
let mouthFrameMs = 40;
let mouthEnvelopeStartAt = 0;

if (isVerticalLayout) {
  document.body.classList.add("vertical");
}
if (params.get("obs") === "1") {
  document.body.classList.add("obs");
}

const requestedPetScale = Number(params.get("petScale"));
const requestedPetX = Number(params.get("petX"));
const requestedPetBottom = Number(params.get("petBottom"));
if (Number.isFinite(requestedPetScale) && requestedPetScale > 0) {
  dongurikoSprite?.style.setProperty("--sprite-scale", String(requestedPetScale));
}
if (Number.isFinite(requestedPetX)) {
  petX = requestedPetX;
}
if (Number.isFinite(requestedPetBottom)) {
  const bottom = document.body.classList.contains("vertical")
    ? Math.max(requestedPetBottom, 0)
    : requestedPetBottom;
  dongurikoSprite?.style.setProperty("bottom", `${bottom}vh`);
}

async function initLive2D() {
  if (!live2dCanvas || !window.DongurikoLive2D) return;
  try {
    await window.DongurikoLive2D.init(live2dCanvas);
    const modelScale = numberParam("modelScale", 1);
    window.DongurikoLive2D.setPlacement({
      scale: isVerticalLayout ? 0.82 : 0.96,
      extra: modelScale > 0 ? modelScale : 1,
      x: numberParam("modelX", 0.5),
      y: numberParam("modelY", 1)
    });
    live2dReady = true;
    document.body.classList.add("live2d-ready");
  } catch (error) {
    // 読み込みに失敗したらスプライト立ち絵のまま動かす
    console.error("Live2D init failed:", error);
    status.textContent = `live2d error: ${error.message}`;
  }
}

function ensureAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

function stopSpeechAudio() {
  if (currentSource) {
    try {
      currentSource.onended = null;
      currentSource.stop();
    } catch {
      // 再生済みなら何もしない
    }
  }
  currentSource = null;
  analyser = null;
}

async function playSpeechAudio(token) {
  try {
    const ctx = ensureAudioContext();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    audioBlocked = ctx.state === "suspended";

    const res = await fetch(`/audio/last.wav?t=${encodeURIComponent(token)}`, { cache: "no-store" });
    if (!res.ok) return;
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());

    stopSpeechAudio();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = audioVolume;
    const node = ctx.createAnalyser();
    node.fftSize = 1024;
    node.smoothingTimeConstant = 0.4;
    source.connect(node);
    node.connect(gain);
    gain.connect(ctx.destination);
    source.onended = () => {
      if (currentSource === source) stopSpeechAudio();
    };
    source.start();
    currentSource = source;
    analyser = node;
    timeData = new Uint8Array(node.fftSize);
  } catch (error) {
    status.textContent = `audio error: ${error.message}`;
  }
}

function currentMouthLevel(now) {
  // サーバー側で音声を鳴らす構成では、送られてきた音量の包絡線をなぞる
  if (mouthEnvelope.length) {
    const index = Math.floor((now - mouthEnvelopeStartAt) / mouthFrameMs);
    if (index >= 0 && index < mouthEnvelope.length) return clamp(mouthEnvelope[index], 0, 1);
    if (index >= mouthEnvelope.length) mouthEnvelope = [];
    return 0;
  }

  if (analyser && timeData) {
    analyser.getByteTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i += 1) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    return clamp(Math.sqrt(sum / timeData.length) * mouthGain, 0, 1);
  }
  // ブラウザ再生を使わない構成では、しゃべっている間だけ擬似的に口を動かす
  if (petSpeaking) return 0.35 + 0.35 * (Math.sin(now / 90) * 0.5 + 0.5);
  return 0;
}

function resumeAudioOnGesture() {
  if (!audioCtx || audioCtx.state !== "suspended") return;
  audioCtx.resume().then(() => {
    audioBlocked = false;
  }).catch(() => {});
}

function setPetState(name) {
  if (!spriteStates[name] || petStateName === name) return;
  petStateName = name;
  petFrame = 0;
  petLastFrameAt = 0;
}

function setLookTarget(x, y, mode = lookMode) {
  lookTargetX = clamp(x, -2, 2);
  lookTargetY = clamp(y, -2, 2);
  lookMode = mode;
}

function isTypingTarget(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || target?.isContentEditable;
}

function handleKeyboardLook(event) {
  if (isTypingTarget(event.target)) return;

  const moves = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    KeyA: [-1, 0],
    KeyD: [1, 0],
    KeyW: [0, -1],
    KeyS: [0, 1],
    KeyJ: [-1, 0],
    KeyL: [1, 0],
    KeyI: [0, -1],
    KeyK: [0, 1]
  };

  if (moves[event.code]) {
    const [dx, dy] = moves[event.code];
    setLookTarget(lookTargetX + dx, lookTargetY + dy, "keyboard");
    lastKeyboardLookAt = performance.now();
    event.preventDefault();
    return;
  }

  if (event.code === "Home" || event.code === "Numpad5") {
    setLookTarget(0, 0, "keyboard");
    lastKeyboardLookAt = performance.now();
    event.preventDefault();
  }
}

function handlePointerLook(event) {
  if (!dongurikoSprite || event.pointerType === "mouse") return;
  const rect = document.body.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width - 0.5) * 4;
  const y = ((event.clientY - rect.top) / rect.height - 0.5) * 4;
  setLookTarget(x, y, "touch");
}

function updateLook(now) {
  if (lookMode === "keyboard" && now - lastKeyboardLookAt > 12000) {
    lookMode = "auto";
  }

  if (lookMode === "auto") {
    const drift = now / (petSpeaking ? 520 : 1450);
    const speakingBias = petSpeaking ? 0.5 : 0;
    setLookTarget(
      Math.round((Math.sin(drift) * 1.65 + speakingBias) * 2) / 2,
      Math.round(Math.sin(drift * 0.72 + 1.1) * 1.15 * 2) / 2,
      "auto"
    );
  }

  lookX += (lookTargetX - lookX) * 0.16;
  lookY += (lookTargetY - lookY) * 0.16;
}

function updateFaceAtlas(now) {
  if (!dongurikoFace) return;

  if (now >= nextBlinkAt) {
    blinkUntil = now + 145;
    nextBlinkAt = now + 2600 + Math.random() * 3200;
  }

  const faceSize = 112;
  const faceCol = clamp(Math.round(lookX) + 2, 0, 4);
  const faceRow = clamp(Math.round(lookY) + 2, 0, 4);
  const isBlinking = now < blinkUntil;
  const isMouthOpen = petSpeaking && !isBlinking && Math.floor(now / 170) % 2 === 0;

  dongurikoFace.style.setProperty("--face-offset-x", `${faceCol * -faceSize}px`);
  dongurikoFace.style.setProperty("--face-offset-y", `${faceRow * -faceSize}px`);
  dongurikoFace.classList.toggle("blink", isBlinking);
  dongurikoFace.classList.toggle("mouth-open", isMouthOpen);
}

function chooseAmbientState(now) {
  if (petSpeaking || now - petLastTrickAt < 4200) return;

  petLastTrickAt = now;
  setPetState(Math.random() > 0.5 ? "waiting" : "idle");
}

function animateDonguriko(now = 0) {
  if (!dongurikoSprite) return;

  chooseAmbientState(now);
  updateLook(now);
  updateFaceAtlas(now);
  const state = spriteStates[petStateName];
  if (now - petLastFrameAt >= state.frameMs) {
    petFrame = (petFrame + 1) % state.frames;
    petLastFrameAt = now;
  }

  dongurikoSprite.style.setProperty("--frame-offset-x", `${petFrame * -spriteFrameWidth}px`);
  dongurikoSprite.style.setProperty("--frame-offset-y", `${state.row * -spriteFrameHeight}px`);
  dongurikoSprite.style.setProperty("--pet-x", petX.toFixed(2));
  dongurikoSprite.style.setProperty("--look-tilt", "0px");
  dongurikoSprite.style.setProperty("--look-squash", "1");

  if (live2dReady) {
    window.DongurikoLive2D.setLook(lookX / 2, lookY / 2);
    window.DongurikoLive2D.setSpeaking(petSpeaking);
    window.DongurikoLive2D.setMouth(currentMouthLevel(now));
  }

  requestAnimationFrame(animateDonguriko);
}

function readableReply(text, state) {
  const value = String(text || "").trim();
  if (!value || /[鬩驍譁蜿繧縺譽謌隰髯鬮]/.test(value)) {
    return state.isSpeaking
      ? "\u0044\u006f\u006e\u0067\u0075\u0072\u0069\u006b\u006f\u304c\u304a\u3057\u3083\u3079\u308a\u4e2d\u3060\u3088"
      : "\u68ee\u306e\u30c1\u30e3\u30c3\u30c8\u3092\u5f85\u3063\u3066\u308b\u3088";
  }
  return value;
}

function render(state) {
  const service = state.commentService ? `[${state.commentService}] ` : "";
  author.textContent = state.commentAuthor ? `${service}${state.commentAuthor}:` : "";
  comment.textContent = state.commentText || "";
  reply.textContent = readableReply(state.replyText, state);
  status.textContent = state.lastError ? `${state.status} / ${state.lastError}` : state.status;

  if (state.audioToken && state.audioToken !== lastAudioToken) {
    lastAudioToken = state.audioToken;
    if (Array.isArray(state.mouthEnvelope) && state.mouthEnvelope.length) {
      mouthEnvelope = state.mouthEnvelope;
      mouthFrameMs = state.mouthFrameMs || 40;
      mouthEnvelopeStartAt = performance.now() + (state.lipSyncOffsetMs || 0);
    } else {
      mouthEnvelope = [];
      playSpeechAudio(state.audioToken);
    }
  }
  if (audioBlocked) {
    status.textContent = "画面を1回クリックすると音声が出ます";
  }

  petSpeaking = Boolean(state.isSpeaking);
  if (dongurikoSprite) {
    dongurikoSprite.classList.toggle("speaking", petSpeaking);
    if (state.lastError) {
      setPetState("failed");
    } else if (petSpeaking) {
      setPetState("waiting");
    } else if (state.status === "ready") {
      setPetState("waiting");
    } else {
      setPetState("review");
    }
  }
}

async function loadInitialState() {
  try {
    const res = await fetch("/state");
    if (res.ok) {
      const initial = await res.json();
      // 表示を開いた時点で残っている音声トークンは再生しない（言い終わった分の鳴り直しを防ぐ）
      lastAudioToken = initial.audioToken || "";
      render(initial);
    }
  } catch {
    status.textContent = "preview";
  }
}

requestAnimationFrame(animateDonguriko);
initLive2D();
loadInitialState();
window.addEventListener("pointerdown", resumeAudioOnGesture);
window.addEventListener("keydown", resumeAudioOnGesture);
window.addEventListener("keydown", handleKeyboardLook);
window.addEventListener("pointermove", handlePointerLook, { passive: true });

const source = new EventSource("/events");
source.onmessage = (event) => render(JSON.parse(event.data));
source.onerror = () => {
  status.textContent = "reconnecting";
};

manualPanel?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = manualText.value.trim();
  if (!text) return;
  manualText.value = "";
  await fetch("/manual-speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
});
