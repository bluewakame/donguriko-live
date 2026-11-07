// Obsidian の個人設定から、今回の質問に近い短い行だけを抜き出す。
// 長期記憶全体は従来どおりプロンプトに含め、この抜粋を回答の直前にも置く。
function normalize(value) {
  const text = String(value ?? "").normalize("NFKC").toLowerCase();
  if (/how old|\bage\b/.test(text)) return "年齢";
  return text
    .replace(/how old|\bage\b/g, "年齢")
    .replace(/who (made|created) you/g, "製作者")
    .replace(/urban legends?/g, "都市伝説")
    .replace(/favo(u)?rite/g, "好き")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function grams(value) {
  const result = new Set();
  for (let i = 0; i < value.length - 1; i += 1) result.add(value.slice(i, i + 2));
  return result;
}

export function relevantMemoryFacts(memoryText, question, limit = 3) {
  const query = normalize(question);
  if (query.length < 2) return [];
  const queryGrams = grams(query);
  const ranked = String(memoryText ?? "").split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("・"))
    .map((line) => {
      const fact = normalize(line);
      let score = 0;
      for (const gram of queryGrams) if (fact.includes(gram)) score += 1;
      if (fact.includes("都市伝説") && !query.includes("都市伝説")) score -= 2;
      return { line, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return [];
  return ranked.filter(({ score }) => score === ranked[0].score)
    .slice(0, limit)
    .map(({ line }) => line);
}

// キャラクターの明示的な個人設定は、生成モデルに任せず記憶の記述から答える。
export function directMemoryReply(memoryText, question) {
  const query = normalize(question);
  if (!/(youtube|ユーチューブ)/.test(query)) return "";
  const facts = relevantMemoryFacts(memoryText, question);
  if (facts.length !== 1 || !/(youtube|ユーチューブ)/.test(normalize(facts[0]))) return "";
  const match = facts[0].replace(/^・/, "").match(/^(.{1,40}?)は(.{1,100})$/);
  if (!match) return "";
  const subject = match[1].trim();
  const answer = match[2].replace(/[。！!]+$/, "").trim();
  if (!subject || !answer) return "";
  return `${subject}は${answer}だよ。`;
}
