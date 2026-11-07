// TikTok LIVE のコメント・ギフト・フォローを、わんコメを通さず直接受け取る。
// 非公式ライブラリ tiktok-live-connector を使う（TikTok 側の仕様変更で急に動かなくなることがある）。

import { describeGift, normalizeGiftConfig } from "./gifts.js";

export function isTikTokOffline(error) {
  return /requested user isn't online|useroffline|user is offline/i.test(String(error?.message ?? error ?? ""));
}

const FOLLOW_NOTE = "この視聴者がたった今フォローしてくれました。うれしそうにお礼を言ってください。";

export function normalizeTikTokConfig(config) {
  const tiktok = config.tiktok ?? {};
  config.tiktok = tiktok;
  tiktok.enabled = tiktok.enabled ?? false;
  tiktok.uniqueId = String(tiktok.uniqueId ?? "").trim();
  tiktok.signApiKey = String(tiktok.signApiKey ?? "").trim();
  tiktok.reconnectIntervalMs = Math.max(5000, Number(tiktok.reconnectIntervalMs ?? 10000));
  tiktok.offlineRetryMs = Math.max(30000, Number(tiktok.offlineRetryMs ?? 60000));
  tiktok.replyToGifts = tiktok.replyToGifts ?? true;
  tiktok.minGiftDiamonds = Math.max(0, Number(tiktok.minGiftDiamonds ?? 0));
  tiktok.replyToFollows = tiktok.replyToFollows ?? true;
  tiktok.replyToJoins = tiktok.replyToJoins ?? true;
  tiktok.joinGlobalCooldownMs = Math.max(10000, Number(tiktok.joinGlobalCooldownMs ?? 30000));
  tiktok.joinUserCooldownMs = Math.max(60000, Number(tiktok.joinUserCooldownMs ?? 600000));
  normalizeGiftConfig(tiktok);
  return tiktok;
}

// onComment には app.js の enqueueComment に渡す形（id / author / text / service / eventNote）で渡す。
export async function runTikTokLoop(config, { onComment, onStatus }) {
  const settings = config.tiktok;
  if (!settings.uniqueId) {
    console.warn("[TikTok] config.json の tiktok.uniqueId に配信者のユーザー名（@の後ろ）を入れてください。");
    onStatus("tiktok-no-user", "tiktok.uniqueId が未設定です");
    return;
  }

  let library;
  try {
    library = await import("tiktok-live-connector");
  } catch {
    console.warn("[TikTok] tiktok-live-connector が入っていません。このフォルダで npm install を実行してください。");
    onStatus("tiktok-missing-library", "npm install が必要です");
    return;
  }

  const seenIds = new Set();
  const joinGate = { lastAt: 0, users: new Map() };
  let failures = 0;
  let offlineReported = false;
  while (true) {
    try {
      await connectOnce(settings, library, seenIds, joinGate, { onComment, onStatus });
      failures = 0;
      offlineReported = false;
      console.log("[TikTok] 切断されたので再接続するよ");
      await sleep(settings.reconnectIntervalMs);
    } catch (error) {
      if (error instanceof library.UserOfflineError || isTikTokOffline(error)) {
        failures = 0;
        if (!offlineReported) console.log("[TikTok] 配信開始待ち。ライブが始まると自動接続します");
        offlineReported = true;
        onStatus("tiktok-offline", "");
        await sleep(settings.offlineRetryMs);
        continue;
      }
      failures += 1;
      console.warn(`[TikTok] 接続できませんでした: ${error.message}`);
      onStatus("tiktok-error", error.message);
      // 失敗が続く時は、TikTok や署名サーバーに弾かれないよう間隔をのばす（最大5分）。
      await sleep(Math.min(settings.reconnectIntervalMs * 2 ** Math.min(failures - 1, 5), 5 * 60 * 1000));
    }
  }
}

