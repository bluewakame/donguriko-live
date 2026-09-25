// TikTok LIVE のコメント・ギフト・フォローを、わんコメを通さず直接受け取る。
// 非公式ライブラリ tiktok-live-connector を使う（TikTok 側の仕様変更で急に動かなくなることがある）。

const GIFT_NOTE = "この視聴者がギフト（投げ銭）を贈ってくれました。贈ってくれたことに、うれしそうにお礼を言ってください。";
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
  let failures = 0;
  while (true) {
    try {
      await connectOnce(settings, library, seenIds, { onComment, onStatus });
      failures = 0;
      console.log("[TikTok] 切断されたので再接続するよ");
      await sleep(settings.reconnectIntervalMs);
    } catch (error) {
      if (error instanceof library.UserOfflineError) {
        failures = 0;
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

function connectOnce(settings, library, seenIds, { onComment, onStatus }) {
  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = library;
  const connection = new TikTokLiveConnection(settings.uniqueId, {
    ...(settings.signApiKey ? { signApiKey: settings.signApiKey } : {}),
    // 接続した瞬間に過去のコメントへまとめて返事しないよう、初回の履歴は捨てる。
    // enableExtendedGiftInfo は Euler Stream の有料プランが必要で、失敗すると接続ごと落ちるので使わない。
    // ギフト名とダイヤ数は data.gift に入っている。
    processInitialData: false
  });

  const emit = (id, user, text, eventNote = "") => {
    const key = `tiktok:${id}`;
    if (!id || seenIds.has(key)) return;
    seenIds.add(key);
    if (seenIds.size > 2000) seenIds.delete(seenIds.values().next().value);
    onComment({ id: key, author: userName(user), text, service: "tiktok", eventNote });
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
    const name = gift.name || gift.giftName || data.extendedGiftInfo?.name || "ギフト";
    emit(messageId(data), data.user, `ギフト「${name}」×${count}`, GIFT_NOTE);
  });

  connection.on(WebcastEvent.FOLLOW, (data) => {
    if (!settings.replyToFollows) return;
    emit(messageId(data), data.user, "フォローしたよ", FOLLOW_NOTE);
  });

  connection.on(ControlEvent.ERROR, ({ info, exception }) => {
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
