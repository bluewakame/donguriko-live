// 英語のコメントを見分けたり、日本語の返事に混ざった英単語を読み上げ用にカタカナへ直したりする。

const JAPANESE_CHARS = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

// かな・漢字が1文字もなく、英単語が2つ以上か4文字以上の英単語があるコメントを英語とみなす。
// 「gg」「lol」のような短い略語や、日本語の笑いの「www」は英語にしない。
export function isEnglishComment(text) {
  const value = String(text ?? "");
  if (JAPANESE_CHARS.test(value)) return false;
  const words = (value.match(/[A-Za-z]+/g) ?? []).filter((word) => !/^w+$/i.test(word));
  return words.length >= 2 || words.some((word) => word.length >= 4);
}

// 「英語でしゃべって」「スペイン語で話して」「関西弁で言って」「speak Spanish」のような頼みを読む。
// { language: "英語", dialect: false } を返す。「日本語で」「speak Japanese」は { reset: true }。頼みでなければ null。
const ASK_VERB = "(?:しゃべ|喋|話|はな|言っ|いっ|言え|いえ|返|答|こたえ|お願い|おねがい|頼|たの|挨拶|あいさつ|自己紹介|よろしく|戻|もど)";
const JA_LANGUAGE_REQUEST = new RegExp(`([一-龠々ァ-ヶー]{1,10}?)(語|弁)(?:で|に)(?:も|は)?${ASK_VERB}`);
const EN_LANGUAGE_REQUEST = /\b(?:speak|talk|reply|answer|say(?:\s+\w+)?)\s+(?:to\s+me\s+)?(?:in\s+)?([A-Z][a-z]+)\b|\bin\s+([A-Z][a-z]+)\s*,?\s*please\b/i;
// 「次は」「今度」などの頭についた言葉は言語名から外す。
const LEADING_WORDS = /^(?:次|今度|今|また|もう一回|全部|ずっと|一回|少し|ちょっと)/;
const EN_LANGUAGE_NAMES = new Set(["english", "japanese", "spanish", "french", "german", "italian", "portuguese", "russian", "chinese", "mandarin", "cantonese", "korean", "thai", "vietnamese", "indonesian", "malay", "tagalog", "filipino", "arabic", "hindi", "turkish", "dutch", "polish", "swedish", "greek", "latin"]);

export function parseLanguageRequest(text) {
  const value = String(text ?? "");
  const normalized = value.replace(/\s+/g, "");
  const ja = normalized.match(JA_LANGUAGE_REQUEST);
  if (ja) {
    const name = ja[1].replace(LEADING_WORDS, "") || ja[1];
    if (name === "日本" && ja[2] === "語") return { reset: true };
    if (name === "標準" || name === "共通") return { reset: true };
    return { language: `${name}${ja[2]}`, dialect: ja[2] === "弁" };
  }
  const en = value.match(EN_LANGUAGE_REQUEST);
  const name = (en?.[1] || en?.[2] || "").toLowerCase();
  if (!EN_LANGUAGE_NAMES.has(name)) return null;
  if (name === "japanese") return { reset: true };
  return { language: name === "english" ? "英語" : name[0].toUpperCase() + name.slice(1), dialect: false };
}

export function hasJapanese(text) {
  return JAPANESE_CHARS.test(String(text ?? ""));
}

// 日本語の返事に出てきやすい英単語の読み。大文字・小文字は区別しない。
const WORD_READINGS = {
  "live2d": "ライブツーディー",
  "vtuber": "ブイチューバー",
  "youtube": "ユーチューブ",
  "youtuber": "ユーチューバー",
  "tiktok": "ティックトック",
  "tiktoker": "ティックトッカー",
  "twitter": "ツイッター",
  "instagram": "インスタグラム",
  "discord": "ディスコード",
  "google": "グーグル",
  "iphone": "アイフォン",
  "android": "アンドロイド",
  "minecraft": "マインクラフト",
  "pokemon": "ポケモン",
  "gemma": "ジェマ",
  "ollama": "オラマ",
  "wi-fi": "ワイファイ",
  "wifi": "ワイファイ",
  "ok": "オーケー",
  "live": "ライブ",
  "stream": "ストリーム",
  "vlog": "ブイログ",
  "game": "ゲーム",
  "gift": "ギフト",
  "fan": "ファン",
  "thank": "サンク",
  "thanks": "サンクス",
  "you": "ユー",
  "nice": "ナイス",
  "cute": "キュート",
  "cool": "クール",
  "good": "グッド",
  "great": "グレート",
  "love": "ラブ",
  "happy": "ハッピー",
  "hello": "ハロー",
  "hi": "ハイ",
  "bye": "バイ",
  "yes": "イエス",
  "wow": "ワオ",
  "sorry": "ソーリー",
  "please": "プリーズ",
  "welcome": "ウェルカム",
  "lucky": "ラッキー",
  "party": "パーティー",
  "music": "ミュージック",
  "lol": "笑"
};

// アルファベットの読み。辞書にない略語（NHK など）は1文字ずつ読む。
const LETTER_READINGS = {
  A: "エー", B: "ビー", C: "シー", D: "ディー", E: "イー", F: "エフ", G: "ジー",
  H: "エイチ", I: "アイ", J: "ジェー", K: "ケー", L: "エル", M: "エム", N: "エヌ",
  O: "オー", P: "ピー", Q: "キュー", R: "アール", S: "エス", T: "ティー", U: "ユー",
  V: "ブイ", W: "ダブリュー", X: "エックス", Y: "ワイ", Z: "ゼット"
};

// 日本語の文に混ざった英単語を、読み上げ用にカタカナへ直す。英語だけの文はそのまま返す。
// 画面の字幕は元の文のままで、音声合成に渡す文だけに使う。
export function toJapaneseReading(text) {
  const value = String(text ?? "");
  if (!hasJapanese(value)) return value;
  return value.replace(/thank\s*you/gi, "サンキュー").replace(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9-]*/g, (word) => {
    const known = WORD_READINGS[word.toLowerCase()];
    if (known) return known;
    // 「NHK」「BGM」のような大文字だけの短い略語は1文字ずつ読む。
    if (/^[A-Z]{1,5}$/.test(word)) return [...word].map((letter) => LETTER_READINGS[letter]).join("");
    return word;
  });
}

// 文をつなぐ。英語の文どうしは間に空白を入れて「Hi!How」のようにくっつかないようにする。
export function joinSentences(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  if (!a || !b) return a + b;
  if (/[A-Za-zÀ-ÖØ-öø-ÿ0-9][.!?,'")]*$/.test(a) && /^[A-Za-zÀ-ÖØ-öø-ÿ0-9"'(¡¿]/.test(b)) return `${a} ${b}`;
  return a + b;
}
