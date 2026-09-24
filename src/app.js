import { createServer } from "node:http";
import { readFile, writeFile, appendFile, mkdir, copyFile, stat, rm, rename } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { join, resolve, extname, basename, sep } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createSystemOne } from "./system-one.js";
import { findUnsafeReason, isDistress, DISTRESS_REPLY, SAFE_REPLY, SAFETY_PROMPT } from "./safety.js";
import { normalizeTikTokConfig, runTikTokLoop } from "./tiktok.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "config.json");
const CONFIG_EXAMPLE_PATH = join(ROOT, "config.example.json");
const TOKENS_PATH = join(ROOT, "tokens.json");
const RUNTIME_DIR = join(ROOT, "runtime");
const PUBLIC_DIR = join(ROOT, "public");
const MEMORY_PATH = join(RUNTIME_DIR, "memory.json");
const DEFAULT_MARKDOWN_MEMORY_PATH = "memory.md";
const DEFAULT_MEMORY_INBOX_PATH = "memory-inbox.md";
const ONECOMME_IGNORED_PATH = join(RUNTIME_DIR, "onecomme-ignored.json");
const LAST_COMMENT_PATH = join(RUNTIME_DIR, "last-comment.json");
const TTS_CACHE_DIR = join(RUNTIME_DIR, "tts-cache");
const TTS_SEGMENT_DIR = join(RUNTIME_DIR, "tts-segments");
const TTS_SEGMENT_SLOTS = 16;
const NAME_REPLY = "どんぐりこだよ。気軽にどんぐりこって呼んでね。";
const MODEL_REPLY = "そこは内緒だよ。でも、ちゃんとコメントは見てるから安心してね。";
const ERROR_REPLY = "ごめんね、今ちょっとうまく考えられなかった。もう一回話しかけてね。";
const EMPTY_REPLY = "今のコメント、ちゃんと届いてるよ。もう少しだけ聞かせてね。";

const args = new Set(process.argv.slice(2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_NG_WORDS = [
  "死ね",
  "殺す",
  "自殺",
  "住所",
  "電話番号",
  "LINE ID",
  "ラインID",
  "discord.gg",
  "http://",
  "https://",
  "エロ",
  "アダルト",
  "セフレ",
  "薬物",
  "大麻",
  "覚醒剤",
  "爆破",
  "犯行予告"
];

const DEFAULT_IDLE_TOPICS = [
  "今日の配信でやってみたいこと",
  "最近ちょっとうれしかった小さなこと",
  "視聴者におすすめを聞いてみる",
  "この時間帯の過ごし方",
  "どんぐりこのポンコツな失敗談",
  "今の気分や調子",
  "季節や天気の話"
];

const DEFAULT_IDLE_MESSAGES = [
  "コメントが静かだね。どんぐりこ、ひとりでそわそわしてきちゃった。なんでもいいから話しかけてね。",
  "みんな見てるかな。よかったら今日あったこと教えてほしいな。",
  "静かな時間もいいけど、どんぐりこはおしゃべりしたいよ。ひとことだけでもうれしいな。"
];

let clients = new Set();
let recentCommentKeys = new Map();
let gradioUploadCache = new Map();
let commentQueue = Promise.resolve();
let pendingCommentCount = 0;
let pendingLatestOneCommeComment = null;
let shortTermMemory = [];
let longTermMemoryText = "";
let longTermMemoryMtimeMs = 0;
let weatherCache = { at: 0, reply: "" };
let lastViewerCount = null;
let lastViewerAnnouncementAt = 0;
let lastActivityAt = Date.now();
let lastIdleTalkAt = 0;
let idleTalkStreak = 0;
let recentIdleTalks = [];
let systemOne = createSystemOne();
let wavPlayer = null;
let currentAudioPath = join(RUNTIME_DIR, "last.wav");
let ttsSegmentCounter = 0;
let audioTokenCounter = 0;
let state = {
  status: "starting",
  speaker: "どんぐりこ",
  commentAuthor: "",
  commentService: "",
  commentText: "",
  replyText: "起動中だよ",
  isSpeaking: false,
  lastError: "",
  queueSize: 0,
  audioToken: "",
  audioMs: 0,
  mouthEnvelope: [],
  mouthFrameMs: 0,
  lipSyncOffsetMs: 0,
  lastLatency: null
};

async function main() {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await mkdir(TTS_CACHE_DIR, { recursive: true });
  await mkdir(TTS_SEGMENT_DIR, { recursive: true });
  const config = await loadConfig();
  normalizeBotConfig(config);
  systemOne = createSystemOne(config.systemOne);
  longTermMemoryText = await loadMarkdownMemory(config);
  shortTermMemory = await loadShortTermMemory(config);
  state.speaker = config.bot.displayName;

  if (args.has("--prewarm")) {
    await prewarmTtsCache(config, { quiet: false });
    return;
  }

  if (args.has("--auth-only")) {
    await ensureYoutubeTokens(config, true);
    console.log("YouTube認証が完了しました。");
    return;
  }

  if (args.has("--policy-test")) {
    runPolicyTest(config);
    return;
  }

  const uiServer = startUiServer(config);
  publish({ status: "ready", replyText: "コメント待ってるよ" });
  startViewerMonitor(config);
  startSpeedBoosters(config);

  if (args.has("--local-test")) {
    console.log("Local test started.");
    await handleComment(config, {
      id: `local-${Date.now()}`,
      author: "テスト視聴者",
      text: "今日の調子はどう？"
    });
    publish({ status: "test-complete", isSpeaking: false });
    console.log("Local test completed.");
    uiServer.close();
    setTimeout(() => process.exit(0), 100);
    return;
  }

  startIdleTalk(config);

  if (config.comments.source !== "onecomme") {
    await enqueueLastCommentOnStartup(config);
  }
  if (config.tiktok.enabled) startTikTok(config);
  await runCommentLoop(config);
}

// TikTok は YouTube（わんコメ）と並行して直接つなぐ。どちらのコメントも同じキューに入る。
function startTikTok(config) {
  runTikTokLoop(config, {
    onComment: (comment) => enqueueComment(config, comment, { replacePending: true }),
    onStatus: (tiktokStatus, error) => publish({ tiktokStatus, ...(error ? { lastError: `TikTok: ${error}` } : {}) })
  }).catch((error) => {
    console.warn(`[TikTok] 停止しました: ${error.message}`);
  });
}

async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error("config.json がありません。config.example.json をコピーして設定してください。");
  }
  const raw = await readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);
  const example = JSON.parse(await readFile(CONFIG_EXAMPLE_PATH, "utf8"));
  return deepMerge(example, config);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = value && typeof value === "object" && !Array.isArray(value)
      ? deepMerge(base[key] ?? {}, value)
      : value;
  }
  return out;
}

function normalizeBotConfig(config) {
  config.comments = config.comments ?? { source: config.youtube?.enabled === false ? "manual" : "youtube" };
  config.comments.source = config.comments.source ?? "youtube";
  config.comments.onecomme = config.comments.onecomme ?? {};
  config.comments.onecomme.websocketUrl = config.comments.onecomme.websocketUrl ?? "ws://127.0.0.1:11180/sub";
  config.comments.onecomme.reconnectIntervalMs = config.comments.onecomme.reconnectIntervalMs ?? 5000;
  // 受け付ける配信サービス（わんコメの service 名）。空なら全部受け付ける。
  config.comments.onecomme.services = (config.comments.onecomme.services ?? [])
    .map((service) => String(service).trim().toLowerCase())
    .filter(Boolean);
  normalizeTikTokConfig(config);
  config.youtube = config.youtube ?? { enabled: false, pollIntervalMs: 6000 };
  config.youtube.pollIntervalMs = config.youtube.pollIntervalMs ?? 6000;
  config.viewerMonitor = config.viewerMonitor ?? {};
  config.viewerMonitor.enabled = config.viewerMonitor.enabled ?? false;
  config.viewerMonitor.pollIntervalMs = Math.max(15000, Number(config.viewerMonitor.pollIntervalMs ?? 60000));
  config.viewerMonitor.increaseThreshold = Math.max(1, Number(config.viewerMonitor.increaseThreshold ?? 1));
  config.viewerMonitor.cooldownMs = Math.max(0, Number(config.viewerMonitor.cooldownMs ?? 5 * 60 * 1000));
  config.viewerMonitor.message = config.viewerMonitor.message ?? "見に来てくれた人が増えたみたい。よかったら気軽にコメントしてね、どんぐりこ待ってるよ。";
  config.idleTalk = config.idleTalk ?? {};
  config.idleTalk.enabled = config.idleTalk.enabled ?? false;
  config.idleTalk.idleMs = Math.max(30000, Number(config.idleTalk.idleMs ?? 180000));
  config.idleTalk.checkIntervalMs = Math.max(5000, Number(config.idleTalk.checkIntervalMs ?? 15000));
  config.idleTalk.minIntervalMs = Math.max(30000, Number(config.idleTalk.minIntervalMs ?? 120000));
  config.idleTalk.maxConsecutive = Math.max(0, Number(config.idleTalk.maxConsecutive ?? 3));
  config.idleTalk.useLlm = config.idleTalk.useLlm ?? true;
  config.idleTalk.topics = Array.isArray(config.idleTalk.topics) && config.idleTalk.topics.length > 0
    ? config.idleTalk.topics
    : DEFAULT_IDLE_TOPICS;
  config.idleTalk.messages = Array.isArray(config.idleTalk.messages) && config.idleTalk.messages.length > 0
    ? config.idleTalk.messages
    : DEFAULT_IDLE_MESSAGES;
  config.server = config.server ?? {};
  config.server.host = config.server.host ?? "127.0.0.1";
  config.server.port = config.server.port ?? 8787;
  if (process.env.PORT) {
    config.server.port = Number(process.env.PORT);
  }
  if (!Number.isInteger(config.server.port) || config.server.port <= 0) {
    throw new Error(`Invalid server port: ${config.server.port}`);
  }
  config.ollama = config.ollama ?? {};
  config.bot = config.bot ?? {};
  config.audio = config.audio ?? {};
  config.ollama.endpoint = config.ollama.endpoint ?? "http://127.0.0.1:11434";
  config.ollama.timeoutMs = config.ollama.timeoutMs ?? 90000;
  config.ollama.temperature = config.ollama.temperature ?? 0.55;
  config.ollama.topP = config.ollama.topP ?? 0.85;
  config.ollama.repeatPenalty = config.ollama.repeatPenalty ?? 1.18;
  config.ollama.numPredict = config.ollama.numPredict ?? 180;
  config.ollama.stream = config.ollama.stream ?? true;
  config.ollama.keepAlive = config.ollama.keepAlive ?? "30m";
  config.ollama.warmUp = config.ollama.warmUp ?? true;
  config.systemOne = config.systemOne ?? {};
  config.systemOne.enabled = config.systemOne.enabled ?? true;
  config.systemOne.filler = config.systemOne.filler ?? true;
  config.systemOne.prewarmAudio = config.systemOne.prewarmAudio ?? true;
  config.bot.displayName = config.bot.displayName ?? "どんぐりこ";
  config.bot.maxCommentLength = config.bot.maxCommentLength ?? 160;
  config.bot.maxReplyChars = config.bot.maxReplyChars ?? 180;
  config.bot.cooldownMs = config.bot.cooldownMs ?? 1000;
  config.bot.maxQueueSize = Math.max(1, Number(config.bot.maxQueueSize ?? 5));
  config.bot.replyLastCommentOnStartup = config.bot.replyLastCommentOnStartup ?? true;
  config.bot.ngWords = [...new Set([...(config.bot.ngWords ?? []), ...DEFAULT_NG_WORDS])];
  config.bot.distressReply = config.bot.distressReply || DISTRESS_REPLY;

  config.memory = config.memory ?? {};
  config.memory.enabled = config.memory.enabled ?? true;
  config.memory.maxTurns = Math.max(0, Number(config.memory.maxTurns ?? 8));
  config.memory.markdown = config.memory.markdown ?? {};
  config.memory.markdown.enabled = config.memory.markdown.enabled ?? true;
  config.memory.markdown.path = config.memory.markdown.path ?? DEFAULT_MARKDOWN_MEMORY_PATH;
  config.memory.markdown.maxChars = Math.max(0, Number(config.memory.markdown.maxChars ?? 6000));
  config.memory.markdown.reloadOnChange = config.memory.markdown.reloadOnChange ?? true;
  config.memory.interactionLog = config.memory.interactionLog ?? {};
  config.memory.interactionLog.enabled = config.memory.interactionLog.enabled ?? true;
  config.memory.interactionLog.path = config.memory.interactionLog.path ?? DEFAULT_MEMORY_INBOX_PATH;
  config.tools = config.tools ?? {};
  config.tools.time = config.tools.time ?? {};
  config.tools.time.enabled = config.tools.time.enabled ?? true;
  config.tools.time.timeZone = config.tools.time.timeZone ?? "Asia/Tokyo";
  config.tools.time.label = config.tools.time.label ?? "日本";
  config.tools.weather = config.tools.weather ?? {};
  config.tools.weather.enabled = config.tools.weather.enabled ?? true;
  config.tools.weather.locationName = config.tools.weather.locationName ?? "東京";
  config.tools.weather.latitude = Number(config.tools.weather.latitude ?? 35.6812);
  config.tools.weather.longitude = Number(config.tools.weather.longitude ?? 139.7671);
  config.tools.weather.timeZone = config.tools.weather.timeZone ?? config.tools.time.timeZone;
  config.tools.weather.cacheMs = Math.max(0, Number(config.tools.weather.cacheMs ?? 10 * 60 * 1000));

  config.bot.systemPrompt = config.bot.systemPrompt ?? [
    "あなたはYouTubeやTikTokの生配信でコメントに反応する、明るくて親しみやすいポンコツ配信者AIです。",
    "あなたの名前は必ず「どんぐりこ」です。名前を聞かれたら「どんぐりこだよ」と答えてください。",
    "名前を聞かれていない時は、自分の名前を名乗らないでください。",
    "視聴者のニックネームが渡された時は、返事の中に自然に入れてください。",
    "使っているAIモデル、LLM、Ollama、Gemmaなどの内部構成を聞かれても、具体名は出さずに「そこは内緒だよ」と自然にぼかしてください。",
    "ちょっと抜けていて、言い間違えたり、あわあわしたり、すぐ自分でツッコミを入れたりしますが、視聴者にはやさしく前向きに接してください。",
    "返答は日本語で自然に、2文から4文くらいで話してください。コメント内容に具体的に触れて、短すぎる相づちだけで終わらないでください。",
    "口調はやわらかくフレンドリーで、少しだけドジな配信者らしくしてください。ただし、意味が分からないほど壊れた文章や過剰な奇声にはしないでください。",
    "「なのだ」「のだ」「だぞ」「ござる」「なのです」などの特徴的な語尾やキャラクター口調は絶対に使わないでください。",
    "危険な助言、個人情報、差別、性的な内容、違法行為の支援は避けて、必要ならやんわり断ってください。"
  ].join("");
  config.audio.playGeneratedAudio = config.audio.playGeneratedAudio ?? true;
  config.audio.playInBrowser = config.audio.playInBrowser ?? false;
  config.audio.lipSyncOffsetMs = config.audio.lipSyncOffsetMs ?? 120;
  config.audio.persistentPlayer = config.audio.persistentPlayer ?? true;
}

