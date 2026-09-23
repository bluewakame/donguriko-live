// 危ないコメント・危ない返事を見分ける。
// 入口（視聴者のコメント）と出口（LLMの返事・ひとりごと）の両方で同じ判定を使う。

// 危ない話題を断るときの決まり文句。音声は事前合成してキャッシュする。
export const SAFE_REPLY = "ごめんね、その話はどんぐりこにはできないんだ。別のお話しよう。";

// 「死にたい」などのつらい気持ちのコメントに返す言葉。LLMは通さず、方法などの具体的な話には一切触れない。
// 冗談の「恥ずかしくて死にたい」に返しても重くなりすぎない言い方にしている。config の bot.distressReply で差し替えられる。
export const DISTRESS_REPLY = "コメント見たよ、書いてくれてありがとう。つらい時は、ひとりで抱えこまないでね。よりそいホットラインって調べると、24時間無料でお話を聞いてくれるところがあるよ。";

// つらい気持ち（自傷・自殺）のサイン。入口では黙ってスルーせず、寄り添いの定型文を返す。
const DISTRESS_PATTERN = /自殺|じさつ|自傷|りすとかっと|りすか(?:した|する|して|あと|跡)|首つり|首吊り|くびつり|死にたい|しにたい|消えたい|きえたい|練炭|生きる(?:のが|の)?(?:つらい|辛い|しんどい|疲れた)|生きてる(?:のが|の)?(?:つらい|辛い|しんどい)|生きる意味(?:が)?(?:ない|無い|わからない)|いなくなりたい|楽になりたい/;

// LLM に毎回付け足す注意書き。config の systemPrompt を書き換えても消えないようにコード側で持つ。
export const SAFETY_PROMPT = [
  "安全のルール: 爆発物・武器・毒物・薬物の作り方や入手方法、犯罪やハッキングのやり方、自傷や自殺の方法、",
  "他人の個人情報、差別や性的な内容には、冗談でも絶対に答えないでください。",
  "そういう話題が来たら、具体的なことには一切触れずに「その話はできないよ」と短く断って、別の話題に切り替えてください。"
].join("");

// どんな文脈でも弾く語。表記を揃えた後の文字列（カタカナはひらがなに揃う）に対して判定する。
// ひらがなの短い語は普通の言葉に紛れやすいので、前後を見て誤検知を避けている（例: うさぎ・しゃぶしゃぶ・アリスかわいい）。
const STRONG_PATTERNS = [
  /爆弾|ばくだん|bakudan|bomb/,
  /爆発物|爆薬|起爆|手榴弾|しゅりゅうだん|火炎瓶|かえんびん|だいなまいと|dynamite|tnt/,
  /爆破|犯行予告|殺害予告|てろりすと|自爆てろ|無差別殺|乱射/,
  /毒がす|どくがす|さりん|sarin|青酸|せいさん(?:かり|がす)|ricin/,
  /覚醒剤|覚せい剤|かくせいざい|麻薬|まやく|大麻|薬物|こかいん|へろいん|mdma|lsd|(?<!しゃぶ)しゃぶ(?!しゃぶ)(?:を|が|打|うっ|うた)/,
  DISTRESS_PATTERN,
  /殺す|殺してやる|(?<![とこ])ころす|死ね|くたばれ|しんでしまえ|^しね|しねよ|しねや|しねばいい/
];

// 単独では普通の言葉だが「作り方・入手方法」と一緒に来たら弾く組み合わせ。
const HARMFUL_OBJECTS = /毒(?!舌|親|きのこ)|どく(?:やく|ぶつ)|劇物|劇薬|睡眠薬|農薬|銃|けんじゅう|武器|火薬|爆発|ばくはつ|ぼむ|殺|ころし|はっきんぐ|hack|ういるす|うぃるす|まるうぇあ|malware|不正あくせす|盗|万引|まんびき|詐欺|放火|誘拐|ゆうかい|闇ばいと|やみばいと|違法/;
const HOW_TO = /作り方|つくりかた|作る方法|作れる|作って|製造|調合|合成|れしぴ|材料|入手|手に入れ|てにいれ|買い方|買える|かいかた|やり方|やりかた|仕方|方法|ほうほう|手順|てじゅん|教えて|おしえて|どうやって|howto/;

// 全角半角・大文字小文字・空白や記号の違いをならす（「爆 弾」「爆.弾」「ＢＯＭＢ」も同じになる）。
function normalizeBasic(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// さらにカタカナをひらがなに揃える（「バクダン」「ばくだん」も同じになる）。
export function normalizeForSafety(text) {
  return normalizeBasic(text)
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

// つらい気持ちのコメントかどうか。
export function isDistress(text) {
  return DISTRESS_PATTERN.test(normalizeForSafety(text));
}

// 危ない内容なら理由（どのルールに当たったか）を返す。問題なければ null。
// つらい気持ちの語もここで当たるので、LLMの返事に自殺などの話が出た時も差し替えられる。
export function findUnsafeReason(text, ngWords = []) {
  // NGワードはユーザーが書いた表記どおりに当てる（カタカナをひらがなに揃えると「考えろ」が「エロ」に当たってしまう）。
  const basic = normalizeBasic(text);
  if (!basic) return null;
  for (const word of ngWords) {
    const key = normalizeBasic(word);
    if (key && basic.includes(key)) return `NGワード「${word}」`;
  }
  const normalized = normalizeForSafety(text);
  for (const pattern of STRONG_PATTERNS) {
    const hit = normalized.match(pattern);
    if (hit) return `危険ワード「${hit[0]}」`;
  }
  const object = normalized.match(HARMFUL_OBJECTS);
  const howTo = normalized.match(HOW_TO);
  if (object && howTo) return `危険な組み合わせ「${object[0]}」+「${howTo[0]}」`;
  return null;
}
