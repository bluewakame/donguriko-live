// System One: TypeSafe AI の Jev の考え方を借りた「即答エンジン」。
// 文章を生成せず、決まった型の質問（どの意図か / 考える必要があるか）に確率つきで答えるだけにする。
// 1回の判定は1ms未満で終わるので、自信がある時は用意済みの返事（音声キャッシュ済み）で即答し、
// 自信がない時だけ LLM（System Two）に考えさせる。

export const DEFAULT_INTENTS = {
  greeting: {
    examples: ["こんにちは", "こんばんは", "こんちゃ", "こんばんわ", "こんにちわ", "やっほー", "やほ", "どうも", "おっす", "はろー", "hello", "hi", "hey", "よっ"],
    replies: [
      "やっほー、来てくれてうれしいな。ゆっくりしていってね。",
      "こんにちはー。どんぐりこ、ちゃんと起きてたよ、たぶん。",
      "わーい、あいさつありがとう。今日もいっしょにのんびりしようね。"
    ]
  },
  goodMorning: {
    examples: ["おはよう", "おはようございます", "おは", "おっはー", "good morning"],
    replies: [
      "おはよう。どんぐりこはまだちょっと寝ぼけてるかも、えへへ。",
      "おはようございます。今日もいい一日になるといいね。"
    ]
  },
  firstVisit: {
    examples: ["初見です", "初見", "はじめまして", "初めまして", "初めて来ました", "初めて見ました"],
    replies: [
      "初見さんいらっしゃい。来てくれてありがとう、ゆっくりしていってね。",
      "はじめまして、来てくれてうれしいな。気軽にコメントしてくれるとよろこぶよ。",
      "わっ、初見さんだ。緊張して背筋がのびちゃった。よろしくね。"
    ]
  },
  returning: {
    examples: ["ただいま", "戻りました", "また来たよ", "来たよ", "遊びに来た", "遊びに来たよ", "きたよ"],
    replies: [
      "おかえりなさい。待ってたよ、ほんとだよ。",
      "おかえりー。来てくれてうれしいな、ゆっくりしていってね。"
    ]
  },
  praise: {
    examples: ["かわいい", "可愛い", "かわいいね", "声かわいい", "声が好き", "好き", "大好き", "天才", "えらい", "きれい", "癒される", "いやされる"],
    replies: [
      "えっ、ほんと？ うれしくて顔が熱くなってきちゃった。",
      "えへへ、ありがとう。今のでどんぐりこ、一日がんばれそう。",
      "わわ、照れちゃうよ。もっと言ってくれてもいいんだよ、なんてね。"
    ]
  },
  laugh: {
    examples: ["草", "www", "ww", "笑", "ワロタ", "わろた", "おもしろい", "面白い", "うける", "ウケる"],
    replies: [
      "ふふ、ウケたならよかった。狙ってなかったけどね。",
      "笑ってくれてうれしいな。どんぐりこもつられて笑っちゃう。"
    ]
  },
  applause: {
    examples: ["888", "パチパチ", "ぱちぱち", "すごい", "すごーい", "すげー", "ナイス", "nice", "おめでとう", "おめでと"],
    replies: [
      "わーい、ありがとう。拍手されるとちょっと調子に乗っちゃうよ。",
      "えへへ、ほめられちゃった。もっとがんばるね。"
    ]
  },
  thanks: {
    examples: ["ありがとう", "ありがと", "ありがとうございます", "感謝", "サンキュー", "thanks", "thx", "あざす", "あざーす"],
    replies: [
      "こちらこそありがとう。そう言ってもらえるとすごくうれしいな。",
      "どういたしまして。役に立てたならうれしいよ。"
    ]
  },
  cheer: {
    examples: ["がんばれ", "頑張れ", "がんばって", "頑張って", "応援してる", "応援してます", "ファイト", "負けるな"],
    replies: [
      "応援ありがとう。どんぐりこ、元気百倍になったよ。",
      "がんばるよー。転ばないように気をつけながらね。"
    ]
  },
  otsukare: {
    examples: ["おつかれ", "お疲れ", "お疲れ様", "おつかれさま", "お疲れさまです", "おつ", "乙"],
    replies: [
      "おつかれさま。今日もがんばってえらいね。",
      "おつかれさまー。ゆっくり休んでいってね。"
    ]
  },
  goodnight: {
    examples: ["おやすみ", "おやすみなさい", "寝ます", "そろそろ寝る", "寝るね", "もう寝る"],
    replies: [
      "おやすみなさい。いい夢見てね、どんぐりこも夢に出ちゃうかも。",
      "おやすみー。今日も来てくれてありがとう、あったかくして寝てね。"
    ]
  },
  bye: {
    examples: ["またね", "ばいばい", "バイバイ", "じゃあね", "落ちます", "また来るね", "また来ます", "そろそろ行くね"],
    replies: [
      "またねー。来てくれてありがとう、また遊びに来てね。",
      "ばいばい。次も待ってるからね、忘れないでね。"
    ]
  }
};