async function runCommentLoop(config) {
  if (config.comments.source === "onecomme") {
    await runOneCommeLoop(config);
    return;
  }

  if (config.comments.source === "manual") {
    publish({ status: "manual", replyText: "コメント待ってるよ" });
    return;
  }

  if (!config.youtube.enabled) {
    publish({ status: "no-comments", replyText: "コメント待ってるよ" });
    return;
  }

  await runYoutubeLoop(config);
}

function startUiServer(config) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/events") return serveEvents(req, res);
    if (url.pathname === "/state") return sendJson(res, state);
    if (url.pathname === "/manual-speak" && req.method === "POST") return handleManualSpeak(req, res, config);
    if (url.pathname === "/audio/last.wav") return serveAudio(res);
    if (url.pathname === "/vertical") return serveStatic("/index.html", res);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    await serveStatic(path, res);
  });
  server.listen(config.server.port, config.server.host, () => {
    console.log(`OBS表示: http://${config.server.host}:${config.server.port}`);
  });
  return server;
}

async function handleManualSpeak(req, res, config) {
  try {
    const body = await readRequestJson(req);
    const text = String(body.text ?? "").trim();
    if (!text) return sendJson(res, { ok: false, error: "empty text" }, 400);
    enqueueComment(config, {
      id: `manual-${Date.now()}`,
      author: "手動テスト",
      text
    }, { force: true });
    return sendJson(res, { ok: true });
  } catch (error) {
    return sendJson(res, { ok: false, error: error.message }, 400);
  }
}

