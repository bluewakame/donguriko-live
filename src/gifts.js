// TikTok のギフトを日本語の名前にし、ギフトごと・金額ごとにどんぐりこの反応を変える。
// TikTok からはギフト名が英語で届くので、ここの一覧で日本語に直してから LLM に渡す。
// 一覧にないギフトは届いた名前のまま使う。config.json の tiktok.gifts で追加・上書きできる。

// name: 読み上げる日本語名 / note: そのギフトならではの反応（なくてもよい）
const DEFAULT_GIFTS = {
  "Rose": { name: "バラ", note: "バラの花をもらったので、花をもらった喜びに触れてください。" },
  "TikTok": { name: "TikTok", note: "" },
  "GG": { name: "GG", note: "「GG（いい勝負）」のギフトなので、ノリよく返してください。" },
  "Heart": { name: "ハート", note: "ハートをもらったので、照れながら喜んでください。" },
  "Heart Me": { name: "ハートミー", note: "ハートをもらったので、照れながら喜んでください。" },
  "Love you": { name: "ラブユー", note: "「大好き」と言われたので、照れながら喜んでください。" },
  "Finger Heart": { name: "指ハート", note: "指ハートをもらったので、指ハートを返すつもりで喜んでください。" },
  "Hand Hearts": { name: "手でハート", note: "手でハートを作ってもらったので、照れながら喜んでください。" },
  "Hearts": { name: "ハートいっぱい", note: "ハートをたくさんもらったので、照れながら喜んでください。" },
  "Thumbs Up": { name: "いいね", note: "いいねをもらったので、元気よく喜んでください。" },
  "Ice Cream Cone": { name: "アイスクリーム", note: "アイスをもらったので、食べるつもりで味や冷たさに触れてください。" },
  "Doughnut": { name: "ドーナツ", note: "ドーナツをもらったので、食べるつもりで喜んでください。" },
  "Donut": { name: "ドーナツ", note: "ドーナツをもらったので、食べるつもりで喜んでください。" },
  "Cake": { name: "ケーキ", note: "ケーキをもらったので、食べるつもりで喜んでください。" },
  "Perfume": { name: "香水", note: "香水をもらったので、いい香りに触れてください。" },
  "Friendship Necklace": { name: "友情のネックレス", note: "友情のネックレスをもらったので、仲良しになれた喜びに触れてください。" },
  "Rosa": { name: "ローザ（バラの花束）", note: "バラの花束をもらったので、花をもらった喜びに触れてください。" },
  "Paper Crane": { name: "折り鶴", note: "折り鶴をもらったので、丁寧に折ってくれたことに触れてください。" },
  "Little Crown": { name: "小さな王冠", note: "王冠をもらったので、ちょっとお姫様気分で喜んでください。" },
  "Cap": { name: "キャップ", note: "帽子をもらったので、かぶってみるつもりで喜んでください。" },
  "Hat and Mustache": { name: "帽子とおひげ", note: "帽子とおひげをもらったので、変装するつもりで楽しく返してください。" },
  "Confetti": { name: "紙吹雪", note: "紙吹雪でお祝いしてもらったので、パーティー気分で喜んでください。" },
  "Sunglasses": { name: "サングラス", note: "サングラスをもらったので、ちょっとかっこつけて返してください。" },
  "Corgi": { name: "コーギー", note: "コーギー（犬）をもらったので、かわいさに触れてください。" },
  "Money Gun": { name: "マネーガン", note: "お札がばらまかれるギフトなので、びっくりしながら喜んでください。" },
  "Swan": { name: "白鳥", note: "白鳥をもらったので、きれいさに触れてください。" },
  "Train": { name: "汽車", note: "汽車がやって来たので、乗り込むつもりで楽しく返してください。" },
  "Galaxy": { name: "ギャラクシー", note: "銀河をもらったので、宇宙のきらきらに触れてください。" },
  "Fireworks": { name: "花火", note: "花火が上がったので、見上げるつもりで喜んでください。" },
  "Gold Mine": { name: "金鉱", note: "金鉱をもらったので、宝物を見つけたように喜んでください。" },
  "Chasing the Dream": { name: "夢を追いかけて", note: "「夢を追いかけて」のギフトなので、応援してもらえた喜びに触れてください。" },
  "Whale diving": { name: "クジラのダイブ", note: "クジラが飛び込んできたので、その迫力に触れてください。" },
  "Motorcycle": { name: "バイク", note: "バイクをもらったので、乗るつもりで喜んでください。" },
  "Private Jet": { name: "プライベートジェット", note: "プライベートジェットをもらったので、旅に出るつもりで大喜びしてください。" },
  "Sports Car": { name: "スポーツカー", note: "スポーツカーをもらったので、運転するつもりで大喜びしてください。" },
  "Falcon": { name: "ハヤブサ", note: "ハヤブサが飛んできたので、そのかっこよさに触れてください。" },
  "Interstellar": { name: "インターステラー", note: "宇宙船のギフトなので、宇宙へ行くつもりで大喜びしてください。" },
  "Rocket": { name: "ロケット", note: "ロケットが打ち上がったので、宇宙へ行くつもりで大喜びしてください。" },
  "Lion": { name: "ライオン", note: "ライオンがやって来たので、その迫力に触れてください。" },
  "TikTok Universe": { name: "TikTokユニバース", note: "最大級のギフトなので、信じられないくらい驚いてください。" },
  "Universe": { name: "ユニバース", note: "最大級のギフトなので、信じられないくらい驚いてください。" }
};