// LLM が考えている間に、先に流す短い相づち。音声キャッシュ済みのものだけ使う。
export const DEFAULT_FILLERS = {
  question: ["ふむふむ。", "えっとね。", "なるほど、ちょっと待ってね。", "おっ、いい質問。"],
  statement: ["おっ。", "ほうほう。", "なるほどね。", "へえー。"]
};

const QUESTION_WORDS = /(何|なに|なん[でだの]|どう|どこ|どれ|どっち|どの|だれ|誰|いつ|いくつ|なぜ|教えて|おしえて|おすすめ|オススメ|知って|できる|ですか|ますか|かな[?？]?$|の[?？]|って[?？]|とは)/;
const NEGATION = /(ない|なかった|じゃない|くない|嫌い|きらい|つまらない|つまんない|やめて|下手|へた|うざ)/;
const CONTEXT_REF = /(さっき|前の|それ|これ|あれ|続き|その話|さきほど|先ほど|今言った|前言った|どういうこと)/;

export function createSystemOne(options = {}) {
  const settings = {
    enabled: options.enabled ?? true,
    minConfidence: Number(options.minConfidence ?? 0.72),
    maxThinkProbability: Number(options.maxThinkProbability ?? 0.5),
    maxFastCommentChars: Number(options.maxFastCommentChars ?? 24),
    otherScore: Number(options.otherScore ?? 0.5),
    temperature: Number(options.temperature ?? 0.07),
    ignoreWords: options.ignoreWords ?? ["どんぐりこ", "ドングリコ", "donguriko", "ちゃん", "さん", "さま", "様"]
  };
  const intents = mergeIntents(DEFAULT_INTENTS, options.intents);
  const fillers = {
    question: nonEmptyList(options.fillers?.question, DEFAULT_FILLERS.question),
    statement: nonEmptyList(options.fillers?.statement, DEFAULT_FILLERS.statement)
  };
  const normalizeForMatch = (text) => normalize(text, settings.ignoreWords);
  const prototypes = Object.entries(intents).map(([name, intent]) => ({
    name,
    examples: intent.examples
      .map((example) => normalizeForMatch(example))
      .filter(Boolean)
      .map((text) => ({ text, grams: charGrams(text) }))
  }));
  const recentPicks = new Map();

  // Jev の Choice / Noul に相当する型つきの質問を、同じコメントに対してまとめて評価する。
  function decide(rawText) {
    const started = performance.now();
    const text = String(rawText ?? "");
    const normalized = normalizeForMatch(text);
    const intent = chooseIntent(normalized);
    const needsThinking = judgeNeedsThinking(text, normalized);
    const isQuestion = judgeQuestion(text);
    const fast = settings.enabled
      && intent.choice !== "other"
      && intent.confidence >= settings.minConfidence
      && needsThinking.probability < settings.maxThinkProbability
      && [...text].length <= settings.maxFastCommentChars;
    return {
      intent,
      needsThinking,
      isQuestion,
      route: fast ? "system-one" : "system-two",
      ms: Number((performance.now() - started).toFixed(3))
    };
  }

  function chooseIntent(normalized) {
    const scores = { other: settings.otherScore };
    for (const proto of prototypes) {
      scores[proto.name] = normalized ? Math.max(0, ...proto.examples.map((example) => similarity(normalized, example))) : 0;
    }
    const probabilities = softmax(scores, settings.temperature);
    const [choice, confidence] = Object.entries(probabilities).reduce((best, entry) => entry[1] > best[1] ? entry : best);
    return { choice, confidence: round(confidence), probabilities: roundAll(probabilities) };
  }

  function judgeNeedsThinking(text, normalized) {
    const length = [...normalized].length;
    const signals = {
      questionMark: /[?？]/.test(text) ? 0.55 : 0,
      questionWord: QUESTION_WORDS.test(text) ? 0.45 : 0,
      negation: NEGATION.test(text) ? 0.6 : 0,
      contextRef: CONTEXT_REF.test(text) ? 0.35 : 0,
      length: length > 12 ? Math.min(0.5, (length - 12) * 0.04) : 0
    };
    const probability = 1 - Object.values(signals).reduce((keep, p) => keep * (1 - p), 1);
    return { probability: round(probability), signals };
  }

  function judgeQuestion(text) {
    return /[?？]/.test(text) || QUESTION_WORDS.test(text);
  }

  function pickReply(intentName) {
    return pickFresh(`intent:${intentName}`, intents[intentName]?.replies ?? []);
  }

  function pickFiller(decision, isCached = () => true) {
    const pool = (decision?.isQuestion ? fillers.question : fillers.statement).filter(isCached);
    return pickFresh(`filler:${decision?.isQuestion ? "q" : "s"}`, pool);
  }

  // 同じ返事が続かないように、直前に使ったものは避けて選ぶ。
  function pickFresh(key, pool) {
    if (pool.length === 0) return "";
    const last = recentPicks.get(key);
    const candidates = pool.length > 1 ? pool.filter((item) => item !== last) : pool;
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    recentPicks.set(key, picked);
    return picked;
  }

  function allPhrases() {
    return [
      ...Object.values(intents).flatMap((intent) => intent.replies),
      ...fillers.question,
      ...fillers.statement
    ];
  }

  return { decide, pickReply, pickFiller, allPhrases, settings };
}