async function readRequestJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function serveEvents(_req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.write(`data: ${JSON.stringify(state)}\n\n`);
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

async function serveAudio(res) {
  try {
    const body = await readFile(currentAudioPath);
    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "Cache-Control": "no-store, max-age=0"
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

async function serveStatic(path, res) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    res.writeHead(400);
    res.end("bad request");
    return;
  }
  const filePath = join(PUBLIC_DIR, decodedPath.replaceAll("\\", "/"));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store, max-age=0"
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

function contentType(path) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".wav": "audio/wav"
  }[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function sendJson(res, value, statusCode = 200) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function publish(next) {
  state = { ...state, ...next };
  const event = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) {
    try {
      client.write(event);
    } catch {
      clients.delete(client);
    }
  }
}

async function ensureYoutubeTokens(config, force = false) {
  if (!force && existsSync(TOKENS_PATH)) {
    return JSON.parse(await readFile(TOKENS_PATH, "utf8"));
  }
  const { clientId, clientSecret, redirectPort } = config.youtube;
  if (!clientId || clientId.includes("YOUR_") || !clientSecret || clientSecret.includes("YOUR_")) {
    throw new Error("config.json に YouTube OAuth clientId/clientSecret を設定してください。");
  }

  const redirectUri = `http://127.0.0.1:${redirectPort}/oauth2callback`;
  const scope = encodeURIComponent("https://www.googleapis.com/auth/youtube.readonly");
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth"
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + "&response_type=code"
    + `&scope=${scope}`
    + "&access_type=offline"
    + "&prompt=consent";

  console.log("ブラウザで認証してください:");
  console.log(authUrl);

  const code = await waitForOauthCode(redirectPort);
  const token = await postForm("https://oauth2.googleapis.com/token", {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  token.expires_at = Date.now() + token.expires_in * 1000;
  await writeFile(TOKENS_PATH, JSON.stringify(token, null, 2));
  return token;
}

function waitForOauthCode(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>認証完了</h1><p>このタブを閉じて大丈夫です。</p>");
      server.close();
      code ? resolve(code) : reject(new Error("OAuth code を受け取れませんでした。"));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function getAccessToken(config) {
  const token = await ensureYoutubeTokens(config);
  if (Date.now() < token.expires_at - 60000) return token.access_token;
  let refreshed;
  try {
    refreshed = await postForm("https://oauth2.googleapis.com/token", {
      client_id: config.youtube.clientId,
      client_secret: config.youtube.clientSecret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token"
    });
  } catch (error) {
    if (String(error.message).includes("invalid_grant")) {
      await rm(TOKENS_PATH, { force: true });
      throw new Error("YouTube認証が失効しました。npm run auth で再認証してください。");
    }
    throw error;
  }
  const next = { ...token, ...refreshed, expires_at: Date.now() + refreshed.expires_in * 1000 };
  await writeFile(TOKENS_PATH, JSON.stringify(next, null, 2));
  return next.access_token;
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields)
  });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(body.error_description || body.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

async function youtubeGet(config, path, params) {
  const accessToken = await getAccessToken(config);
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(body.error?.message || `YouTube API HTTP ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

function rememberSeenKey(seen, key, limit = 5000) {
  seen.add(key);
  for (const oldKey of seen) {
    if (seen.size <= limit) break;
    seen.delete(oldKey);
  }
}

async function runYoutubeLoop(config) {
  publish({ status: "connecting", replyText: "YouTubeに接続中だよ" });
  const liveChatId = await waitForLiveChatId(config);
  publish({ status: "listening", replyText: "コメント待ってるね" });

  const seen = new Set();
  let pageToken = "";
  while (true) {
    try {
      const body = await youtubeGet(config, "liveChat/messages", {
        liveChatId,
        part: "id,snippet,authorDetails",
        pageToken
      });
      pageToken = body.nextPageToken ?? pageToken;
      const interval = Math.max(body.pollingIntervalMillis ?? config.youtube.pollIntervalMs, config.youtube.pollIntervalMs);
      for (const item of body.items ?? []) {
        if (seen.has(item.id)) continue;
        rememberSeenKey(seen, item.id);
        const text = item.snippet?.displayMessage ?? "";
        const author = item.authorDetails?.displayName ?? "視聴者";
        if (text) enqueueComment(config, { id: item.id, author, text });
      }
      await sleep(interval);
    } catch (error) {
      publish({ status: "error", lastError: error.message, replyText: "接続を確認してるよ" });
      await sleep(15000);
    }
  }
}

function startViewerMonitor(config) {
  if (!config.viewerMonitor?.enabled) return;
  if (!config.youtube?.enabled && !config.youtube?.broadcastId) {
    console.warn("視聴者数モニターは YouTube 設定がないため無効です。");
    return;
  }

  const run = async () => {
    try {
      const count = await fetchConcurrentViewers(config);
      if (!Number.isFinite(count)) return;
      maybeAnnounceViewerIncrease(config, count);
    } catch (error) {
      console.warn(`視聴者数の確認に失敗しました: ${error.message}`);
    }
  };

  run();
  setInterval(run, config.viewerMonitor.pollIntervalMs);
}

async function fetchConcurrentViewers(config) {
  const videoId = await resolveLiveVideoId(config);
  if (!videoId) return null;
  const body = await youtubeGet(config, "videos", {
    id: videoId,
    part: "liveStreamingDetails"
  });
  const raw = body.items?.[0]?.liveStreamingDetails?.concurrentViewers;
  const count = Number(raw);
  return Number.isFinite(count) ? count : null;
}

async function resolveLiveVideoId(config) {
  if (config.youtube?.broadcastId) return config.youtube.broadcastId;
  const body = await youtubeGet(config, "liveBroadcasts", {
    mine: "true",
    broadcastType: "all",
    maxResults: "50",
    part: "id,status"
  });
  const broadcasts = body.items ?? [];
  return (broadcasts.find((item) => item.status?.lifeCycleStatus === "live")
    ?? broadcasts.find((item) => item.status?.lifeCycleStatus === "testing"))?.id ?? "";
}

function maybeAnnounceViewerIncrease(config, count) {
  if (lastViewerCount == null) {
    lastViewerCount = count;
    return;
  }
  const increasedBy = count - lastViewerCount;
  lastViewerCount = count;
  if (increasedBy < config.viewerMonitor.increaseThreshold) return;
  const now = Date.now();
  if (now - lastViewerAnnouncementAt < config.viewerMonitor.cooldownMs) return;
  lastViewerAnnouncementAt = now;
  enqueueSystemReply(config, config.viewerMonitor.message, { id: `viewer-increase:${now}:${count}` });
}

function enqueueSystemReply(config, replyText, options = {}) {
  const {
    commentAuthor = "システム",
    commentText = "視聴者数が増えました",
    preparingText = "呼びかけ準備中だよ...",
    errorText = "呼びかけでエラーが出たよ"
  } = options;
  pendingCommentCount += 1;
  publish({ queueSize: pendingCommentCount });
  commentQueue = commentQueue
    .then(async () => {
      publish({
        status: "thinking",
        commentAuthor,
        commentService: "",
        commentText,
        replyText: preparingText,
        isSpeaking: false,
        lastError: ""
      });
      const resolved = typeof replyText === "function" ? await replyText() : replyText;
      const reply = trimReply(resolved, config.bot.maxReplyChars);
      if (!reply) return;
      await speakReply(config, reply, { cache: typeof replyText !== "function" });
      publish({ status: "listening", isSpeaking: false });
      await sleep(config.bot.cooldownMs);
    })
    .catch((error) => {
      publish({ status: "error", lastError: error.message, replyText: errorText });
    })
    .finally(() => {
      pendingCommentCount = Math.max(0, pendingCommentCount - 1);
      publish({ queueSize: pendingCommentCount });
    });
  return commentQueue;
}

function markActivity() {
  lastActivityAt = Date.now();
  idleTalkStreak = 0;
}

function startIdleTalk(config) {
  if (!config.idleTalk?.enabled) return;
  lastActivityAt = Date.now();
  setInterval(() => {
    maybeSpeakIdleTalk(config).catch((error) => {
      console.warn(`ひとりごとに失敗しました: ${error.message}`);
    });
  }, config.idleTalk.checkIntervalMs);
}

async function maybeSpeakIdleTalk(config) {
  const idle = config.idleTalk;
  if (!idle?.enabled) return;
  if (pendingCommentCount > 0) return;
  const now = Date.now();
  if (now - lastActivityAt < idle.idleMs) return;
  if (now - lastIdleTalkAt < idle.minIntervalMs) return;
  if (idle.maxConsecutive > 0 && idleTalkStreak >= idle.maxConsecutive) return;

  lastIdleTalkAt = now;
  idleTalkStreak += 1;
  const topic = pickIdleTopic(config);
  await enqueueSystemReply(config, () => buildIdleTalkText(config, topic), {
    id: `idle-talk:${now}`,
    commentAuthor: "ひとりごと",
    commentText: topic ? `お題: ${topic}` : "コメント待ち",
    preparingText: "ひとりごと考え中だよ...",
    errorText: "ひとりごとでエラーが出たよ"
  });
  // 次のひとりごとまでの間隔は、しゃべり終わった時点から数える。
  lastIdleTalkAt = Date.now();
}

function pickIdleTopic(config) {
  const topics = config.idleTalk.topics ?? [];
  if (topics.length === 0) return "";
  const fresh = topics.filter((topic) => !recentIdleTalks.some((entry) => entry.topic === topic));
  const pool = fresh.length > 0 ? fresh : topics;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function buildIdleTalkText(config, topic) {
  if (config.idleTalk.useLlm) {
    try {
      const generated = trimReply(await generateIdleTalk(config, topic), config.bot.maxReplyChars);
      if (generated && !isRepeatedIdleTalk(generated) && !isUnsafeReply(config, generated)) {
        rememberIdleTalk(topic, generated);
        return generated;
      }
    } catch (error) {
      console.warn(`ひとりごとの生成に失敗したので固定文にするよ: ${error.message}`);
    }
  }
  const messages = config.idleTalk.messages;
  const fallback = messages[Math.floor(Math.random() * messages.length)];
  rememberIdleTalk(topic, fallback);
  return fallback;
}

async function generateIdleTalk(config, topic) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ollama.timeoutMs);
  try {
    await refreshMarkdownMemoryIfChanged(config);
    // 直前の本文をそのまま渡すとモデルが丸写しすることがあるので、お題だけを避けるように伝える。
    const usedTopics = [...new Set(recentIdleTalks.map((entry) => entry.topic).filter(Boolean))];
    const recent = usedTopics.length > 0
      ? `直前に話したお題です。同じ話題や同じ言い回しを繰り返さないでください。\n${usedTopics.map((entry) => `- ${entry}`).join("\n")}\n`
      : "";
    const topicLine = topic ? `今回のひとりごとのお題: ${topic}` : "";
    const prompt = [
      config.bot.systemPrompt,
      SAFETY_PROMPT,
      formatLongTermMemory(),
      "今はコメントが止まっている時間です。視聴者に向けたひとりごとを1つ話してください。",
      "誰かのコメントへの返事ではないので、お礼や相づちから始めないでください。",
      "日本語で2文から3文くらい、最後は視聴者が返しやすい軽い問いかけで締めてください。",
      "",
      recent,
      topicLine,
      "ひとりごと:"
    ].join("\n");
    return await generateOllamaReply(config, prompt, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function isRepeatedIdleTalk(text) {
  const head = text.slice(0, 24);
  return recentIdleTalks.some((entry) => entry.text === text || (head && entry.text.startsWith(head)));
}

function rememberIdleTalk(topic, text) {
  recentIdleTalks.push({ topic, text });
  if (recentIdleTalks.length > 5) recentIdleTalks.shift();
}

async function runOneCommeLoop(config) {
  const url = config.comments.onecomme.websocketUrl;
  const reconnectIntervalMs = config.comments.onecomme.reconnectIntervalMs;
  publish({ status: "connecting-onecomme", replyText: "コメント待ってるよ", lastError: "" });

  while (true) {
    try {
      await connectOneComme(config, url);
    } catch (error) {
      publish({
        status: "waiting-onecomme",
        lastError: error.message,
        replyText: "コメント待ってるよ"
      });
    }
    await sleep(reconnectIntervalMs);
  }
}

function connectOneComme(config, url) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === "undefined") {
      reject(new Error("このNode.jsではWebSocketが使えません。Node.js 20以上を使ってください。"));
      return;
    }

    const ws = new WebSocket(url);
    const seenKeys = new Set();
    let opened = false;

    ws.addEventListener("open", () => {
      opened = true;
      publish({ status: "listening-onecomme", replyText: "コメント待ってるよ", lastError: "" });
    });

    ws.addEventListener("message", (event) => {
      const allComments = extractOneCommeComments(event.data);
      if (allComments.length === 0) logIgnoredOneCommeEvent(event.data);
      const comments = allComments.filter((comment) => shouldAcceptOneCommeComment(config, comment));
      const targetComments = selectOneCommeCommentsToProcess(comments, seenKeys);
      for (const comment of targetComments) {
        const text = sanitizeCommentText(comment.text);
        if (!text) continue;
        const id = makeCommentProcessKey(comment.id, comment.author, text);
        if (seenKeys.has(id)) continue;
        rememberSeenKey(seenKeys, id);
        enqueueComment(config, {
          id,
          author: comment.author || "視聴者",
          text,
          service: comment.service,
          eventNote: comment.hasGift ? ONECOMME_GIFT_NOTE : ""
        }, { replacePending: true });
      }
    });

    ws.addEventListener("close", () => {
      resolve();
    });

    ws.addEventListener("error", () => {
      if (!opened) reject(new Error(`わんコメに接続できません: ${url}`));
      else resolve();
    });
  });
}

const ONECOMME_GIFT_NOTE = "このコメントはギフト（スーパーチャットなどの投げ銭）付きです。贈ってくれたことに、うれしそうにお礼を言ってください。";

function shouldAcceptOneCommeComment(config, comment) {
  const { services } = config.comments.onecomme;
  if (services.length > 0 && comment.service && !services.includes(comment.service)) return false;
  // TikTok を直接つないでいる時は、わんコメ側の TikTok コメントは二重になるので捨てる。
  if (config.tiktok.enabled && comment.service === "tiktok") return false;
  return true;
}

function selectOneCommeCommentsToProcess(comments, seenKeys) {
  if (comments.length === 0) return [];

  const unseen = [];
  for (const comment of comments) {
    const text = sanitizeCommentText(comment.text);
    if (!text) continue;
    const id = makeCommentProcessKey(comment.id, comment.author, text);
    if (!seenKeys.has(id)) unseen.push({ comment, id });
  }

  // つらい気持ちのコメントは、後から来た別のコメントに押し流されないよう優先する。
  const latest = unseen.find((item) => isDistress(sanitizeCommentText(item.comment.text)))
    ?? pickLatestOneCommeComment(unseen);
  for (const item of unseen) {
    if (item === latest) continue;
    rememberSeenKey(seenKeys, item.id);
  }

  return latest ? [latest.comment] : [];
}

function pickLatestOneCommeComment(items) {
  if (items.length === 0) return null;
  const withTime = items
    .map((item) => ({ item, time: Number(item.comment.timestamp ?? 0) }))
    .filter(({ time }) => Number.isFinite(time) && time > 0);
  if (withTime.length > 0) {
    return withTime.reduce((latest, entry) => entry.time > latest.time ? entry : latest).item;
  }
  return items[0];
}

function enqueueComment(config, comment, { force = false, replacePending = false } = {}) {
  markActivity();
  if (!String(comment.id ?? "").startsWith("startup-last:")) {
    rememberLastComment(config, comment).catch((error) => {
      console.warn(`最後のコメント保存に失敗しました: ${error.message}`);
    });
  }
  if (replacePending && pendingCommentCount > 0) {
    // 待っているのがギフト・フォローやつらい気持ちのコメントなら、普通のコメントでは上書きしない。
    if (!pendingLatestOneCommeComment || !isPriorityComment(pendingLatestOneCommeComment) || isPriorityComment(comment)) {
      pendingLatestOneCommeComment = comment;
    }
    publish({ queueSize: pendingCommentCount + 1 });
    return commentQueue;
  }
  if (!force && pendingCommentCount >= config.bot.maxQueueSize) {
    console.warn(`コメントキューが上限(${config.bot.maxQueueSize})なので捨てました: ${comment.author}: ${comment.text}`);
    return commentQueue;
  }
  pendingCommentCount += 1;
  publish({ queueSize: pendingCommentCount });
  commentQueue = commentQueue
    .then(() => handleComment(config, comment))
    .catch((error) => {
      publish({ status: "error", lastError: error.message, replyText: "コメント処理でエラーが出たよ" });
    })
    .finally(() => {
      pendingCommentCount = Math.max(0, pendingCommentCount - 1);
      publish({ queueSize: pendingCommentCount });
      if (replacePending && pendingLatestOneCommeComment) {
        const latest = pendingLatestOneCommeComment;
        pendingLatestOneCommeComment = null;
        enqueueComment(config, latest, { force: true, replacePending: true });
      }
    });
  return commentQueue;
}

function isPriorityComment(comment) {
  return Boolean(comment.eventNote) || isDistress(sanitizeCommentText(comment.text));
}

async function enqueueLastCommentOnStartup(config) {
  if (!config.bot.replyLastCommentOnStartup) return;
  try {
    const raw = await readFile(LAST_COMMENT_PATH, "utf8");
    const saved = JSON.parse(raw);
    const text = sanitizeCommentText(saved.text);
    if (!text) return;
    const author = sanitizeNickname(saved.author) || "視聴者";
    const key = makeCommentProcessKey(saved.id, author, text);
    recentCommentKeys.set(key, Date.now());
    enqueueComment(config, {
      id: `startup-last:${saved.at ?? "unknown"}:${key}`,
      author,
      text
    }, { force: true });
  } catch {
    // 保存済みコメントが無い初回起動では何もしない。
  }
}

async function rememberLastComment(config, comment) {
  const filtered = filterComment(config, comment.text);
  if (!filtered.ok) return;
  const data = {
    at: new Date().toISOString(),
    id: String(comment.id ?? "").slice(0, 240),
    author: String(comment.author || "視聴者").slice(0, 80),
    text: filtered.text
  };
  await writeFile(LAST_COMMENT_PATH, JSON.stringify(data, null, 2), "utf8");
}

function logIgnoredOneCommeEvent(data) {
  const raw = String(data);
  if (!/(emoji|emote|stamp|sticker|imageUrl|image_url|speechText|commentItems|messageItems)/i.test(raw)) return;
  writeFile(ONECOMME_IGNORED_PATH, raw.slice(0, 20000), "utf8").catch(() => {});
}

function stableCommentKey(author, text) {
  return `${String(author || "").trim()}:${String(text || "").replace(/\s+/g, " ").trim()}`;
}

function makeCommentProcessKey(id, author, text) {
  const bodyKey = stableCommentKey(author, text);
  return id ? `${String(id).trim()}:${bodyKey}` : bodyKey;
}

function isRecentComment(key) {
  const now = Date.now();
  for (const [oldKey, seenAt] of recentCommentKeys) {
    if (now - seenAt > 120000) recentCommentKeys.delete(oldKey);
  }
  if (recentCommentKeys.has(key)) return true;
  recentCommentKeys.set(key, now);
  return false;
}

function extractOneCommeComments(data) {
  const payload = parseOneCommePayload(data);
  if (!payload) return [];

  const candidates = [];
  collectCommentCandidates(payload, candidates, new Set());
  const comments = [];
  const seen = new Set();
  for (const comment of candidates.map(normalizeOneCommeComment)) {
    if (!comment.text) continue;
    const key = makeCommentProcessKey(comment.id, comment.author, comment.text);
    if (seen.has(key)) continue;
    seen.add(key);
    comments.push(comment);
  }
  return comments;
}

function parseOneCommePayload(data) {
  try {
    if (typeof data === "string") return JSON.parse(data);
    if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString("utf8"));
    if (ArrayBuffer.isView(data)) {
      return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
    }
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function collectCommentCandidates(value, out, seen) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectCommentCandidates(item, out, seen);
    return;
  }

  if (isOneCommeCommentObject(value)) {
    out.push(value);
    return;
  }

  if (isOneCommeCommentObject(value.comment)) {
    out.push(value.comment);
    return;
  }

  const bodyText = extractOneCommeCommentBody(value.comment)
    || extractCommentText(value.comment)
    || extractCommentText(value.message)
    || extractCommentText(value.text)
    || extractCommentText(value.displayMessage)
    || extractCommentText(value.body)
    || extractCommentText(value.content)
    || extractCommentText(value.commentItems)
    || extractCommentText(value.messageItems)
    || extractCommentText(value.segments)
    || extractCommentText(value.runs)
    || extractCommentText(value.parts);
  const hasBody = bodyText.length > 0;
  const hasCommentId = Boolean(value.id || value.commentId || value.messageId || value.data?.id || value.data?.commentId || value.data?.messageId);
  const hasAuthor = Boolean(extractOneCommeAuthor(value));
  const looksLikeComment = hasBody && !isOneCommeSystemEvent(value) && (
    hasAuthor
    || hasCommentId
    || value.comment
    || value.message
    || value.displayMessage
    || value.body
    || value.content
    || value.commentItems
    || value.messageItems
  );

  if (looksLikeComment) {
    out.push(value);
  }

  for (const child of Object.values(value)) {
    collectCommentCandidates(child, out, seen);
  }
}

function normalizeOneCommeComment(item) {
  const data = item?.data && typeof item.data === "object" ? item.data : {};
  const text = extractOneCommeCommentBody(item)
    || extractCommentText(item.comment ?? item.message ?? item.text ?? item.displayMessage ?? item.body ?? item.content ?? "")
    || extractCommentText(item.commentItems ?? item.messageItems ?? item.segments ?? item.runs ?? item.parts ?? "")
    || extractNestedCommentText(item);
  const author = extractOneCommeAuthor(item) || "視聴者";
  const id = item.id
    ?? item.commentId
    ?? item.messageId
    ?? data.id
    ?? data.commentId
    ?? data.messageId
    ?? data.comment?.id
    ?? data.message?.id;
  const timestamp = extractOneCommeTimestamp(item);
  const service = String(item.service ?? data.service ?? "").trim().toLowerCase();
  const hasGift = Boolean(data.hasGift ?? item.hasGift);
  return { id: String(id ?? ""), author: String(author), text, timestamp, service, hasGift };
}

function extractOneCommeTimestamp(item) {
  const data = item?.data && typeof item.data === "object" ? item.data : {};
  const candidates = [
    item?.timestamp,
    item?.createdAt,
    item?.updatedAt,
    item?.postedAt,
    item?.publishedAt,
    item?.time,
    item?.date,
    data.timestamp,
    data.createdAt,
    data.updatedAt,
    data.postedAt,
    data.publishedAt,
    data.time,
    data.date,
    data.comment?.timestamp,
    data.comment?.createdAt,
    data.comment?.publishedAt,
    data.message?.timestamp,
    data.message?.createdAt,
    data.message?.publishedAt
  ];
  for (const value of candidates) {
    const timestamp = normalizeTimestamp(value);
    if (timestamp > 0) return timestamp;
  }
  return 0;
}

function normalizeTimestamp(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") {
    return value < 10000000000 ? value * 1000 : value;
  }
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);
    return number < 10000000000 ? number * 1000 : number;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isOneCommeCommentObject(value) {
  if (!value || typeof value !== "object") return false;
  const data = value.data;
  return Boolean(data && typeof data === "object" && (
    hasCommentText(data.comment)
    || hasCommentText(data.speechText)
    || hasCommentText(data.message)
    || hasCommentText(data.text)
    || hasCommentText(data.displayMessage)
    || hasCommentText(data.body)
    || hasCommentText(data.content)
    || hasCommentText(data.commentItems)
    || hasCommentText(data.messageItems)
    || hasCommentText(data.segments)
    || hasCommentText(data.runs)
    || hasCommentText(data.parts)
  ));
}

function extractOneCommeCommentBody(item) {
  const data = item?.data;
  if (!data || typeof data !== "object") return "";
  return extractCommentText(data.speechText)
    || extractCommentText(data.comment)
    || extractCommentText(data.message)
    || extractCommentText(data.text)
    || extractCommentText(data.displayMessage)
    || extractCommentText(data.body)
    || extractCommentText(data.content)
    || extractCommentText(data.commentItems)
    || extractCommentText(data.messageItems)
    || extractCommentText(data.segments)
    || extractCommentText(data.runs)
    || extractCommentText(data.parts)
    || extractCommentText(data.commentData)
    || extractCommentText(data.messageData);
}

function extractOneCommeAuthor(item) {
  const data = item?.data && typeof item.data === "object" ? item.data : {};
  const author = firstString(
    data.displayName,
    data.name,
    data.userName,
    data.nickname,
    data.user?.name,
    data.user?.displayName,
    data.user?.nickname,
    data.author?.name,
    data.author?.displayName,
    data.profile?.name,
    data.profile?.displayName,
    data.sender?.name,
    data.sender?.displayName,
    data.member?.name,
    data.member?.displayName,
    item?.user?.name,
    item?.user?.displayName,
    item?.author?.name,
    item?.author?.displayName,
    item?.profile?.name,
    item?.profile?.displayName,
    item?.name,
    item?.displayName,
    item?.userName
  );
  return isReservedOneCommeName(author) ? "" : author;
}

function isReservedOneCommeName(value) {
  return /^(meta|connect|connected|connection|system|event|status|service)$/i.test(String(value ?? "").trim());
}

function hasCommentText(value) {
  return extractCommentText(value).length > 0;
}

function extractCommentText(value) {
  if (value == null) return "";
  if (typeof value === "string") return cleanCommentString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map(extractCommentText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (typeof value !== "object") return "";

  const directText = firstString(
    value.text,
    value.message,
    value.comment,
    value.displayText,
    value.displayMessage,
    value.content,
    value.body,
    value.alt,
    value.altText,
    value.emojiText,
    value.emojiName,
    value.name,
    value.title,
    value.label,
    value.shortcut,
    value.shortcode
  );
  if (directText) return directText.trim();

  const emojiText = firstString(
    value.emoji?.alt,
    value.emoji?.name,
    value.emoji?.title,
    value.stamp?.alt,
    value.stamp?.name,
    value.stamp?.title,
    value.emote?.alt,
    value.emote?.name,
    value.emote?.title,
    value.reaction?.alt,
    value.reaction?.name
  );
  if (emojiText) return emojiText.trim();

  const nestedText = extractCommentText(value.runs ?? value.parts ?? value.fragments ?? value.tokens ?? value.elements);
  if (nestedText) return nestedText;

  if (looksLikeEmojiPart(value)) return "絵文字";
  return "";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && cleanCommentString(value)) return cleanCommentString(value);
  }
  return "";
}

function cleanCommentString(value) {
  return String(value)
    .replace(/<img\b[^>]*(?:alt|title)=["']([^"']+)["'][^>]*>/gi, " $1 ")
    .replace(/<img\b[^>]*>/gi, " 絵文字 ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNestedCommentText(value) {
  if (!value || typeof value !== "object") return "";
  const skip = new Set([
    "id",
    "commentId",
    "messageId",
    "name",
    "displayName",
    "userName",
    "author",
    "user",
    "timestamp",
    "createdAt",
    "updatedAt",
    "platform",
    "service",
    "meta",
    "event",
    "status",
    "type",
    "kind",
    "connection",
    "connected",
    "channel",
    "avatar",
    "avatarUrl",
    "profileImageUrl",
    "profile_image_url",
    "thumbnail",
    "thumbnailUrl",
    "thumbnail_url",
    "imageUrl",
    "image_url",
    "url"
  ]);
  return Object.entries(value)
    .filter(([key]) => !skip.has(key))
    .map(([, child]) => extractCommentText(child))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeEmojiPart(value) {
  if (!value || typeof value !== "object") return false;
  const type = String(value.type ?? value.kind ?? value.role ?? "").toLowerCase();
  if (/emoji|emote|stamp|sticker|image/.test(type)) return true;
  return Boolean(
    value.url
    || value.imageUrl
    || value.image_url
    || value.thumbnailUrl
    || value.thumbnail_url
    || value.emoji
    || value.emote
    || value.stamp
    || value.sticker
  );
}

function isOneCommeSystemEvent(value) {
  const marker = firstString(value?.type, value?.event, value?.status, value?.name, value?.displayName);
  return isReservedOneCommeName(marker);
}

async function waitForLiveChatId(config) {
  while (true) {
    try {
      return await resolveLiveChatId(config);
    } catch (error) {
      publish({
        status: "waiting-youtube",
        lastError: error.message,
        replyText: "YouTube配信を待ってるよ"
      });
      await sleep(15000);
    }
  }
}

async function resolveLiveChatId(config) {
  if (config.youtube.broadcastId) {
    const body = await youtubeGet(config, "videos", {
      id: config.youtube.broadcastId,
      part: "liveStreamingDetails"
    });
    const id = body.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (id) return id;
    throw new Error("broadcastId から activeLiveChatId を取得できませんでした。配信中か確認してください。");
  }

  const body = await youtubeGet(config, "liveBroadcasts", {
    mine: "true",
    broadcastType: "all",
    maxResults: "50",
    part: "snippet,status"
  });
  const broadcasts = body.items ?? [];
  const live = broadcasts.find((item) => item.status?.lifeCycleStatus === "live");
  const testing = broadcasts.find((item) => item.status?.lifeCycleStatus === "testing");
  const id = (live ?? testing)?.snippet?.liveChatId;
  if (id) return id;
  throw new Error("有効な自分のライブ配信が見つかりません。配信を開始するか broadcastId を設定してください。");
}

async function handleComment(config, comment) {
  const filtered = filterComment(config, comment.text);
  if (!filtered.ok) {
    if (filtered.distress) return handleDistressComment(config, comment);
    if (filtered.reason) console.warn(`[安全フィルター] コメントをスルーしたよ: ${filtered.reason}`);
    return;
  }
  const filteredKey = comment.id || stableCommentKey(comment.author, filtered.text);
  if (isRecentComment(filteredKey)) return;

  publish({
    status: "thinking",
    commentAuthor: comment.author,
    commentService: platformLabel(comment.service),
    commentText: filtered.text,
    replyText: "考え中だよ...",
    isSpeaking: false,
    lastError: ""
  });

  // System One（即答）で済むものはすぐ返し、考える必要があるものだけ System Two（LLM）へ回す。
  const timing = { startedAt: performance.now(), firstAudioAt: 0 };
  const decision = systemOne.decide(filtered.text);
  // ギフトやフォローはお礼を言ってほしいので、即答や定型文に回さず必ず LLM に考えさせる。
  let route = comment.eventNote ? "system-two" : decision.route;
  let reply = "";
  try {
    const canned = comment.eventNote ? undefined : makeCannedReply(filtered.text);
    const toolReply = canned || comment.eventNote ? undefined : await makeToolReply(config, filtered.text);
    if (canned || toolReply) {
      route = canned ? "canned" : "tool";
      // 定型文は trimReply を通すと「どんぐりこだよ。」が自己紹介除去で消えてしまうのでそのまま使う。
      reply = canned ?? trimReply(toolReply, config.bot.maxReplyChars);
      await speakReply(config, reply, { cache: Boolean(canned), timing });
    } else if (route === "system-one") {
      reply = systemOne.pickReply(decision.intent.choice);
      await speakReply(config, reply, { cache: true, timing });
    } else if (config.ollama.stream) {
      const filler = startFiller(config, decision, timing);
      reply = await speakSegments(config, streamReplySegments(config, comment.author, filtered.text, comment), { before: filler, timing });
    } else {
      reply = trimReply(await askOllama(config, comment.author, filtered.text, comment), config.bot.maxReplyChars);
      const unsafe = isUnsafeReply(config, reply);
      if (unsafe) reply = SAFE_REPLY;
      await speakReply(config, reply, { cache: unsafe, timing });
    }
  } catch (error) {
    reply = ERROR_REPLY;
    publish({ lastError: error.message });
    await speakReply(config, reply, { cache: true, timing });
  }
  reportLatency(route, decision, timing);
  await rememberTurn(config, { author: comment.author, text: filtered.text }, reply);

  publish({ status: "listening", isSpeaking: false });
  await sleep(config.bot.cooldownMs);
}

// 「死にたい」などのコメントには、LLMを通さず決まった言葉で寄り添う。
// 本文と名前は画面に出さず、記憶にも残さない。配信者が直接声をかけられるようにコンソールで知らせる。
// 連投で何度も読ませる荒らし対策として、同じ人には10分に1回、全体でも1分に1回までにする。
const DISTRESS_AUTHOR_COOLDOWN_MS = 10 * 60 * 1000;
const DISTRESS_GLOBAL_COOLDOWN_MS = 60 * 1000;
const distressRepliedAt = new Map();
let lastDistressReplyAt = 0;

async function handleDistressComment(config, comment) {
  const author = String(comment.author || "視聴者");
  if (isRecentComment(comment.id || stableCommentKey(author, comment.text))) return;
  console.warn(`\n[要確認] つらい気持ちのコメントが来たよ。できれば配信者から直接声をかけてあげてね。\n  ${author}: ${sanitizeCommentText(comment.text)}\n`);
  const now = Date.now();
  if (now - lastDistressReplyAt < DISTRESS_GLOBAL_COOLDOWN_MS) return;
  if (now - (distressRepliedAt.get(author) ?? 0) < DISTRESS_AUTHOR_COOLDOWN_MS) return;
  lastDistressReplyAt = now;
  distressRepliedAt.set(author, now);

  publish({ status: "thinking", commentAuthor: "", commentService: "", commentText: "", replyText: "", isSpeaking: false, lastError: "" });
  await speakReply(config, config.bot.distressReply, { cache: true });
  publish({ status: "listening", isSpeaking: false });
  await sleep(config.bot.cooldownMs);
}

function reportLatency(route, decision, timing) {
  const now = performance.now();
  const latency = {
    route,
    intent: decision.intent.choice,
    confidence: decision.intent.confidence,
    needsThinking: decision.needsThinking.probability,
    decideMs: decision.ms,
    firstAudioMs: timing.firstAudioAt ? Math.round(timing.firstAudioAt - timing.startedAt) : null,
    totalMs: Math.round(now - timing.startedAt)
  };
  publish({ lastLatency: latency });
  console.log(
    `[返答速度] ${route} (${latency.intent} ${latency.confidence}, 考える必要 ${latency.needsThinking})`
    + ` 判定 ${latency.decideMs}ms / 声が出るまで ${latency.firstAudioMs ?? "-"}ms / 全体 ${latency.totalMs}ms`
  );
}

async function speakReply(config, reply, { cache = false, timing } = {}) {
  return speakSegments(config, [reply], { cache, timing });
}

// 文ごとに「音声合成」と「再生」を並行させる。1文目を話している間に2文目を合成しておく。
async function speakSegments(config, segments, { cache = false, before, timing } = {}) {
  const ready = createAsyncQueue();
  const producer = (async () => {
    try {
      for await (const text of segments) {
        if (!text) continue;
        try {
          ready.push({ text, wavPath: await synthesizeForSpeech(config, text, { cache }) });
        } catch (error) {
          publish({ lastError: error.message });
          ready.push({ text, wavPath: "" });
        }
      }
    } catch (error) {
      publish({ lastError: error.message });
    } finally {
      ready.close();
    }
  })();

  // 相づち（フィラー）を流している間も、裏では返事の生成と合成が進んでいる。
  if (before) await before;
  let spoken = "";
  for await (const item of ready) {
    spoken += item.text;
    if (item.wavPath) {
      await playSegment(config, item.wavPath, spoken, timing);
    } else {
      markFirstAudio(timing);
      publish({ status: "speaking", replyText: spoken, isSpeaking: true });
    }
  }
  await producer;
  return spoken;
}

async function playSegment(config, wavPath, displayText, timing) {
  const lipSync = await readWavLipSync(wavPath);
  const useBrowserAudio = config.audio.playInBrowser && clients.size > 0;
  currentAudioPath = wavPath;
  const publishSpeaking = () => {
    markFirstAudio(timing);
    publish({
      status: "speaking",
      replyText: displayText,
      isSpeaking: true,
      audioToken: `${Date.now()}-${++audioTokenCounter}`,
      audioMs: lipSync.durationMs,
      // ブラウザで再生するときは再生中の音量から口を動かすので包絡線は送らない
      mouthEnvelope: useBrowserAudio ? [] : lipSync.envelope,
      mouthFrameMs: useBrowserAudio ? 0 : lipSync.frameMs,
      lipSyncOffsetMs: useBrowserAudio ? 0 : config.audio.lipSyncOffsetMs
    });
  };
  if (useBrowserAudio) {
    publishSpeaking();
    await sleep((lipSync.durationMs || 2500) + 300);
  } else if (config.audio.playGeneratedAudio) {
    await playWav(config, wavPath, { onStart: publishSpeaking, durationMs: lipSync.durationMs });
  } else {
    publishSpeaking();
  }
}

function markFirstAudio(timing) {
  if (timing && !timing.firstAudioAt) timing.firstAudioAt = performance.now();
}

// LLM に考えてもらっている間に、キャッシュ済みの短い相づちを先に流す。
function startFiller(config, decision, timing) {
  if (!config.systemOne.enabled || !config.systemOne.filler) return null;
  const filler = systemOne.pickFiller(decision, (text) => existsSync(ttsCachePath(config, text)));
  if (!filler) return null;
  return playSegment(config, ttsCachePath(config, filler), filler, timing).catch((error) => {
    publish({ lastError: error.message });
  });
}

function createAsyncQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    push(item) {
      if (waiters.length > 0) waiters.shift()({ value: item, done: false });
      else items.push(item);
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        }
      };
    }
  };
}

function startSpeedBoosters(config) {
  if (config.audio.playGeneratedAudio && config.audio.persistentPlayer && process.platform === "win32") {
    wavPlayer = createWavPlayer();
    wavPlayer.warm();
  }
  warmUpOllama(config).catch(() => {});
  if (config.systemOne.enabled && config.systemOne.prewarmAudio) {
    prewarmTtsCache(config).catch((error) => console.warn(`即答用音声の準備に失敗しました: ${error.message}`));
  }
}

// 起動直後にモデルをメモリへ載せ、共通のプロンプト部分を計算済みにしておく（初回コメントの待ち時間を消す）。
async function warmUpOllama(config) {
  if (!config.ollama.warmUp) return;
  const started = performance.now();
  try {
    const { prompt } = await buildReplyPrompts(config, "", "こんにちは");
    await generateOllamaReply(config, prompt, AbortSignal.timeout(config.ollama.timeoutMs), { numPredict: 1 });
    console.log(`[System Two] モデルの準備ができたよ (${Math.round(performance.now() - started)}ms)`);
  } catch (error) {
    console.warn(`[System Two] モデルの事前読み込みに失敗しました: ${error.message}`);
  }
}

// 即答・相づち・定型文の音声を先に合成してディスクに保存しておく。コメント処理中は合成しない。
async function prewarmTtsCache(config, { quiet = true } = {}) {
  const phrases = [...new Set([
    ...systemOne.allPhrases(),
    NAME_REPLY,
    MODEL_REPLY,
    ERROR_REPLY,
    EMPTY_REPLY,
    SAFE_REPLY,
    config.bot.distressReply,
    config.viewerMonitor.message,
    ...config.idleTalk.messages
  ].filter(Boolean))];
  const missing = phrases.filter((text) => !existsSync(ttsCachePath(config, text)));
  if (missing.length === 0) {
    console.log(`[System One] 即答用の音声 ${phrases.length}件はすべて準備済みだよ`);
    return;
  }
  console.log(`[System One] 即答用の音声を${missing.length}件つくるよ（コメントが無い間に少しずつ）`);
  let done = 0;
  let warned = false;
  for (const text of missing) {
    while (true) {
      while (pendingCommentCount > 0) await sleep(500);
      try {
        await synthesizeForSpeech(config, text, { cache: true });
        done += 1;
        if (!quiet) console.log(`  ${done}/${missing.length} ${text}`);
        break;
      } catch (error) {
        if (!quiet) throw error;
        if (!warned) console.warn(`[System One] 音声エンジンが応答しないので、あとでもう一度つくるよ: ${error.message}`);
        warned = true;
        await sleep(30000);
      }
    }
  }
  console.log(`[System One] 即答用の音声 ${done}件の準備ができたよ`);
}

function ttsCachePath(config, text) {
  const { timeoutMs: _timeoutMs, endpoint: _endpoint, ...voice } = config.tts ?? config.voicevox ?? {};
  const key = createHash("sha1").update(JSON.stringify({ voice, text: sanitizeTtsText(text) })).digest("hex");
  return join(TTS_CACHE_DIR, `${key}.wav`);
}

// キャッシュがあれば合成を省く。cache=true の時だけ新しく作った音声をキャッシュへ保存する。
async function synthesizeForSpeech(config, text, { cache = false } = {}) {
  const cachePath = ttsCachePath(config, text);
  if (existsSync(cachePath)) return cachePath;
  if (!cache) {
    const segmentPath = join(TTS_SEGMENT_DIR, `segment-${ttsSegmentCounter++ % TTS_SEGMENT_SLOTS}.wav`);
    return synthesizeVoice(config, text, segmentPath);
  }
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  await synthesizeVoice(config, text, tmpPath);
  await rename(tmpPath, cachePath);
  return cachePath;
}

function makeCannedReply(text) {
  const normalized = text.toLowerCase();
  const asksName = /(あなた|きみ|君|お前|おまえ)の(お?)(名前|なまえ)|お名前は|(名前|なまえ)(を)?(教えて|おしえて)|何て呼べば|なんて呼べば|who are you|your name/.test(normalized)
    || /^お?(名前|なまえ)(は|を)?[?？!！。]*$/.test(normalized);
  if (asksName) {
    return NAME_REPLY;
  }

  const asksModel = /aiモデル|(言語|生成)モデル|llm|ollama|gemma|gpt|生成ai|(どの|どんな|何の|なんの)(ai|モデル)|モデル(は|を)?(何|なに|どれ|教えて)|(何|なに)を使って(る|いる|喋って|しゃべって)/.test(normalized);
  if (asksModel) {
    return MODEL_REPLY;
  }

  return undefined;
}

async function makeToolReply(config, text) {
  if (isTimeQuestion(text)) return makeTimeReply(config);
  if (isWeatherQuestion(text)) return await makeWeatherReply(config);
  return undefined;
}

function isTimeQuestion(text) {
  return /(今何時|いま何時|何時|現在時刻|今の時刻|時間教えて|時刻教えて|time)/i.test(String(text ?? ""));
}

function isWeatherQuestion(text) {
  return /(天気|気温|気象|雨降|雨ふ|降ってる|暑い|寒い|風強|weather)/i.test(String(text ?? ""));
}

function makeTimeReply(config) {
  if (!config.tools?.time?.enabled) return undefined;
  const timeZone = config.tools.time.timeZone;
  const label = config.tools.time.label || timeZone;
  const now = new Date();
  const time = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(now);
  return `今の${label}の時刻は${time}だよ。時間確認えらい、どんぐりこもちょっと助かったかも。`;
}

async function makeWeatherReply(config) {
  const weather = config.tools?.weather;
  if (!weather?.enabled) return undefined;
  const now = Date.now();
  if (weatherCache.reply && now - weatherCache.at < weather.cacheMs) return weatherCache.reply;

  try {
    const params = new URLSearchParams({
      latitude: String(weather.latitude),
      longitude: String(weather.longitude),
      current: "temperature_2m,precipitation,weather_code,wind_speed_10m",
      timezone: weather.timeZone
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) throw new Error(`Weather HTTP ${res.status}`);
    const body = await res.json();
    const current = body.current ?? {};
    const temp = Number(current.temperature_2m);
    const precipitation = Number(current.precipitation ?? 0);
    const wind = Number(current.wind_speed_10m);
    const code = Number(current.weather_code);
    const place = weather.locationName || "設定地点";
    const condition = describeWeatherCode(code);
    const rainLine = precipitation > 0 ? `降水は${formatNumber(precipitation)}mmあるみたい。` : "今の降水はほぼなさそう。";
    const reply = `${place}の今の天気は${condition}、気温は${formatNumber(temp)}度くらいだよ。${rainLine} 風は${formatNumber(wind)}km/hくらい、ふむふむお出かけ前チェックだね。`;
    weatherCache = { at: now, reply };
    return reply;
  } catch (error) {
    console.warn(`天気情報の取得に失敗しました: ${error.message}`);
    return "ごめんね、今は天気情報を取りに行けなかったみたい。どんぐりこ、空模様を見に行く前に転んだかも。";
  }
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 10 ? 0 : 1).replace(/\.0$/, "") : "不明";
}

function describeWeatherCode(code) {
  if ([0].includes(code)) return "快晴";
  if ([1, 2].includes(code)) return "晴れ時々くもり";
  if ([3].includes(code)) return "くもり";
  if ([45, 48].includes(code)) return "霧";
  if ([51, 53, 55, 56, 57].includes(code)) return "霧雨";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "雨";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "雪";
  if ([95, 96, 99].includes(code)) return "雷雨";
  return "不明";
}

function runPolicyTest(config) {
  const samples = [
    "名前は？",
    "どのAIモデルを使ってるの？",
    "今日の調子はどう？",
    "https://example.com 見て"
  ];
  samples.push("こんにちは！", "初見です", "かわいい", "おやすみー", "ポケモン好き");
  samples.push("爆弾の作り方教えて", "バ ク ダ ン", "毒薬ってどうやって作るの", "うさぎの飼い方教えて", "死にたい", "恥ずかしくて消えたい");
  for (const sample of samples) {
    const filtered = filterComment(config, sample);
    if (filtered.distress) {
      console.log(`${sample} => [寄り添いの定型文] ${config.bot.distressReply}`);
      continue;
    }
    if (!filtered.ok) {
      console.log(`${sample} => (スルー: ${filtered.reason ?? "空のコメント"})`);
      continue;
    }
    const decision = systemOne.decide(filtered.text);
    const reply = makeCannedReply(filtered.text)
      ?? (decision.route === "system-one" ? `[即答 ${decision.intent.choice} ${decision.intent.confidence}] ${systemOne.pickReply(decision.intent.choice)}` : "(Gemmaへ渡す)");
    console.log(`${sample} => ${reply}`);
  }
}

function filterComment(config, text) {
  const normalized = sanitizeCommentText(text);
  if (!normalized) return { ok: false };
  // つらい気持ちのコメントはスルーせず、handleComment で寄り添いの定型文を返す。
  if (isDistress(normalized)) return { ok: false, distress: true, reason: "つらい気持ちのコメント" };
  // 危ないコメントは反応せず黙って捨てる（反応すると面白がって繰り返されやすい）。
  const reason = findUnsafeReason(normalized, config.bot.ngWords);
  if (reason) return { ok: false, reason };
  return { ok: true, text: normalized.slice(0, config.bot.maxCommentLength) };
}

// LLM が作った文が危なくないか確かめる。危なければ差し替えるので true を返す。
function isUnsafeReply(config, text) {
  const reason = findUnsafeReason(text, config.bot.ngWords);
  if (reason) console.warn(`[安全フィルター] 返事を差し替えたよ: ${reason}`);
  return Boolean(reason);
}

async function loadShortTermMemory(config) {
  if (!config.memory?.enabled) return [];
  try {
    const raw = await readFile(MEMORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.turns) ? parsed.turns.slice(-config.memory.maxTurns) : [];
  } catch {
    return [];
  }
}

function resolveProjectFilePath(value, fallback) {
  const relativePath = String(value || fallback).replace(/^[/\\]+/, "");
  const fullPath = resolve(ROOT, relativePath);
  if (!fullPath.toLowerCase().startsWith(ROOT.toLowerCase() + sep.toLowerCase()) && fullPath.toLowerCase() !== ROOT.toLowerCase()) {
    throw new Error(`Project memory path is outside the project: ${relativePath}`);
  }
  return fullPath;
}

async function loadMarkdownMemory(config) {
  if (!config.memory?.enabled || !config.memory.markdown?.enabled) return "";
  const memoryPath = resolveProjectFilePath(config.memory.markdown.path, DEFAULT_MARKDOWN_MEMORY_PATH);
  try {
    const fileStat = await stat(memoryPath);
    const raw = await readFile(memoryPath, "utf8");
    const trimmed = raw.trim();
    longTermMemoryMtimeMs = fileStat.mtimeMs;
    if (!trimmed) return "";
    const maxChars = config.memory.markdown.maxChars;
    return maxChars > 0 ? trimmed.slice(0, maxChars) : trimmed;
  } catch (error) {
    console.warn(`Markdown記憶を読み込めませんでした: ${error.message}`);
    return "";
  }
}

async function refreshMarkdownMemoryIfChanged(config) {
  if (!config.memory?.enabled || !config.memory.markdown?.enabled || !config.memory.markdown.reloadOnChange) return;
  const memoryPath = resolveProjectFilePath(config.memory.markdown.path, DEFAULT_MARKDOWN_MEMORY_PATH);
  try {
    const fileStat = await stat(memoryPath);
    if (fileStat.mtimeMs <= longTermMemoryMtimeMs) return;
    longTermMemoryText = await loadMarkdownMemory(config);
    console.log(`Markdown記憶を再読み込みしました: ${config.memory.markdown.path}`);
  } catch (error) {
    console.warn(`Markdown記憶の更新確認に失敗しました: ${error.message}`);
  }
}

async function rememberTurn(config, comment, reply) {
  if (!config.memory?.enabled) return;
  const turn = {
    at: new Date().toISOString(),
    author: String(comment.author ?? "").slice(0, 40),
    comment: String(comment.text ?? "").slice(0, config.bot.maxCommentLength),
    reply: String(reply ?? "").slice(0, config.bot.maxReplyChars)
  };

  if (config.memory.maxTurns > 0) {
    shortTermMemory.push(turn);
    shortTermMemory = shortTermMemory.slice(-config.memory.maxTurns);
    try {
      await writeFile(MEMORY_PATH, JSON.stringify({ turns: shortTermMemory }, null, 2), "utf8");
    } catch (error) {
      console.warn(`短期記憶の保存に失敗しました: ${error.message}`);
    }
  }

  if (config.memory.interactionLog?.enabled) {
    await appendInteractionMemoryLog(config, turn);
  }
}

async function appendInteractionMemoryLog(config, turn) {
  const logPath = resolveProjectFilePath(config.memory.interactionLog.path, DEFAULT_MEMORY_INBOX_PATH);
  const date = new Date(turn.at);
  const stamp = Number.isNaN(date.getTime()) ? turn.at : date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const cleanAuthor = String(turn.author || "視聴者").replace(/\r?\n/g, " ").trim();
  const cleanComment = String(turn.comment || "").replace(/\r?\n/g, " ").trim();
  const cleanReply = String(turn.reply || "").replace(/\r?\n/g, " ").trim();
  const entry = [
    "",
    `## ${stamp}`,
    "",
    `- 視聴者: ${cleanAuthor}`,
    `- コメント: ${cleanComment}`,
    `- Donguriko: ${cleanReply}`,
    "- 学び候補:",
    ""
  ].join("\n");
  try {
    await appendFile(logPath, entry, "utf8");
  } catch (error) {
    console.warn(`やり取りログの追記に失敗しました: ${error.message}`);
  }
}

function hasContextReference(text) {
  return /(さっき|前の|それ|これ|あれ|続き|今の|その話|その件|さきほど|先ほど|さっきの|今言った|前言った|どういうこと|なんで|なぜ|どれ)/.test(String(text ?? ""));
}

function formatLongTermMemory() {
  if (!longTermMemoryText) return "";
  return [
    "Dongurikoの長期記憶メモです。性格、好み、配信方針の参考として必要な部分だけ自然に反映してください。",
    "メモの文章をそのままコピーせず、今回のコメントに関係する内容だけを使ってください。",
    "同じ言葉、同じ語尾、同じ口癖を繰り返さないでください。",
    "ただし、メモを読んだことやファイル名は返答に出さないでください。",
    longTermMemoryText,
    ""
  ].join("\n");
}

function formatShortTermMemory(config, author, currentText) {
  if (!config.memory?.enabled || shortTermMemory.length === 0) return "";
  const nickname = sanitizeNickname(author);
  const wantsContext = hasContextReference(currentText);
  const relevantTurns = shortTermMemory
    .filter((turn) => wantsContext || sanitizeNickname(turn.author) === nickname)
    .slice(-Math.min(config.memory.maxTurns, wantsContext ? 3 : 1));
  if (relevantTurns.length === 0) return "";
  const lines = shortTermMemory
    .filter((turn) => relevantTurns.includes(turn))
    .map((turn) => `- ${turn.author}: ${turn.comment}\n  どんぐりこ: ${turn.reply}`)
    .join("\n");
  return `必要な時だけ使う会話メモです。今回のコメントを最優先し、明確につながる時以外は前の話題を持ち出さないでください。\n${lines}\n\n`;
}

function sanitizeNickname(author) {
  return String(author ?? "")
    .replace(/\s+/g, " ")
    .replace(/[：:]/g, "")
    .trim()
    .slice(0, 40);
}

// 毎回変わらない部分（システムプロンプト・長期記憶）を先頭に置くと、Ollama が前回の計算を再利用できる。
const PLATFORM_LABELS = {
  youtube: "YouTube",
  tiktok: "TikTok",
  twitch: "Twitch",
  niconama: "ニコ生",
  twicas: "ツイキャス",
  showroom: "SHOWROOM",
  mirrativ: "ミラティブ"
};

function platformLabel(service) {
  if (!service) return "";
  return PLATFORM_LABELS[service] ?? service;
}

async function buildReplyPrompts(config, author, text, { service = "", eventNote = "" } = {}) {
  await refreshMarkdownMemoryIfChanged(config);
  const longTermMemoryPrompt = formatLongTermMemory();
  const memoryPrompt = formatShortTermMemory(config, author, text);
  const nickname = sanitizeNickname(author);
  const platform = platformLabel(service);
  const nicknameLine = nickname ? `ニックネーム: ${nickname}${platform ? `（${platform}の視聴者）` : ""}\n` : "";
  const eventLine = eventNote ? `${eventNote}\n` : "";
  const innerPrompt = buildInnerReactionPrompt();
  return {
    prompt: `${config.bot.systemPrompt}\n${SAFETY_PROMPT}\n${longTermMemoryPrompt}\n${innerPrompt}\n今回のコメントだけに自然に返してください。直前の話題は、コメントが明確に続きだと分かる時だけ使ってください。絵文字だけ、相づちだけ、定型文だけで終わらず、コメント内容に具体的に反応してください。\n\n${memoryPrompt}${nicknameLine}${eventLine}コメント: ${text}\n返答:`,
    retryPrompt: `${config.bot.systemPrompt}\n${SAFETY_PROMPT}\n${longTermMemoryPrompt}\n${innerPrompt}\n次のコメントに日本語で2文から4文くらいで具体的に返してください。定型文だけで終わらず、コメント内容に触れてください。\nコメント: ${text}\n返答:`
  };
}

async function askOllama(config, author, text, commentInfo) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ollama.timeoutMs);
  try {
    const { prompt, retryPrompt } = await buildReplyPrompts(config, author, text, commentInfo);
    const response = await generateOllamaReply(config, prompt, controller.signal);
    if (response.trim()) return response;
    return await generateOllamaReply(config, retryPrompt, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

// LLM の返事を1文ずつ取り出す。全文が出来上がるのを待たずに、1文目から音声合成へ回せる。
async function* streamReplySegments(config, author, text, commentInfo) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ollama.timeoutMs);
  const cleaner = createReplyCleaner(config.bot.maxReplyChars);
  let emitted = 0;
  try {
    const { prompt, retryPrompt } = await buildReplyPrompts(config, author, text, commentInfo);
    let blocked = false;
    for await (const sentence of streamOllamaSentences(config, prompt, controller.signal)) {
      const cleaned = cleaner.push(sentence);
      if (cleaned && isUnsafeReply(config, cleaned)) {
        // 危ない文が出たら、その文は読まずに断りの一言に差し替えて、残りも捨てる。
        blocked = true;
        emitted += 1;
        yield SAFE_REPLY;
        break;
      }
      if (cleaned) {
        emitted += 1;
        yield cleaned;
      }
      if (cleaner.full) break;
    }
    if (emitted === 0 && !blocked) {
      const retry = await generateOllamaReply(config, retryPrompt, controller.signal);
      for (const sentence of splitSentences(retry)) {
        const cleaned = cleaner.push(sentence);
        if (cleaned && isUnsafeReply(config, cleaned)) {
          emitted += 1;
          yield SAFE_REPLY;
          break;
        }
        if (cleaned) {
          emitted += 1;
          yield cleaned;
        }
        if (cleaner.full) break;
      }
    }
  } catch (error) {
    publish({ lastError: error.message });
    if (emitted === 0) {
      emitted += 1;
      yield ERROR_REPLY;
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  if (emitted === 0) yield EMPTY_REPLY;
}

async function* streamOllamaSentences(config, prompt, signal) {
  const res = await fetch(`${config.ollama.endpoint}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildOllamaRequest(config, prompt, { stream: true })),
    signal
  });
  if (!res.ok) {
    const text = await safeErrorText(res);
    let message = "";
    try {
      message = JSON.parse(text).error ?? "";
    } catch {}
    throw new Error(message || `Ollama HTTP ${res.status}: ${text}`);
  }
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let textBuffer = "";
  for await (const chunk of res.body) {
    lineBuffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, newline).trim();
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      textBuffer += data.response ?? "";
      let cut;
      while ((cut = findSentenceCut(textBuffer)) > 0) {
        yield textBuffer.slice(0, cut);
        textBuffer = textBuffer.slice(cut);
      }
    }
  }
  if (textBuffer.trim()) yield textBuffer;
}

// 「。！？」で区切る。短すぎる文（「えへへ！」など）は次の文とまとめて、音声が細切れにならないようにする。
function findSentenceCut(text, minChars = 8, maxChars = 60) {
  const pattern = /[。！？!?\n]+[」』）)]*/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end >= text.length) return 0; // 「！？」のように記号が続くかもしれないので、次の文字が来るまで待つ
    if (text.slice(0, end).trim().length >= minChars) return end;
  }
  if (text.length > maxChars) {
    const comma = text.lastIndexOf("、", maxChars);
    return comma > minChars ? comma + 1 : maxChars;
  }
  return 0;
}

function splitSentences(text) {
  return String(text ?? "").split(/(?<=[。！？!?\n])/).filter((sentence) => sentence.trim());
}

// trimReply と同じ後処理を1文ずつ行う。文字数の上限を超える文は途中で切らずに丸ごと落とす。
function createReplyCleaner(maxChars) {
  const seen = new Set();
  let used = 0;
  let full = false;
  return {
    get full() {
      return full;
    },
    push(raw) {
      if (full) return "";
      let sentence = String(raw).replace(/\n+/g, " ").replace(/^[\s「"]+|[\s」"]+$/g, "");
      sentence = removeCatchphrases(removeInternalReactionLeak(sentence));
      if (used === 0) sentence = removeSelfIntro(sentence);
      sentence = removeRepetitivePhrases(sentence);
      const key = sentence.replace(/[。！？!?、\s]/g, "");
      if (!key || seen.has(key)) return "";
      seen.add(key);
      if (used + sentence.length > maxChars) {
        full = true;
        if (used > 0) return "";
        sentence = sentence.slice(0, maxChars).trim();
      }
      used += sentence.length;
      return sentence;
    }
  };
}

function buildInnerReactionPrompt() {
  return [
    "返答を作る前に、頭の中だけで次の2つを決めてください。",
    "1. 感情タグ: 喜び、驚き、照れ、困惑、ツッコミ、応援、しょんぼり、得意げ、あわあわ、通常の中から1つ選ぶ。",
    "2. 返答方針: コメントのどの言葉を拾うか、どんなポンコツ反応を少し混ぜるか、最後を質問・共感・軽いツッコミのどれで締めるかを決める。",
    "感情タグや返答方針は絶対に出力しないでください。画面に出すのは自然な返答文だけです。",
    "毎回同じ言い回しにせず、コメントの具体語を1つ以上拾ってください。ポンコツ感は少量にして、意味が通る文章にしてください。"
  ].join("\n");
}

function buildOllamaRequest(config, prompt, { stream = false, numPredict } = {}) {
  return {
    model: config.ollama.model,
    prompt,
    stream,
    think: false,
    keep_alive: config.ollama.keepAlive,
    options: {
      temperature: config.ollama.temperature,
      top_p: config.ollama.topP,
      repeat_penalty: config.ollama.repeatPenalty,
      num_predict: numPredict ?? config.ollama.numPredict
    }
  };
}

async function generateOllamaReply(config, prompt, signal, { numPredict } = {}) {
  const res = await fetch(`${config.ollama.endpoint}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildOllamaRequest(config, prompt, { numPredict })),
    signal
  });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(body.error || `Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
  return body.response ?? "";
}

function trimReply(text, maxChars) {
  const cleaned = String(text)
    .replace(/^[\s「"]+|[\s」"]+$/g, "")
    .replace(/\n+/g, " ")
    .trim();
  const withoutMeta = removeInternalReactionLeak(cleaned);
  const normalized = removeCatchphrases(withoutMeta);
  const withoutIntro = removeSelfIntro(normalized);
  const withoutRepeats = removeRepetitivePhrases(withoutIntro);
  return withoutRepeats.slice(0, maxChars).trim() || EMPTY_REPLY;
}

function removeInternalReactionLeak(text) {
  return String(text)
    .replace(/(?:^|\s)(?:感情タグ|感情|返答方針|方針|内心|内部メモ)\s*[:：]\s*[^。！？!?]*(?:[。！？!?]|\s|$)/g, " ")
    .replace(/(?:^|\s)(?:1\.|2\.|1：|2：)\s*[^。！？!?]*(?:感情タグ|返答方針)[^。！？!?]*(?:[。！？!?]|\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeCatchphrases(text) {
  return text
    .replace(/なのだ/g, "だよ")
    .replace(/なのです/g, "です")
    .replace(/なのね/g, "だね")
    .replace(/(?<!も)のだ([。！!？?、\s]|$)/g, "よ$1")
    .replace(/だぜ/g, "だよ")
    .replace(/ござる/g, "です")
    .replace(/\s+/g, " ")
    .trim();
}

function removeSelfIntro(text) {
  return text
    .replace(/^どんぐりこだよ[。！!、\s]*/g, "")
    .replace(/^私はどんぐりこ[。！!、\s]*(だよ|です)?[。！!、\s]*/g, "")
    .replace(/^どんぐりこです[。！!、\s]*/g, "")
    .trim();
}

function removeRepetitivePhrases(text) {
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";

  const sentences = cleaned
    .split(/(?<=[。！？!?])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const seenSentences = new Set();
  const uniqueSentences = [];
  for (const sentence of sentences.length ? sentences : [cleaned]) {
    const key = sentence.replace(/[。！？!?、\s]/g, "");
    if (!key || seenSentences.has(key)) continue;
    seenSentences.add(key);
    uniqueSentences.push(sentence);
  }

  return uniqueSentences
    .join("")
    .replace(/(.{2,12})(?:\s*\1){2,}/g, "$1")
    .replace(/(えへへ|あわわ|うんうん|そうそう|ありがとう|ごめんね)(?:[、。\s]*\1){1,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

async function synthesizeVoice(config, text, outPath = join(RUNTIME_DIR, "last.wav")) {
  const tts = config.tts ?? config.voicevox;
  const speechText = sanitizeTtsText(text);
  const engine = (tts.engine ?? "aivis").toLowerCase();
  if (["irodori-gradio", "irodori_gradio", "irodori-voicedesign"].includes(engine)) {
    return synthesizeIrodoriGradioVoice(tts, speechText, outPath);
  }
  if (engine === "irodori") {
    return synthesizeIrodoriVoice(tts, speechText, outPath);
  }
  return synthesizeAivisVoice(tts, speechText, outPath);
}

function sanitizeCommentText(text) {
  return stripEmojiAndUnsafeText(text);
}

function sanitizeTtsText(text) {
  return stripEmojiAndUnsafeText(text) || "OK";
}

function stripEmojiAndUnsafeText(text) {
  return String(text ?? "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, "")
    .replace(/[\uD800-\uDFFF]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function synthesizeIrodoriGradioVoice(tts, text, wavPath) {
  const endpoint = String(tts.endpoint ?? "http://127.0.0.1:7861").replace(/\/+$/g, "");
  const timeoutMs = tts.timeoutMs ?? 300000;
  const data = await buildIrodoriGradioData(tts, text, endpoint, timeoutMs);
  const result = await callGradioApi(endpoint, "_run_generation", data, timeoutMs);
  const audioFile = result
    .slice(0, 32)
    .find((item) => (typeof item === "string" && item.trim()) || item?.path || item?.url)
    ?? extractIrodoriSavedAudioPath(result[32]);
  if (!audioFile) {
    const runLog = typeof result[32] === "string" ? result[32].slice(0, 240) : "";
    throw new Error(`Irodori Gradio did not return audio.${runLog ? ` Log: ${runLog}` : ""}`);
  }

  await saveGradioAudioFile(tts, endpoint, audioFile, wavPath, timeoutMs);
  return wavPath;
}

function extractIrodoriSavedAudioPath(runLog) {
  if (typeof runLog !== "string") return "";
  return runLog.match(/saved\[\d+\]:\s*([^\s]+\.wav)/i)?.[1] ?? "";
}

async function buildIrodoriGradioData(tts, text, endpoint, timeoutMs) {
  const gradio = tts.gradio ?? {};
  const refWav = gradio.refWav ?? tts.refWav ?? "";
  if (refWav && !existsSync(refWav)) {
    throw new Error(`Irodori reference audio was not found: ${refWav}`);
  }
  const refFile = refWav ? await getCachedGradioFile(endpoint, refWav, timeoutMs) : null;
  return [
    gradio.checkpoint ?? tts.checkpoint ?? "Aratako/Irodori-TTS-600M-v3-VoiceDesign",
    gradio.modelDevice ?? "cpu",
    gradio.modelPrecision ?? "fp32",
    gradio.codecDevice ?? "cpu",
    gradio.codecPrecision ?? "fp32",
    text,
    gradio.caption ?? tts.caption ?? text,
    refFile,
    gradio.numSteps ?? 40,
    gradio.numCandidates ?? 1,
    gradio.seed ?? "",
    gradio.seconds ?? "",
    gradio.durationScale ?? 1,
    gradio.tScheduleMode ?? "linear",
    gradio.swayCoeff ?? -1,
    gradio.cfgGuidanceMode ?? "independent",
    gradio.cfgScaleText ?? 3,
    gradio.cfgScaleCaption ?? 4,
    gradio.cfgScaleSpeaker ?? 5,
    gradio.cfgScale ?? "",
    gradio.cfgMinT ?? 0.5,
    gradio.cfgMaxT ?? 1,
    gradio.contextKvCache ?? true,
    gradio.speakerKvScale ?? "",
    gradio.maxTextLen ?? "",
    gradio.maxCaptionLen ?? "",
    gradio.truncationFactor ?? "",
    gradio.rescaleK ?? "",
    gradio.rescaleSigma ?? "",
    gradio.loraAdapter ?? ""
  ];
}

async function getCachedGradioFile(endpoint, filePath, timeoutMs) {
  const fileStat = await stat(filePath);
  const cacheKey = `${endpoint}\n${filePath}`;
  const cached = gradioUploadCache.get(cacheKey);
  if (
    cached
    && cached.mtimeMs === fileStat.mtimeMs
    && cached.size === fileStat.size
    && cached.file
  ) {
    return cached.file;
  }

  const file = await uploadGradioFile(endpoint, filePath, timeoutMs);
  gradioUploadCache.set(cacheKey, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    file
  });
  return file;
}

async function uploadGradioFile(endpoint, filePath, timeoutMs) {
  const form = new FormData();
  const buffer = await readFile(filePath);
  form.append("files", new Blob([buffer]), basename(filePath));
  const res = await fetchWithTimeout(`${endpoint}/gradio_api/upload`, {
    method: "POST",
    body: form
  }, timeoutMs);
  if (!res.ok) throw new Error(`Irodori Gradio upload HTTP ${res.status}: ${await safeErrorText(res)}`);
  const uploaded = await res.json();
  const uploadedPath = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  if (!uploadedPath) throw new Error("Irodori Gradio upload did not return a file path.");
  return {
    path: uploadedPath,
    orig_name: basename(filePath),
    meta: { _type: "gradio.FileData" }
  };
}

async function callGradioApi(endpoint, apiName, data, timeoutMs) {
  const callRes = await fetchWithTimeout(`${endpoint}/gradio_api/call/${apiName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data })
  }, timeoutMs);
  if (!callRes.ok) throw new Error(`Irodori Gradio call HTTP ${callRes.status}: ${await safeErrorText(callRes)}`);
  const callBody = await callRes.json();
  if (!callBody.event_id) throw new Error("Irodori Gradio did not return an event_id.");

  const eventRes = await fetchWithTimeout(`${endpoint}/gradio_api/call/${apiName}/${callBody.event_id}`, {}, timeoutMs);
  if (!eventRes.ok) throw new Error(`Irodori Gradio event HTTP ${eventRes.status}: ${await safeErrorText(eventRes)}`);
  return parseGradioEventResult(await eventRes.text());
}