function connectOnce(settings, library, seenIds, joinGate, { onComment, onStatus }) {
  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = library;
  const connection = new TikTokLiveConnection(settings.uniqueId, {
    ...(settings.signApiKey ? { signApiKey: settings.signApiKey } : {}),
    // 接続した瞬間に過去のコメントへまとめて返事しないよう、初回の履歴は捨てる。
    // enableExtendedGiftInfo は Euler Stream の有料プランが必要で、失敗すると接続ごと落ちるので使わない。
    // ギフト名とダイヤ数は data.gift に入っている。
    processInitialData: false
  });

  const emit = (id, user, text, eventNote = "", kind = "") => {
    const key = `tiktok:${id}`;
    if (!id || seenIds.has(key)) return;
    seenIds.add(key);
    if (seenIds.size > 2000) seenIds.delete(seenIds.values().next().value);
    onComment({ id: key, author: userName(user), text, service: "tiktok", eventNote, kind });
  };

  connection.on(WebcastEvent.CHAT, (data) => {
    // tiktok-live-connector 2.x は本文が content に入る（1.x は comment）。
    const text = String(data.content ?? data.comment ?? "").trim();
    if (!text) return;
    emit(messageId(data), data.user, text);
  });

  connection.on(WebcastEvent.GIFT, (data) => {
    if (!settings.replyToGifts) return;
    // 2.x はギフト情報が gift に入る（1.x は giftDetails）。
    const gift = data.gift ?? data.giftDetails ?? {};
    // 連続ギフトは送り終わった時（repeatEnd）の1回だけ拾う。
    if ((gift.type ?? gift.giftType) === 1 && !data.repeatEnd) return;
    const count = Math.max(1, Number(data.repeatCount ?? 1));
    const diamonds = Number(gift.diamondCount ?? data.extendedGiftInfo?.diamond_count ?? 0) * count;
    if (diamonds < settings.minGiftDiamonds) return;
    const rawName = gift.name || gift.giftName || data.extendedGiftInfo?.name || "";
    const { name, note } = describeGift(settings.gifts, rawName, count, diamonds);
    emit(messageId(data), data.user, `ギフト「${name}」×${count}`, note);
  });

  connection.on(WebcastEvent.FOLLOW, (data) => {
    if (!settings.replyToFollows) return;
    emit(messageId(data), data.user, "フォローしたよ", FOLLOW_NOTE);
  });

  let connectedAt = Infinity;
  connection.on(WebcastEvent.MEMBER, (data) => {
    if (!settings.replyToJoins || Date.now() - connectedAt < 10000) return;
    const user = data.user;
    const userId = String(user?.uniqueId || user?.userId || user?.nickname || "").trim();
    if (!userId) return;
    const now = Date.now();
    if (now - joinGate.lastAt < settings.joinGlobalCooldownMs) return;
    if (now - (joinGate.users.get(userId) ?? 0) < settings.joinUserCooldownMs) return;
    joinGate.lastAt = now;
    joinGate.users.set(userId, now);
    if (joinGate.users.size > 1000) joinGate.users.delete(joinGate.users.keys().next().value);
    emit(messageId(data) || "join:" + userId + ":" + now, user, "入室したよ", "", "viewer-enter");
  });

  connection.on(ControlEvent.ERROR, ({ info, exception }) => {
    if (isTikTokOffline({ message: [info, exception?.message].filter(Boolean).join(" ") })) return;
    console.warn(`[TikTok] エラー: ${info ?? ""} ${exception?.message ?? ""}`.trim());
  });

  connection.on(WebcastEvent.STREAM_END, () => {
    console.log("[TikTok] 配信が終わったみたい");
  });

  return new Promise((resolve, reject) => {
    connection.on(ControlEvent.DISCONNECTED, () => {
      onStatus("tiktok-disconnected", "");
      resolve();
    });
    connection.connect()
      .then((state) => {
        connectedAt = Date.now();
        console.log(`[TikTok] @${settings.uniqueId} の配信につながったよ (roomId: ${state.roomId})`);
        onStatus("tiktok-connected", "");
      })
      .catch(reject);
  });
}

function messageId(data) {
  return String(data.common?.msgId ?? data.msgId ?? "");
}

function userName(user) {
  return String(user?.nickname || user?.uniqueId || "視聴者").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