// 贈ってくれた合計ダイヤ数に合わせて、喜び方の大きさを変える。
const GIFT_TIERS = [
  { minDiamonds: 1000, note: "とても大きなギフトです。びっくりして、大喜びで心からお礼を言ってください。" },
  { minDiamonds: 100, note: "大きめのギフトです。とても喜んで、しっかりお礼を言ってください。" },
  { minDiamonds: 10, note: "うれしそうにお礼を言ってください。" },
  { minDiamonds: 0, note: "小さなギフトです。軽く、かわいくお礼を言ってください。" }
];

export function normalizeGiftConfig(tiktok) {
  const custom = tiktok.gifts && typeof tiktok.gifts === "object" ? tiktok.gifts : {};
  tiktok.gifts = custom;
  return tiktok;
}

// ギフトの英語名から、日本語名と LLM に渡す反応の指示を作る。
export function describeGift(customGifts, rawName, count, diamonds) {
  const known = findGift(customGifts, rawName);
  const name = known?.name || rawName || "ギフト";
  const tier = GIFT_TIERS.find((item) => diamonds >= item.minDiamonds) ?? GIFT_TIERS.at(-1);
  const repeat = count > 1 ? `${count}個も続けて贈ってくれました。` : "";
  const note = [
    `この視聴者が${known || rawName ? `ギフト「${name}」` : "ギフト（投げ銭）"}を贈ってくれました。${repeat}`,
    known?.note ?? "",
    tier.note,
    known ? "ギフト名は英語にせず、この日本語の名前で呼んでください。" : ""
  ].filter(Boolean).join("");
  return { name, note };
}

// 大文字・小文字や空白の違いでは見落とさないようにする。config の指定を優先する。
function findGift(customGifts, rawName) {
  const key = String(rawName ?? "").trim();
  if (!key) return undefined;
  const lower = key.toLowerCase().replace(/\s+/g, " ");
  for (const table of [customGifts ?? {}, DEFAULT_GIFTS]) {
    const match = table[key] ? key : Object.keys(table).find((name) => name.toLowerCase().replace(/\s+/g, " ") === lower);
    // config では "Rose": "バラ" のように名前だけでも書ける。
    if (match) return typeof table[match] === "string" ? { name: table[match] } : table[match];
  }
  return undefined;
}