function parseGradioEventResult(eventText) {
  let lastData;
  for (const block of eventText.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    const parsed = JSON.parse(data);
    if (event === "error") throw new Error(`Irodori Gradio error: ${JSON.stringify(parsed).slice(0, 240)}`);
    lastData = parsed;
  }
  if (!lastData) throw new Error("Irodori Gradio returned no result data.");
  return Array.isArray(lastData) && Array.isArray(lastData[0]) ? lastData[0] : lastData;
}

async function saveGradioAudioFile(tts, endpoint, audioFile, outputPath, timeoutMs) {
  const filePath = typeof audioFile === "string" ? audioFile : audioFile.path;
  const fileUrl = typeof audioFile === "string" ? "" : audioFile.url;
  const localPath = resolveGradioOutputPath(tts, filePath);

  if (localPath) {
    await copyFile(localPath, outputPath);
    return;
  }

  const url = fileUrl
    ? new URL(fileUrl, endpoint).toString()
    : new URL(`/gradio_api/file=${encodeURIComponent(filePath)}`, endpoint).toString();
  const res = await fetchWithTimeout(url, {}, timeoutMs);
  if (!res.ok) {
    throw new Error(
      `Irodori Gradio audio download HTTP ${res.status}: ${await safeErrorText(res)} `
      + "If Gradio returned a relative gradio_outputs path, set tts.gradio.appRoot to the folder where the Gradio app was started."
    );
  }
  await writeResponseBodyToFile(res, outputPath);
}