function mergeIntents(base, override) {
  const merged = {};
  for (const [name, intent] of Object.entries(base)) {
    merged[name] = { examples: [...intent.examples], replies: [...intent.replies] };
  }
  for (const [name, intent] of Object.entries(override ?? {})) {
    if (intent === null || intent === false) {
      delete merged[name];
      continue;
    }
    merged[name] = {
      examples: nonEmptyList(intent?.examples, merged[name]?.examples ?? []),
      replies: nonEmptyList(intent?.replies, merged[name]?.replies ?? [])
    };
    if (merged[name].examples.length === 0 || merged[name].replies.length === 0) delete merged[name];
  }
  return merged;
}

function nonEmptyList(value, fallback) {
  return Array.isArray(value) && value.length > 0 ? value.map(String) : [...fallback];
}

export function normalize(text, ignoreWords = []) {
  let out = String(text ?? "").normalize("NFKC").toLowerCase();
  for (const word of ignoreWords) {
    if (word) out = out.replaceAll(String(word).normalize("NFKC").toLowerCase(), "");
  }
  return out
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[\s!！?？。、,.・~〜ー\-_…「」『』()（）【】♪☆★♡♥]/g, "")
    .replace(/(.)\1{2,}/g, "$1$1");
}

function charGrams(text) {
  const chars = [...text];
  const grams = new Map();
  const add = (gram) => grams.set(gram, (grams.get(gram) ?? 0) + 1);
  chars.forEach((ch) => add(ch));
  for (let i = 0; i < chars.length - 1; i += 1) add(chars[i] + chars[i + 1]);
  return grams;
}

// 「例文がどれだけコメント全体を占めているか」と、表記ゆれ用の文字 n-gram コサイン類似度（二乗して弱める）の大きい方。
// 「ポケモン好き」は「好き」を含んでも占有率が低いので、ほめ言葉とは判定しない。
function similarity(normalized, example) {
  const commentLength = [...normalized].length;
  const exampleLength = [...example.text].length;
  const coverage = normalized.includes(example.text) ? 0.2 + 0.8 * (exampleLength / commentLength) : 0;
  return Math.max(coverage, cosine(charGrams(normalized), example.grams) ** 2);
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [gram, count] of a) {
    normA += count * count;
    dot += count * (b.get(gram) ?? 0);
  }
  for (const count of b.values()) normB += count * count;
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function softmax(scores, temperature) {
  const entries = Object.entries(scores);
  const max = Math.max(...entries.map(([, score]) => score));
  const exps = entries.map(([name, score]) => [name, Math.exp((score - max) / temperature)]);
  const total = exps.reduce((sum, [, value]) => sum + value, 0);
  return Object.fromEntries(exps.map(([name, value]) => [name, value / total]));
}

function round(value) {
  return Number(value.toFixed(3));
}

function roundAll(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, round(value)]));
}