function resolveGradioOutputPath(tts, filePath) {
  if (!filePath) return "";
  if (existsSync(filePath)) return filePath;

  const normalized = String(filePath).replaceAll("\\", "/");
  const gradio = tts.gradio ?? {};
  const roots = [
    gradio.outputRoot,
    gradio.appRoot,
    process.cwd(),
    ROOT
  ].filter(Boolean);

  for (const root of roots) {
    const candidate = join(root, normalized);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

async function synthesizeIrodoriVoice(tts, text, wavPath) {
  const endpoint = String(tts.endpoint ?? "http://127.0.0.1:8088").replace(/\/+$/g, "");
  const timeoutMs = tts.timeoutMs ?? 300000;
  const speechUrl = new URL(`${endpoint}/v1/audio/speech`);
  const headers = { "Content-Type": "application/json" };
  if (tts.apiKey) headers.Authorization = `Bearer ${tts.apiKey}`;
  const body = {
    model: tts.model ?? "irodori-tts",
    input: text,
    voice: tts.voice ?? tts.speaker ?? "none",
    response_format: tts.responseFormat ?? "wav"
  };
  if (tts.speed !== undefined) body.speed = tts.speed;
  if (tts.irodori && typeof tts.irodori === "object") body.irodori = tts.irodori;

  const res = await fetchWithTimeout(speechUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  }, timeoutMs);
  if (!res.ok) throw new Error(`Irodori TTS HTTP ${res.status}: ${await safeErrorText(res)}`);

  await writeResponseBodyToFile(res, wavPath);
  return wavPath;
}

async function synthesizeAivisVoice(tts, text, wavPath) {
  const endpoint = tts.endpoint;
  const timeoutMs = tts.timeoutMs ?? 30000;
  const speaker = await resolveTtsSpeaker(endpoint, tts.speaker);
  const queryUrl = new URL(`${endpoint}/audio_query`);
  queryUrl.searchParams.set("speaker", speaker);
  queryUrl.searchParams.set("text", text);

  const queryRes = await fetchWithTimeout(queryUrl, { method: "POST" }, timeoutMs);
  if (!queryRes.ok) throw new Error(`TTS audio_query HTTP ${queryRes.status}: ${await safeErrorText(queryRes)}`);
  const query = await queryRes.json();

  const synthUrl = new URL(`${endpoint}/synthesis`);
  synthUrl.searchParams.set("speaker", speaker);
  const synthRes = await fetchWithTimeout(synthUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query)
  }, timeoutMs);
  if (!synthRes.ok) throw new Error(`TTS synthesis HTTP ${synthRes.status}: ${await safeErrorText(synthRes)}`);

  await writeResponseBodyToFile(synthRes, wavPath);
  return wavPath;
}

async function writeResponseBodyToFile(res, filePath) {
  const file = createWriteStream(filePath);
  await new Promise((resolve, reject) => {
    file.on("error", reject);
    res.body.pipeTo(new WritableStream({
      write(chunk) {
        file.write(Buffer.from(chunk));
      },
      close() {
        file.end(resolve);
      },
      abort(reason) {
        file.destroy(reason);
        reject(reason);
      }
    })).catch(reject);
  });
}

async function resolveTtsSpeaker(endpoint, configuredSpeaker) {
  try {
    const res = await fetchWithTimeout(`${endpoint}/speakers`, {}, 5000);
    if (!res.ok) return configuredSpeaker;
    const speakers = await res.json();
    const styleIds = speakers.flatMap((speaker) => speaker.styles ?? []).map((style) => style.id);
    if (styleIds.includes(Number(configuredSpeaker))) return configuredSpeaker;
    if (styleIds.length > 0) {
      console.warn(`Configured TTS speaker ${configuredSpeaker} was not found. Using ${styleIds[0]} instead.`);
      return styleIds[0];
    }
  } catch {
    return configuredSpeaker;
  }
  return configuredSpeaker;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function safeErrorText(res) {
  try {
    return (await res.text()).slice(0, 240);
  } catch {
    return "";
  }
}

const LIP_SYNC_FRAME_MS = 40;

async function readWavLipSync(wavPath, frameMs = LIP_SYNC_FRAME_MS) {
  const empty = { durationMs: 0, frameMs, envelope: [] };
  try {
    const buf = await readFile(wavPath);
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return empty;

    let offset = 12;
    let channels = 0;
    let sampleRate = 0;
    let byteRate = 0;
    let blockAlign = 0;
    let bitsPerSample = 0;
    let dataStart = 0;
    let dataSize = 0;
    while (offset + 8 <= buf.length) {
      const chunkId = buf.toString("ascii", offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      if (chunkId === "fmt " && offset + 24 <= buf.length) {
        channels = buf.readUInt16LE(offset + 10);
        sampleRate = buf.readUInt32LE(offset + 12);
        byteRate = buf.readUInt32LE(offset + 16);
        blockAlign = buf.readUInt16LE(offset + 20);
        bitsPerSample = buf.readUInt16LE(offset + 22);
      }
      if (chunkId === "data") {
        dataStart = offset + 8;
        dataSize = Math.min(chunkSize, buf.length - dataStart);
        break;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    if (!byteRate || !dataSize) return empty;

    const durationMs = Math.round((dataSize / byteRate) * 1000);
    if (bitsPerSample !== 16 || !blockAlign || !channels) return { durationMs, frameMs, envelope: [] };

    // frameMsごとのRMSを取って、最大値で正規化した口の開き具合にする
    const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
    const totalFrames = Math.floor(dataSize / blockAlign);
    const envelope = [];
    let peak = 0;
    for (let start = 0; start < totalFrames; start += samplesPerFrame) {
      const end = Math.min(start + samplesPerFrame, totalFrames);
      let sum = 0;
      for (let i = start; i < end; i += 1) {
        const value = buf.readInt16LE(dataStart + i * blockAlign) / 32768;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      if (rms > peak) peak = rms;
      envelope.push(rms);
    }
    if (peak <= 0) return { durationMs, frameMs, envelope: [] };

    return {
      durationMs,
      frameMs,
      envelope: envelope.map((value) => Number(Math.pow(value / peak, 0.7).toFixed(2)))
    };
  } catch {
    return empty;
  }
}

// 常駐プレイヤーで鳴らす。使えない時は従来どおり毎回 PowerShell を起動して鳴らす。
async function playWav(config, wavPath, { onStart, durationMs = 0 } = {}) {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    onStart?.();
  };
  if (wavPlayer && config.audio.persistentPlayer) {
    const played = await wavPlayer.play(wavPath, { onStart: start, maxMs: (durationMs || 40000) + 5000 });
    if (played) return;
  }
  start();
  await playWavOnce(wavPath);
}

// PowerShell を毎回起動すると0.5〜1秒ほど待たされるので、1つだけ起動しっぱなしにして再生を頼む。
function createWavPlayer() {
  const script = [
    "while ($true) {",
    "  $line = [Console]::In.ReadLine()",
    "  if ($line -eq $null) { break }",
    "  try {",
    "    $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Trim()))",
    "    $player = New-Object System.Media.SoundPlayer $path",
    "    $player.Load()",
    "    [Console]::Out.WriteLine('start')",
    "    $player.PlaySync()",
    "    $player.Dispose()",
    "    [Console]::Out.WriteLine('done')",
    "  } catch {",
    "    [Console]::Out.WriteLine('error')",
    "  }",
    "}"
  ].join("\n");
  let child = null;
  let onLine = null;

  function ensure() {
    if (child) return child;
    const proc = spawn("powershell", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")
    ], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onLine?.(line);
      }
    });
    const handleExit = () => {
      if (child === proc) child = null;
      onLine?.("exit");
    };
    proc.on("exit", handleExit);
    proc.on("error", handleExit);
    proc.stdin.on("error", () => {});
    child = proc;
    return proc;
  }

  function play(wavPath, { onStart, maxMs = 45000 } = {}) {
    return new Promise((resolvePlay) => {
      let started = false;
      const finish = (ok) => {
        clearTimeout(timer);
        onLine = null;
        resolvePlay(ok);
      };
      const timer = setTimeout(() => {
        child?.kill();
        child = null;
        finish(started);
      }, maxMs);
      onLine = (line) => {
        if (line === "start") {
          started = true;
          onStart?.();
        } else if (line === "done") {
          finish(true);
        } else if (line === "error" || line === "exit") {
          finish(started);
        }
      };
      try {
        ensure().stdin.write(`${Buffer.from(wavPath, "utf8").toString("base64")}\n`);
      } catch {
        finish(false);
      }
    });
  }

  return { play, warm: ensure };
}

function playWavOnce(wavPath) {
  const maxPlayMs = 45000;
  const command = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    `$p = New-Object System.Media.SoundPlayer '${wavPath.replaceAll("'", "''")}';`,
    "$p.PlaySync();"
  ].join(" ");
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      windowsHide: true,
      stdio: "ignore"
    });
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, maxPlayMs);
    child.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

main().catch((error) => {
  console.error(error.message);
  publish({ status: "fatal", lastError: error.message, replyText: "起動に失敗しちゃった" });
  process.exitCode = 1;
});
