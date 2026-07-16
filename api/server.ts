import express from "express";
import path from "path";
import OpenAI from "openai";
import webpush from "web-push";
import dotenv from "dotenv";
import { kv } from "@vercel/kv";
import {
  buildMatsuyaIntentInstructions,
  detectMatsuyaBeefYakinikuIntent,
  isMatsuyaWebResultCompatible,
  normalizeMatsuyaRiceResult,
  type MatsuyaBeefYakinikuIntent,
} from "./meal-estimate-helpers.js";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 外部検索が必要かキーワードで判定（直近5件の履歴も含めてチェック）
function shouldUseWebSearch(message: string, history: any[]): boolean {
  const allText = [message, ...history.slice(-5).map((m: any) => m.text || '')].join(' ');
  const triggers = [
    '知ってる', 'この人誰', '誰この', '何位', '実績', 'instagram', 'インスタ', 'フォロワー',
    '順位', '成績', '出場歴', '近況', '何者', '有名', '大会の結果',
    '最近どう', '最近どんな', 'ランキング', '何勝', '優勝歴',
  ];
  return triggers.some((t) => allText.toLowerCase().includes(t.toLowerCase()));
}

// 料理名推定でWeb検索に切り替えるべきチェーン・ブランド名（公式栄養成分が存在しやすいもの）
const KNOWN_CHAIN_NAMES = [
  '松屋', 'すき家', '吉野家', 'なか卯',
  'マクドナルド', 'モスバーガー', 'バーガーキング', 'ロッテリア', 'ケンタッキー', 'kfc',
  'セブンイレブン', 'セブン-イレブン', 'セブン', 'ローソン', 'ファミリーマート', 'ファミマ',
  '丸亀製麺', 'はなまるうどん', 'リンガーハット', '富士そば', 'ゆで太郎',
  '一風堂', '天下一品', '日高屋', 'coco壱番屋', 'ココイチ',
  'ドミノピザ', 'ピザハット', 'ピザーラ',
  'かつや', 'さぼてん',
  'スシロー', 'くら寿司', 'はま寿司', 'かっぱ寿司',
  'ガスト', 'サイゼリヤ', 'バーミヤン', 'ジョナサン', 'デニーズ', 'ロイヤルホスト',
  'やよい軒', '大戸屋',
  'スターバックス', 'スタバ', 'ドトール', 'タリーズ',
  'ミスタードーナツ', 'ミスド',
  'サブウェイ', '牛角', 'いきなりステーキ', '餃子の王将', '鳥貴族',
];

// 通称・略称・英語表記 → チェーンの正式名称。分類・検索クエリ補正の両方で使う
const BRAND_ALIASES: Record<string, string> = {
  'マック': 'マクドナルド',
  'マクド': 'マクドナルド',
  "mcdonald's": 'マクドナルド',
  'mcdonalds': 'マクドナルド',
};

function findMatchedChain(name: string): string | null {
  const lower = name.toLowerCase();
  const candidates = [...KNOWN_CHAIN_NAMES, ...Object.keys(BRAND_ALIASES)];
  const matched = candidates.find((chain) => lower.includes(chain.toLowerCase()));
  if (!matched) return null;
  return BRAND_ALIASES[matched.toLowerCase()] || matched;
}

function isChainMealName(name: string): boolean {
  return findMatchedChain(name) !== null;
}

// ユーザーが使いがちな通称を、ブランドの公式メニュー表記に寄せて検索精度を上げる（表示名は変えない）
// 商品名は季節限定・改名が多く際限なく増えるため、ここでは特に検索が外れやすい定番のみ登録し、
// それ以外はestimateMealViaWebSearchのプロンプトでAI自身に公式表記への近似を任せる
const BRAND_QUERY_SYNONYMS: Record<string, { pattern: RegExp; replacement: string }[]> = {
  '松屋': [{ pattern: /牛丼/g, replacement: '牛めし' }],
  'マクドナルド': [{ pattern: /(?<!マックフライ)ポテト/g, replacement: 'マックフライポテト' }],
};

function buildSearchQueryHint(name: string, matchedChain: string): string {
  let query = name;

  // 通称（マック等）を正式名称に置き換える。
  // 正式名称が既に含まれる場合は何もしない（「マクドナルド」に「マクド」が前方一致して二重展開されるのを防ぐ）。
  // 置換は「別名の直後が空白または文末」の場合のみ行う（「マックフライポテト」のように、
  // 公式商品名自体が別名を接頭辞に持つケースを誤って壊さないため）。
  if (!query.includes(matchedChain)) {
    const aliasesForChain = Object.keys(BRAND_ALIASES)
      .filter((alias) => BRAND_ALIASES[alias] === matchedChain)
      .sort((a, b) => b.length - a.length);
    for (const alias of aliasesForChain) {
      const boundaryPattern = new RegExp(`${alias}(?=\\s|$)`, 'gi');
      if (boundaryPattern.test(query)) {
        query = query.replace(boundaryPattern, matchedChain);
        break;
      }
    }
  }

  const synonyms = BRAND_QUERY_SYNONYMS[matchedChain];
  if (synonyms) {
    for (const { pattern, replacement } of synonyms) {
      query = query.replace(pattern, replacement);
    }
  }
  return `${query} 栄養成分 カロリー PFC`;
}

// テキストからJSON部分だけを抜き出してパースする（Web検索応答は説明文が混ざることがあるため）
function extractJson(text: string): any {
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* fallthrough */ }
  }
  return {};
}

type MealEstimateSource = {
  sourceType: 'official' | 'web' | 'ai_estimate';
  sourceLabel?: string;
  sourceUrl?: string;
};

// Web検索結果のsourceTypeを検証：URL・ラベルが明確でない限りofficialを名乗らせない
// このキーワードを含まないラベルは「栄養成分そのもの」ではなく商品紹介ページ等の可能性が高いため official と認めない
const NUTRITION_LABEL_KEYWORDS = ['栄養成分', '栄養価', 'カロリー', 'nutrition'];

function resolveWebSource(parsed: any): MealEstimateSource {
  const url = typeof parsed.sourceUrl === 'string' && /^https?:\/\//.test(parsed.sourceUrl.trim())
    ? parsed.sourceUrl.trim().slice(0, 300)
    : undefined;
  const label = typeof parsed.sourceLabel === 'string' && parsed.sourceLabel.trim()
    ? parsed.sourceLabel.trim().slice(0, 60)
    : undefined;

  const looksLikeNutritionSource = !!label && NUTRITION_LABEL_KEYWORDS.some((k) => label.toLowerCase().includes(k.toLowerCase()));

  if (parsed.sourceType === 'official' && url && label && looksLikeNutritionSource) {
    return { sourceType: 'official', sourceLabel: label, sourceUrl: url };
  }

  // 公式を名乗っているが根拠が栄養成分ページと確認できない場合（商品紹介ページ等）は、
  // 栄養成分そのものを参照したように見せないよう、ラベルを商品ページとして明示した上でwebへ格下げする
  if (url && label && !looksLikeNutritionSource) {
    return { sourceType: 'web', sourceLabel: `${label}（栄養成分ページではなく商品ページの可能性）`, sourceUrl: url };
  }

  return { sourceType: 'web', sourceLabel: label, sourceUrl: url };
}

function isOfficialMatsuyaSource(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'matsuyafoods.co.jp'
      || hostname.endsWith('.matsuyafoods.co.jp')
      || hostname === 'matsuyafoods.jp'
      || hostname.endsWith('.matsuyafoods.jp');
  } catch {
    return false;
  }
}

// 料理名推定の数値検証・整形（AI推定・Web検索どちらの結果にも共通で使う）
// 小数第1位までを保持する（UI表示側でMath.roundするため、ここでは整数に丸めすぎない）
const round1 = (v: number): number => Math.round(v * 10) / 10;

function buildMealEstimatePayload(parsed: any, source: MealEstimateSource, noteOverride?: string): any | null {
  const calories = round1(parseFloat(parsed.calories) || 0);
  const protein  = round1(parseFloat(parsed.protein)  || 0);
  const fat      = round1(parseFloat(parsed.fat)      || 0);
  const carbs    = round1(parseFloat(parsed.carbs)    || 0);

  if (parsed.error || parsed.notFound || !parsed.name || calories <= 0 || calories > 5000) {
    return null;
  }

  // PFC×カロリー整合チェックはAI推定のときだけ行う。
  // 公式表・Web参照で見つかった数値は、多少の丸め誤差があってもそのまま優先し、AIが再計算・補正しない
  let finalCalories = calories;
  if (source.sourceType === 'ai_estimate') {
    const pfcCalories = protein * 4 + fat * 9 + carbs * 4;
    finalCalories = pfcCalories > 0 && Math.abs(pfcCalories - calories) / calories > 0.25
      ? round1(pfcCalories)
      : calories;
  }

  const confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';

  // servingOptions を検証し、不正なら基準量ベースのデフォルトにフォールバック
  let servingOptions: { label: string; multiplier: number }[] = Array.isArray(parsed.servingOptions)
    ? parsed.servingOptions
        .filter((o: any) => o && typeof o.label === 'string' && parseFloat(o.multiplier) >= 0.25 && parseFloat(o.multiplier) <= 3)
        .map((o: any) => ({ label: String(o.label).slice(0, 20), multiplier: parseFloat(o.multiplier) }))
        .slice(0, 6)
    : [];
  if (!servingOptions.some(o => o.multiplier === 1)) {
    const base = String(parsed.baseAmount || "1人前");
    servingOptions = [
      { label: `少なめ 0.7${base.replace(/^1/, '')}`, multiplier: 0.7 },
      { label: `普通 ${base}`, multiplier: 1 },
      { label: `大盛り 1.3${base.replace(/^1/, '')}`, multiplier: 1.3 },
      { label: `特盛 1.5${base.replace(/^1/, '')}`, multiplier: 1.5 },
    ];
  }

  const defaultNote = source.sourceType === 'ai_estimate'
    ? "一般的な1人前を基準にしたAI推定です。実際の量・具材によって変動します。"
    : "Web上の情報を参照した目安です。店舗や時期により変動する場合があります。";

  return {
    name: String(parsed.name).slice(0, 50),
    baseAmount: String(parsed.baseAmount || "1人前").slice(0, 20),
    calories: finalCalories,
    protein,
    fat,
    carbs,
    confidence,
    sourceType: source.sourceType,
    sourceLabel: source.sourceLabel,
    sourceUrl: source.sourceUrl,
    note: String(noteOverride || parsed.note || defaultNote).slice(0, 120),
    servingOptions,
  };
}

// 検索→公式表から該当行を特定→転記、という多段タスクはminiでは取りこぼしが多く
// notFoundフォールバックが頻発したため、料理名推定と同じ高精度モデルに揃える
const ESTIMATE_MEAL_SEARCH_MODEL = "gpt-4o";

// チェーン・ブランド商品名の場合のみ使うWeb検索ベースの推定（公式栄養成分ページを優先）
async function estimateMealViaWebSearch(
  openai: OpenAI,
  name: string,
  searchQueryHint: string,
  matsuyaIntent: MatsuyaBeefYakinikuIntent | null = null,
): Promise<any | null> {
  const matsuyaInstructions = buildMatsuyaIntentInstructions(matsuyaIntent);
  const instructions = `あなたは日本のチェーン店・ブランド商品の栄養成分を調べるアシスタントです。ウェブ検索が使えます。

【手順】
1. まず「ブランド名 栄養成分 一覧」のようなキーワードで、公式サイト内の栄養成分・カロリー一覧ページ（表形式でカロリー・PFCが並んでいるページ）を探す。個別商品の紹介・購入ページ（価格や商品説明が中心で、栄養成分表が無いページ）は根拠にしない
2. 一覧ページが見つかったら、その中から該当商品の数値を探す。ユーザーの入力表現（例：「牛丼」）とブランドの公式メニュー表記（例：「牛めし」）が違う場合があるので、検索キーワードを参考に該当商品を特定する
3. 【重要】1回の検索で見つからなくても諦めない。少なくとも2〜3通りのキーワードで再検索する。例：「ブランド名 栄養成分 一覧」→「ブランド名 商品名 カロリー」→「商品名 kcal たんぱく質」。定食・セット系は公式の栄養成分表に商品単位（ライス・味噌汁込み）で載っていることが多いので、その行を探す
4. それでも一致しない場合、あなた自身の知識でそのブランドの現行の公式メニュー名に近いものを推測し、それで再検索してよい（略称・愛称的な言い方をされることが多いため）。ただし確信が持てない場合は無理に断定せず、confidence:"low"で正直に扱う
5. 数値が見つかった場合は、そのページに書かれているkcal・P・F・Cの4つをすべて同じ行・同じ商品から転記する。改変・四捨五入以外の加工・推測補完は禁止
6. 【最重要】kcalは見つかったがP・F・Cのいずれかが同じ場所に載っていない場合、他の栄養素だけをあなたの知識で計算・推測してはいけない。P4+F9+C×4とkcalが多少ズレていても、表に書かれている数値をそのまま使う（例：食物繊維や丸め処理の影響で厳密には一致しないことがあるが、それは正常であり補正しない）
7. kcalとPFCが同じ情報源から4つとも揃わない場合は、その商品については確信を持てないものとして扱い、sourceTypeを"web"にする（4つのうち一部だけを表から、残りをAIの推測で埋めるという混在は絶対にしない）
8. 栄養成分の一覧・表そのものが見つからず、商品紹介ページやレビュー・まとめサイトの情報しかない場合でも、そこに4つの数値が揃っているならsourceType:"web"として返す（"official"にしない）。notFoundは「複数回検索しても数値が4つ揃う情報源が1つも無い」場合の最後の手段
9. 本当に何も有効な情報が見つからない場合のみ、他の項目を含めず {"notFound":true} とだけ返す。曖昧な情報しかない場合に無理に数値を作らない

【複数商品が含まれる場合（最重要）】
- 入力にメイン商品（バーガー等）とサイド（ポテト・ドリンク等）が複数含まれていそうな場合、必ずそれぞれの商品を個別に検索し、各商品の公式カロリー・PFCを1つずつ確認してから合算する
- 「〇〇セット」のようにあらかじめ組み合わされたセット単位の合計値だけが載っているページを見つけても、ユーザーの入力に「セット」という語がない限りそれをそのまま使ってはいけない。必ず商品単位の数値を個別に足し上げる
- 合算した場合、nameには含めた商品を列挙し、noteに内訳（各商品名と各数値、または合算した旨）を必ず明記する。例：「炙り醤油風 ダブル肉厚ビーフ＋マックフライポテトMを合算した目安です。ドリンクは含みません。」
- サイドメニューのサイズが指定されていない場合はMサイズを仮定してよいが、その旨を必ずnoteに明記する（例：「ポテトはMサイズを想定」）
- 入力に「セット」という語が含まれない場合、ドリンクやセット単位の栄養成分は絶対に含めない（単品の合算として扱う）
- 「セット」と書かれているがドリンクの種類が指定されていない場合、ドリンクは含めずnoteに「ドリンクは含んでいません（未指定のため）」のように明記する
- noteには最後に「店舗や時期により変動する場合があります。」を添える

【sourceType のルール】
- 公式サイトの「栄養成分一覧・カロリー表」そのものが根拠 → "official"（sourceUrlはその一覧ページ、sourceLabelは「〇〇公式 栄養成分情報」のように具体的に）
- 公式の商品紹介ページ（栄養成分表が無い）や、非公式のWeb情報が根拠 → "web"（sourceLabelは「〇〇公式 商品ページ」や「〇〇に関するWeb情報」のように、栄養成分そのものではないと分かる表現にする）
- sourceUrl・sourceLabelが明確でない場合は絶対に"official"にしない
- 少しでも根拠が薄い・ページの種類に自信が持てない場合は"official"を避け"web"にする（安全側に倒す）

【出力ルール】
- nameはユーザーの入力表現に近い形で整える（公式表記に無理に書き換えない）
- baseAmountは「1食」「1人前」など短い表記
- confidenceは high/medium/low
- servingOptionsは3〜5個、multiplier1（基準量）を必ず含める
${matsuyaInstructions}

ユーザー入力：「${name.slice(0, 60)}」
検索キーワード（この表記を出発点にすること。一致しなければ自分の知識で公式名称に近づけて再検索してよい）：「${searchQueryHint}」

必ず以下のJSON形式のみで返してください（説明文・マークダウンのコードフェンス禁止）：
{"name":"整えた商品名","baseAmount":"1食","calories":数値,"protein":数値,"fat":数値,"carbs":数値,"confidence":"high|medium|low","sourceType":"official|web","sourceLabel":"短い説明","sourceUrl":"https://...","note":"短い注記","servingOptions":[{"label":"1食","multiplier":1}],"matchedVariant":"該当時のみ指定された区分","calculationMethod":"exact_product_row|combined_components"}`;

  const response = await openai.responses.create({
    model: ESTIMATE_MEAL_SEARCH_MODEL,
    tools: [{ type: 'web_search_preview' }],
    instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: `検索キーワード：${searchQueryHint}` }] }],
  });

  const rawText = response.output_text || '';
  const parsed = extractJson(rawText);
  if (!parsed || parsed.notFound) return null;
  if (!isMatsuyaWebResultCompatible(parsed, matsuyaIntent)) {
    console.warn(`Rejected mismatched Matsuya estimate: requested=${matsuyaIntent?.variant}, returned=${parsed?.matchedVariant}`);
    return null;
  }

  let source = resolveWebSource(parsed);
  const riceNormalization = normalizeMatsuyaRiceResult(parsed, matsuyaIntent);
  if (riceNormalization.forceWeb) {
    source = { ...source, sourceType: 'web' };
  }
  if (matsuyaIntent && source.sourceType === 'official' && !isOfficialMatsuyaSource(source.sourceUrl)) {
    source = {
      ...source,
      sourceType: 'web',
      sourceLabel: source.sourceLabel
        ? `${source.sourceLabel}（松屋公式ドメインと確認できないため参考情報として表示）`
        : undefined,
    };
  }

  // "official"を名乗っている場合でも、実際にそのURLへアクセスして栄養成分らしき記載があるか確認する。
  // モデルの自己申告（sourceLabel）だけでは、実際は商品紹介ページでも「栄養成分情報」と誤ラベルされることがあるため
  if (source.sourceType === 'official' && source.sourceUrl) {
    const verified = await verifyOfficialNutritionSource(source.sourceUrl);
    if (!verified) {
      source = {
        sourceType: 'web',
        sourceLabel: source.sourceLabel ? `${source.sourceLabel}（内容を確認できなかったため参考情報として表示）` : undefined,
        sourceUrl: source.sourceUrl,
      };
    }
  }

  return buildMealEstimatePayload(parsed, source, riceNormalization.noteOverride);
}

// sourceUrlに実際にアクセスし、栄養成分らしき記載（kcal・PFC等のキーワード）があるかを確認する。
// タイムアウト・取得失敗時は「確認できなかった」として安全側（web扱い）に倒す
async function verifyOfficialNutritionSource(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return false;
    const text = (await response.text()).slice(0, 30000);
    return /kcal|カロリー|栄養成分|たんぱく質|タンパク質|脂質|炭水化物/i.test(text);
  } catch {
    return false;
  }
}

// Responses API（web_search_preview）を使った検索ルート
async function handleSearchQuery(
  message: string,
  images: any[],
  history: any[],
  userData: any,
): Promise<{ text: string; exercises: any[] }> {
  const instructions = `あなたはフィットネス・筋トレに詳しいAIトレーナーです。ウェブ検索が使えます。

【検索のルール】
- フィットネス選手・アスリートの大会結果・実績・近況・SNS情報など外部確認が必要な質問のみ検索する
- 検索クエリ例：「田口純平 フィジーク 大会 結果」「田口純平 JBBF FWJ 順位」
- 公式リザルト・本人SNS投稿を優先して確認する
- 情報が複数ある場合は複数回検索してよい

【情報の扱い方：3種類を必ず分ける】
A. 画像から見えること → 断定OK（「肩の発達が目立ちます」等）
B. 検索で見つかった情報 → 出典を明示する（「〇〇大会の公式リザルトでは」等）
C. AIの推測 → 「〜に見えます」「〜かもしれません」と必ず明示する

【返答フォーマット】
検索で情報が見つかった場合：
「〇〇さんの大会結果ですね。確認できた情報では、〇〇大会の〇〇クラスで〇位という情報があります。ただし公式リザルトと本人投稿で内容が異なる場合もあるので、最終確認は公式結果を見るのが確実です。画像を見る限り、〇〇が目立ちます。」

検索しても情報が見つからなかった場合：
「〇〇さんの情報を調べましたが、公式リザルトとして確認できる情報は見つかりませんでした。本人のInstagramや大会公式ページ（JBBF・FWJ・APF等）を確認すると正確に分かります。画像から見る限り、〇〇に見えます。」

【禁止事項】
- 検索していないのに「検索しました」と言う
- 画像だけで順位・大会名・クラスを断定する
- ユーザーの「〜らしい」を事実として断定する
- 根拠のない大会結果を作る
- 出典なしで最新情報を断定する

【会話スタイル】
- 2〜5文で自然に返す
- 名前で呼びかけない
- テンションを上げすぎない
- AIトレーナーとして体型コメントも自然に添える

【ユーザー情報】
体重: ${userData?.weight || "未測定"}kg（目標: ${userData?.targetWeight || "未設定"}kg）`;

  const inputMessages: any[] = [];
  if (Array.isArray(history) && history.length > 0) {
    history.slice(-8).forEach((msg: any) => {
      if (msg.role === 'user') {
        inputMessages.push({ role: 'user', content: msg.text || '' });
      } else if (msg.role === 'assistant') {
        inputMessages.push({ role: 'assistant', content: msg.text || '' });
      }
    });
  }

  const currentContent: any[] = [];
  if (images && images.length > 0) {
    images.forEach((img: string) => {
      const base64Data = img.split(',')[1] || img;
      currentContent.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${base64Data}` });
    });
  }
  currentContent.push({ type: 'input_text', text: message || '画像を送りました。' });
  inputMessages.push({ role: 'user', content: currentContent });

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    tools: [{ type: 'web_search_preview' }],
    instructions,
    input: inputMessages,
  });

  const text = response.output_text || '返答を生成できませんでした。';
  return { text, exercises: [] };
}

// Vercelのサーバーレス環境（API Routes）として動くようにエクスポート
export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // VAPIDキー取得（GET）
  if (req.url.includes("wp-public-key")) {
    const pubKey = process.env.VAPID_PUBLIC_KEY;
    if (!pubKey) return res.status(503).json({ error: "VAPID_PUBLIC_KEY not configured" });
    return res.json({ publicKey: pubKey });
  }

  // 朝通知 cron（vercel.json: "0 22 * * *" = JST 7:00）VercelCronはGETで叩く
  // CRON_SECRET が設定されている場合は Authorization: Bearer <CRON_SECRET> を検証する
  if (req.url.includes("cron-morning-reminder")) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const auth = req.headers['authorization'] ?? '';
      if (auth !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }
    const pubKey = process.env.VAPID_PUBLIC_KEY;
    const privKey = process.env.VAPID_PRIVATE_KEY;
    if (!pubKey || !privKey) return res.status(503).json({ error: "VAPID keys not configured" });
    try {
      const raw = await kv.get<string>("push:subscription");
      if (!raw) {
        console.log("cron-morning-reminder: no subscription saved, skipping");
        return res.json({ skipped: true, reason: "no subscription" });
      }
      // 今日すでに体重を記録済みなら通知しない（数値は保存しない・日付のみ確認）
      const todayJST = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const lastRecorded = await kv.get<string>("weight:last-recorded-date");
      if (lastRecorded === todayJST) {
        console.log("cron-morning-reminder: weight already recorded today, skipping");
        return res.json({ skipped: true, reason: "already recorded" });
      }
      const subscription = typeof raw === "string" ? JSON.parse(raw) : raw;
      webpush.setVapidDetails("mailto:admin@lift-lean.app", pubKey, privKey);
      await webpush.sendNotification(
        subscription,
        JSON.stringify({ title: "体重記録のリマインダー", body: "おはようございます。今日の体重を測って記録しましょう。", icon: "/icon.png" })
      );
      console.log("cron-morning-reminder: notification sent");
      return res.json({ success: true });
    } catch (e: any) {
      console.error("cron-morning-reminder error:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 体重を記録した日付だけ保存（数値は保存しない）
  if (req.url.includes("save-weight-date")) {
    const { date } = req.body;
    if (!date || typeof date !== 'string') return res.status(400).json({ error: "date required" });
    try {
      await kv.set("weight:last-recorded-date", date);
      return res.json({ success: true });
    } catch (e: any) {
      console.error("save-weight-date error:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // Push subscription 保存
  if (req.url.includes("save-subscription")) {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: "subscription required" });
    try {
      await kv.set("push:subscription", JSON.stringify(subscription));
      return res.json({ success: true });
    } catch (e: any) {
      console.error("save-subscription error:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // Push subscription 削除（通知OFF時）
  if (req.url.includes("delete-subscription")) {
    try {
      await kv.del("push:subscription");
      return res.json({ success: true });
    } catch (e: any) {
      console.error("delete-subscription error:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // プッシュ通知送信
  if (req.url.includes("send-test-notification")) {
    const pubKey = process.env.VAPID_PUBLIC_KEY;
    const privKey = process.env.VAPID_PRIVATE_KEY;
    if (!pubKey || !privKey) return res.status(503).json({ error: "VAPID keys not configured" });
    const { subscription, action } = req.body;
    if (action === 'unsubscribe') return res.json({ success: true });
    try {
      webpush.setVapidDetails('mailto:admin@lift-lean.app', pubKey, privKey);
      await webpush.sendNotification(subscription, JSON.stringify({
        title: '体重記録のリマインダー', body: 'おはようございます。今日の体重を測って記録しましょう。', icon: '/icon.png'
      }));
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }

  // 料理名からPFC目安を推定するエンドポイント（テキストのみ・目安）
  // 精度重視のためこのエンドポイントのみ高精度モデルを使用（他機能のモデルは変更しない）
  const ESTIMATE_MEAL_MODEL = "gpt-4o";
  if (req.url.includes("estimate-meal")) {
    try {
      const { name } = req.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: "name is required" });
      }
      const trimmedName = name.trim().slice(0, 60);
      const matsuyaIntent = detectMatsuyaBeefYakinikuIntent(trimmedName);

      // チェーン・ブランド名を含む場合のみ、先に公式栄養成分をWeb検索で探す
      const matchedChain = findMatchedChain(trimmedName);
      if (matchedChain) {
        try {
          const searchQueryHint = buildSearchQueryHint(trimmedName, matchedChain);
          let webResult = await estimateMealViaWebSearch(openai, trimmedName, searchQueryHint, matsuyaIntent);
          if (!webResult) {
            // notFoundで諦める前に、補正なしのシンプルなクエリで一度だけ再試行する
            console.log(`Estimate-meal web search retry for: ${trimmedName}`);
            webResult = await estimateMealViaWebSearch(
              openai,
              trimmedName,
              `${trimmedName} カロリー たんぱく質 脂質 炭水化物`,
              matsuyaIntent,
            );
          }
          if (webResult) return res.json(webResult);
          console.log(`Estimate-meal web search notFound after retry (falling back to AI estimate): ${trimmedName}`);
        } catch (e) {
          console.error("Estimate-meal web search error (falling back to AI estimate):", e);
        }
      }

      const estimatePrompt = `料理名から、一般的な1食分のカロリーとPFCの「目安」を推定してください。これは正確な栄養計算ではなくAIによる推定です。

料理名：「${trimmedName}」
${buildMatsuyaIntentInstructions(matsuyaIntent)}

【推定ルール】
- 日本で一般的に提供される量を基準にする（外食・家庭料理の平均的な1人前）
- baseAmountは料理に合った単位で短く表記する：「1杯」（丼・カレー・麺類）/「1個」（おにぎり・パン）/「1枚」（ピザ・食パン）/「1皿」（定食・パスタ）/「100g」/「1人前」
- 数値は一般的な平均値で保守的に見積もる
- カロリーはPFCと整合させる（protein×4 + fat×9 + carbs×4 ≒ calories になるように）

【confidence の基準】
- high：定番料理で量・構成のブレが小さい（例：おにぎり、サラダチキン、かけうどん）
- medium：定番だが具材・量で変動しやすい（例：カレーライス、パスタ、丼もの）
- low：料理名が曖昧・地域差や店差が大きい・構成が読めない（例：「創作料理」「ママの特製弁当」）

【servingOptions のルール】
- baseAmountと同じ単位で3〜5個出す（例：少なめ 0.7杯 / 普通 1杯 / 大盛り 1.3杯 / 特盛 1.5杯）
- multiplierは0.5〜2の範囲。1（普通）を必ず含める
- 個数系（おにぎり等）は 1個 / 2個 / 3個 のように整数倍で出してよい

【note のルール】
- 「〜を基準にしたAI推定です。〜によって変動します。」の形で1〜2文
- 医療・栄養指導的な表現、正確性を保証する表現は禁止

料理名が食品として解釈できない場合は {"error":"unknown"} を返す。

必ず以下のJSON形式で返してください：
{"name":"整えた料理名","baseAmount":"1杯","calories":数値,"protein":数値,"fat":数値,"carbs":数値,"confidence":"high|medium|low","note":"短い説明","servingOptions":[{"label":"少なめ 0.7杯","multiplier":0.7},{"label":"普通 1杯","multiplier":1}],"matchedVariant":"該当時のみ指定された区分","calculationMethod":"exact_product_row|combined_components"}`;

      const completion = await openai.chat.completions.create({
        model: ESTIMATE_MEAL_MODEL,
        response_format: { type: "json_object" },
        max_tokens: 400,
        messages: [{ role: "user", content: estimatePrompt }],
      });

      const rawText = completion.choices[0]?.message?.content || "{}";
      let parsed: any;
      try { parsed = JSON.parse(rawText); } catch { parsed = {}; }
      if (!isMatsuyaWebResultCompatible(parsed, matsuyaIntent)) {
        return res.status(422).json({ error: "松屋の商品区分を正しく照合できませんでした。W定食・ご飯サイズ・単品を明記して再度お試しください。" });
      }

      // チェーン一致だがWeb検索で公式・Web情報が見つからなかった場合は、その旨をnoteで明示する
      const riceNormalization = normalizeMatsuyaRiceResult(parsed, matsuyaIntent);
      const chainFallbackNote = riceNormalization.noteOverride || (matchedChain
        ? `${matchedChain}の公式栄養成分は確認できなかったため、一般的な目安（AI推定）です。店舗・時期・キャンペーンメニューにより実際の数値と異なる場合があります。`
        : undefined);

      const result = buildMealEstimatePayload(parsed, { sourceType: 'ai_estimate' }, chainFallbackNote);
      if (!result) {
        return res.status(422).json({ error: "料理名から推定できませんでした。別の書き方で試してください。" });
      }
      return res.json(result);
    } catch (error: any) {
      console.error("Estimate-meal OpenAI Error:", error);
      return res.status(500).json({ error: error.message || "Failed to estimate meal" });
    }
  }

  // 1️⃣ 食事画像解析エンドポイント（複数画像・成分表対応）OpenAI gpt-4o
  if (req.url.includes("analyze-meal")) {
    try {
      const { image, images: imagesBody } = req.body;
      const imageList: string[] = imagesBody && imagesBody.length > 0
        ? imagesBody
        : image ? [image] : [];
      if (imageList.length === 0) return res.status(400).json({ error: "Image is required" });

      const content: any[] = imageList.map((img: string) => ({
        type: "image_url",
        image_url: { url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`, detail: "auto" },
      }));

      const isSingle = imageList.length === 1;
      const analysisPrompt = isSingle
        ? `この画像を分析してください。
食事写真の場合：料理名とカロリー・PFCを推定（量が不明なら一般的な量を想定）。

【料理名のルール】
- 特徴が一致するパターンがあれば、そのまま断定した料理名を返す。「〇〇系」「〇〇風」は付けない。
- どのパターンにも当てはまらない時のみ「〇〇系」「〇〇と思われる料理」を使う。
- 禁止：「かすうどん系の料理」「かすうどん系」「かすうどん風」。→ これらは使わず「かすうどん」と返す。

【麺料理の識別（パターン一致で断定）】
- 太い白い麺 ＋ 透明〜薄い色の出汁 ＋ 油かす（揚げかす・ちくわ天等） → nameは「かすうどん」と断定する
- 太い白い麺 ＋ 透明〜薄い色の出汁 ＋ 牛肉・玉ねぎ → nameは「肉うどん」と断定する
- 太い白い麺 ＋ 透明〜薄い色の出汁 ＋ 油揚げ → nameは「きつねうどん」と断定する
- 太い白い麺 ＋ 透明〜薄い色の出汁（具材不明） → nameは「うどん」とする
- 細い黄色い縮れ麺 ＋ 濃い茶色または白濁スープ → nameは「ラーメン」と断定する
- 白くて平らな麺 → nameは「きしめん」または「フォー」を検討する
- パターン不一致の麺料理 → nameは「麺料理」とする

【かすうどんのPFC目安（量が不明な場合に使う）】
calories: 550〜700 / protein: 12〜20g / fat: 15〜30g / carbs: 65〜90g

【PFC推定の方針】
- 量が不明な場合は一般的な1人前として保守的に見積もる

栄養成分表示の場合：表に記載された数値を優先して読み取る（読み取れない項目は0にする）。
必ず以下のJSON形式で返してください：{"name":"料理名または食品名","calories":数値,"protein":数値,"fat":数値,"carbs":数値}`
        : `${imageList.length}枚の画像を個別に分析してください。合計は計算しないでください。

各画像について：
- 食事写真 → 料理名とカロリー・PFCを推定。量が不明なら一般的な量を想定。
- 栄養成分表示 → 表に記載された数値をそのまま読み取る。

【料理名のルール】
- 特徴が一致するパターンがあれば、そのまま断定した料理名を返す。「〇〇系」「〇〇風」は付けない。
- どのパターンにも当てはまらない時のみ「〇〇系」「〇〇と思われる料理」を使う。
- 禁止：「かすうどん系の料理」「かすうどん系」「かすうどん風」。→ これらは使わず「かすうどん」と返す。

【麺料理の識別（パターン一致で断定）】
- 太い白い麺 ＋ 透明〜薄い色の出汁 ＋ 油かす（揚げかす・ちくわ天等） → nameは「かすうどん」と断定する
- 太い白い麺 ＋ 透明〜薄い色の出汁 ＋ 牛肉・玉ねぎ → nameは「肉うどん」と断定する
- 太い白い麺 ＋ 透明〜薄い色の出汁（具材不明） → nameは「うどん」とする
- 細い黄色い縮れ麺 ＋ 濃いスープ → nameは「ラーメン」と断定する
- パターン不一致の麺料理 → nameは「麺料理」とする

【炭水化物の読み取りルール（最重要）】
日本の栄養成分表示には2つのパターンがある。どちらでも「糖質の値だけ」をcarbsに使ってはいけない。

パターンA：炭水化物行あり
  炭水化物  35.8g   ← carbsにこの値を使う
    糖質    34.0g   ← 使わない
    食物繊維  1.8g   ← 使わない

パターンB：炭水化物行なし（糖質と食物繊維だけ記載）
  糖質    7.9g
  食物繊維  2.9g
  → carbsには「糖質 + 食物繊維」の合算値（7.9 + 2.9 = 10.8g）を使う

【脂質の読み取りルール】
- 脂質の行に0または0.0と書かれていれば、fatには0を記録する。推定で補わない。
- 脂質が0.1g未満の場合もfatは0として扱う。

【PFCの補正禁止】
- カロリーに合わせてPFCを再推定・再計算しない。
- カロリーとP/F/Cが数学的に一致しなくても、成分表の値を優先する。
- 合計の計算はしない。itemsの各行だけ返せばよい。

食事名のまとめ方（combined_name）：
- 1品：その料理名そのまま
- 2〜3品：「A、B、C」または「AとB」のように自然な日本語でまとめる
- 4品以上：「Aなど${imageList.length}品」

必ず以下のJSON形式で返してください（totalフィールドは不要）：
{"items":[{"name":"食品名","calories":数値,"protein":数値,"fat":数値,"carbs":数値}],"combined_name":"合計食事名"}`;

      content.push({ type: "text", text: analysisPrompt });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        max_tokens: isSingle ? 300 : 800,
        messages: [{ role: "user", content }],
      });

      const rawText = completion.choices[0]?.message?.content || "{}";
      let parsed: any;
      try { parsed = JSON.parse(rawText); } catch { parsed = {}; }

      if (isSingle) {
        return res.json({
          name: parsed.name || '解析された食事',
          calories: Math.round(parsed.calories || 0),
          protein: Math.round(parsed.protein || 0),
          fat: Math.round(parsed.fat || 0),
          carbs: Math.round(parsed.carbs || 0),
        });
      }

      const items: any[] = Array.isArray(parsed.items) ? parsed.items : [];
      console.log('[analyze-meal] AI items:', JSON.stringify(items, null, 2));
      const sumCalories = items.reduce((s: number, item: any) => s + (parseFloat(item.calories) || 0), 0);
      const sumProtein  = items.reduce((s: number, item: any) => s + (parseFloat(item.protein)  || 0), 0);
      const sumFat      = items.reduce((s: number, item: any) => s + (parseFloat(item.fat)      || 0), 0);
      const sumCarbs    = items.reduce((s: number, item: any) => s + (parseFloat(item.carbs)    || 0), 0);
      console.log('[analyze-meal] sums before round:', { sumCalories, sumProtein, sumFat, sumCarbs });
      return res.json({
        name: parsed.combined_name || items[0]?.name || '解析された食事',
        calories: Math.round(sumCalories),
        protein:  Math.round(sumProtein),
        fat:      Math.round(sumFat),
        carbs:    Math.round(sumCarbs),
      });
    } catch (error: any) {
      console.error("Analyze-meal OpenAI Error:", error);
      return res.status(500).json({ error: error.message || "Failed to analyze image" });
    }
  }

  // 2️⃣ AIパーソナルトレーナー・チャットエンドポイント
  if (req.url.includes("chat-trainer")) {
    try {
      const { message, images, workouts, meals, userData, history } = req.body;

      // 外部検索が必要なら Responses API ルートへ
      if (shouldUseWebSearch(message || '', Array.isArray(history) ? history : [])) {
        const result = await handleSearchQuery(
          message || '',
          images || [],
          Array.isArray(history) ? history : [],
          userData,
        );
        return res.json(result);
      }

      // 今日のトレーニング内容を文字列化
      let workoutSummary = "（未記録）";
      if (Array.isArray(workouts) && workouts.length > 0) {
        const workout = workouts[0];
        if (Array.isArray(workout.exercises) && workout.exercises.length > 0) {
          workoutSummary = workout.exercises.map((ex: any) => {
            const sets = Array.isArray(ex.sets) && ex.sets.length > 0
              ? ex.sets.map((s: any) => `${s.weight}kg×${s.reps}回`).join(', ')
              : "セットなし";
            return `  - ${ex.name}：${sets}`;
          }).join('\n');
        } else {
          workoutSummary = "（記録開始済・種目未入力）";
        }
      }

      // 今日の食事と摂取合計・目標達成率を文字列化
      let mealSummary = "（未記録）";
      let totalCalories = 0, totalProtein = 0, totalFat = 0, totalCarbs = 0;
      if (Array.isArray(meals) && meals.length > 0) {
        mealSummary = meals.map((m: any) =>
          `  - ${m.name}（${m.calories}kcal / P:${m.protein}g F:${m.fat}g C:${m.carbs}g）`
        ).join('\n');
        meals.forEach((m: any) => {
          totalCalories += Number(m.calories) || 0;
          totalProtein  += Number(m.protein)  || 0;
          totalFat      += Number(m.fat)       || 0;
          totalCarbs    += Number(m.carbs)     || 0;
        });
      }
      const calGoal     = Number(userData?.calories) || 0;
      const proteinGoal = Number(userData?.protein)  || 0;
      const calPct     = calGoal     > 0 ? Math.round((totalCalories / calGoal)     * 100) : 0;
      const proteinPct = proteinGoal > 0 ? Math.round((totalProtein  / proteinGoal) * 100) : 0;

      const prompt = `
        あなたは筋トレ・減量・PFC・食事管理にかなり詳しいAIコーチです。話し方は親しみやすく、押しつけがましくない。ただし「友達として一緒に盛り上がる」のではなく、「コーチとして現実的に返す」姿勢を常に保つ。
        いきなり長文解説やメニュー提案はせず、まず自然な会話から始めてください。

        【ユーザーの今日の状況】
        体重: ${userData?.weight || "未測定"}kg（目標: ${userData?.targetWeight || "未設定"}kg）
        目標PFC: P:${userData?.protein || 0}g / F:${userData?.fat || 0}g / C:${userData?.carbs || 0}g / ${calGoal || 0}kcal

        【今日のトレーニング】
${workoutSummary}

        【今日の食事】
${mealSummary}
        摂取合計: ${Math.round(totalCalories)}kcal / P:${Math.round(totalProtein)}g（目標の${proteinPct}%）

        【AIのしゃべり方スタイル】
        現在のスタイル: ${userData?.trainerStyle || 'buddy'}

        buddy（伴走型）：友達感覚で自然な口語。「いい感じじゃん」「やろ」「みよ」のトーン。さりげなく寄り添う。テンションは上げすぎない。
        coach（コーチ型）：感情より事実と次の行動を優先する。短く結論を出す。余計な共感は省く。「確認して」より「見ろ」「戻せ」に近い言い方。
        stoic（ストイック型）：数字と事実で話す。励ましや褒めは最小限。NG:「それは甘えです」「頑張って」。OK:「今日はPが足りない。まずプロテイン1杯足そう」。短く終わる。
        cheer（励まし型）：まず一言受け止めてから次の一手を出す。「いいね」「よかった」で始めてもいいが、食べすぎ・サボりでも無条件に肯定しすぎない。

        どのスタイルでも共通：罪悪感を与えない。長文説教禁止。極端な食事制限は止める。「今日から戻ればいい」トーンを維持。

        【返答スタイル】
        - 1回の返答は2〜4文以内を基本とする。ユーザーが短く送ってきたら短く返す。
        - 毎回質問で終わらせない。会話が自然に終わる時はそのまま終わっていい。
        - 「〜だよ」「〜かな？」は1返答に1回まで。多用するとくどくなる。
        - 名前での呼びかけはしない（「ユーザーさん」「あなた様」等も禁止）。
        - 口調はフラットで親しみやすく。テンションを上げすぎない。
        - 毎回アドバイスを入れなくていい。雑談なら雑談で返す。
        - 「ちゃんとやりましょう」「最優先です」といった強い言い方は使わない。
        - ユーザーの目的・経験・器具が分からない時は断定せず先に質問する。
        - 詳しく聞かれた時だけ専門的に長めに答える。それ以外は短く。
        - 「〜ってなに」「〜とは」などの定義質問も、効果・使い方・注意点を2〜3文の口語でまとめる。教科書的な説明や箇条書きは使わない。

        【食事・食欲への返答】
        - 高脂質・高カロリー食品（二郎系・カツ丼・カルビ・揚げ物・菓子パンなど）の話題が出たら、2〜3文で「食べてもいいが調整が必要」と返す。共感だけで終わらない。
        - 食べる前の相談なら：量・タイミング・代替案のうち現実的なものを1〜2個提案する。
            例「カツ丼いくなら、今日は脂質とカロリーがかなり乗りやすい。食べるならご飯少なめ＋衣少し残すくらいが現実的。減量優先なら、親子丼か鶏系に寄せる方が楽。」
            例「二郎系はカロリーと脂質がかなり重いから、減量中なら頻度と量は決めたい。食べるなら麺少なめ・脂少なめ・野菜多めにして、他の食事はタンパク質中心で軽く調整しよう。」
            例「カルビは脂質が高いから、減量中なら量だけ決めよ。カルビ少なめ＋赤身肉か鶏肉多め、白米は小〜普通にすると調整しやすい。」
        - 食べた後の報告なら：責めない。次の食事・今日の残りでの調整方針を1つだけ出す。
            例「食べたならOK。今日の残りはタンパク質中心で脂質抑えれば十分調整できる。」
        - 今日の食事記録がない状態で高カロリー食品の話が出たら：「今日まだ記録がないから、ここで大きく入れるとPFCが読みにくくなる」と一言添える。
        - 以下の表現は使用禁止（食欲を強めるだけで減量の役に立たない）：
            「美味しいですよね」「美味しそう」「最高ですよね」「テンション上がる」「じゅわっと」「たまらない」「食べたくなっちゃう」「聞くだけで〜」
        - 「何食べたい気分？」など食欲を広げる質問はしない。
        - 食事が未記録でも説教しない。「まず1つ入れてみよ」くらいのトーン。

        【停滞・サボり・やる気なし への返答】
        - 停滞期（「体重が落ちない」「全然変わらない」「◯週間変わってない」）：
          - 「諦めないで」「継続が大事」だけで終わらない。
          - 2週間以上動かないなら見直しのサインと伝え、食事記録のズレかトレ強度のどちらかを1つ確認する。
            例「2週間動いてないなら、一回見直すサインかも。まず食事記録が目標カロリーとズレてないか見よ。」
            例「停滞はある。食事かトレ強度、どっちが先に崩れた感じ？」
        - サボり後（「行けなかった」「◯日休んでた」「サボった」）：
          - 責めない。再開のハードルを下げる言い方を優先する。「次いつ行ける？」のような問いかけは使わない。
          - 1日なら：「1日なら問題ない。次は軽めに戻せばOK。」
          - 数日〜1週間なら：「少し重量落として再開すれば体に戻りやすい。まず軽めから。」
          - 忙しさが理由なら：「忙しいなら10分だけの日を作るのも手。全部やろうとしなくていい。」
        - やる気がない時（「だるい」「行きたくない」「モチベがない」「めんどくさい」）：
          - モチベーション論・精神論は語らない。
          - 行動ハードルを下げる選択肢（着替えだけ・30分に短縮）か「今日は休んで明日」のどちらかを自然に出す。
            例「とりあえず着替えだけしてみて。」
            例「今日は30分に短縮でもいい。それかまじで休んで明日フルで行く。」
          - ユーザーが一言で送ってきたら一言で返す。

        共通ルール（停滞・サボり・食べすぎ・やる気なし）：
        - 「今日から戻ればいい」スタンスを全シチュエーションに適用する。
        - 説教・長文禁止。2文以内を基本。ユーザーが短ければ1文で返す。
        - 「いいですよ」「大丈夫です」だけで終わらない。受け止めた上で、次の小さな一手を1つだけ出す。

        【習慣形成・心理学の原則（全スタイル共通）】
        - 自己効力感：記録した・ジムに行った・再開したなど、小さな行動を「それでいい」と自然に扱う。毎回褒めない。さりげなく認める。
            例「今日ちゃんと記録してる。それだけで十分。」「また動き出せてる。それが大事。」
        - 自律支援（SDT）：答えを押しつけない。ユーザーが迷っている時は選択肢を2つ出して選ばせる。
            例「今日は軽くやるか、完全に休んで明日フルで行くか、どっちが合いそう？」
        - 習慣ループ：記録後や再開時に、小さな達成感を一言で言語化する。
            例「また記録できてる。習慣になってきてる。」
        - Tiny Habits（行動ハードルを下げる）：全部やろうとしなくていい。まず1つだけのトーンで提案する。
            例「着替えだけしてみて。」「プロテイン1杯だけ飲んで。」「まず1食だけ記録してみよ。」
        - Never Miss Twice：1回のサボりや失敗は責めない。ただし2回連続を避けることを自然に促す。
            例「昨日休んだなら今日軽くでも動いておこ。」

        【極端なダイエット方法への対応】
        - 1日1食・500kcal以下・急な断食は安易に肯定しない。
        - 理由：筋肉低下・反動食い・トレーニング強度の低下につながりやすいため。
        - 「それだと続きにくいかも。まず〇〇から試そう」のように自然に止める。説教しない。
        - 健康リスクが高い場合は医師や専門家への相談を促す。

        【会話の文脈保持】
        - 直前の会話で出てきた人名・食品名・種目名・目標は、次の返答でも文脈として必ず使う。
        - historyに「[画像を送信]」が含まれている場合、その直後のAI返答がその画像に対する認識内容。次の発言もその画像の文脈として扱う。
        - ユーザーが短い言葉（「大会の結果とか」「それどう思う？」「最近どうだった？」）で聞いてきた場合、直前の文脈から補完して返す。
          例：直前で「田口純平」が出ていたなら「田口純平さんの大会結果ですね」と補完してから答える。
        - 文脈が不明な場合は「〇〇についてですか？」と1つだけ具体的に確認する。ふわっと「詳しく教えてください」とは聞かない。

        【情報の確実性を区別するルール】
        以下の3種類を明確に分けて扱い、混在させない。
        A. 画像から見えること → 断定OK（「絞れています」「肩の発達が目立ちます」）
        B. ユーザーが言ったこと（「らしい」「と聞いた」） → 「そうなんですね」「〜とのことですね」で受け取る。AIが事実として言い直したり断定・補強しない。
        C. AIが推測していること → 「〜に見えます」「〜かもしれません」と必ず明示する。

        - 画像から読めない順位・大会名・クラス・結果は絶対に断定しない。
        - ユーザーが「1位らしい」と言った場合の良い例：「そうなんですね、1位だったなら相当すごいです。画像で見ても仕上がりはかなり良く、特に肩・背中の広がりとウエストの細さが目立ちます。」
        - 禁止パターン：「2位の結果も素晴らしいですね」（根拠なく順位を断定）、「1位の結果は素晴らしいですね」（伝聞を事実として断定）、「完璧なコンディション」（過剰断定）、何でもポジティブに褒めるだけのテンプレ返答。
        - 体型の見た目コメント（「肩が広い」「絞れている」）はしてよい。順位・実績は断定しない。

        【画像が送られた場合】
        - 画像に見える情報（体型・筋肉量・絞れ具合・服装・背景など）を使って返す。画像を無視して名前だけ聞き返さない。
        - 人物が写っている場合：体型の特徴（絞れ具合・筋量・目立つ部位）を「〜に見えます」の表現で言語化する。
        - AIトレーナーとして、体型からフィットネス的なコメントを自然に加える。
          例：「肩と腹筋の仕上がりが強く、大会直前のコンディションに見えます。この体型を目指すなら減量期の管理が肝になりそう。」
        - 人物名が分からない場合でも画像から読める情報で返す。名前を聞くのは1回まで。
        - ユーザーが「この人みたいになりたい」と言ったら、画像から見える体型特徴を具体的に説明してからゴールを確認する。

        【知らない人物・選手への返答】
        - 名前を知らなくても「知りません」「教えてください」だけで終わらない。
        - 分かること（画像から見える体型・カテゴリの推測）と分からないこと（実績・近況）を分けて返す。
          例：「この方については詳しい情報を持っていないですが、画像からはフィジーク系の大会に出ている選手に見えます。」
        - 名前が出た後はその名前を文脈として保持して以降の返答に使う。

        【外部情報・最新情報が必要な場合】
        - 大会結果・SNS・最新ランキング・選手の近況など、リアルタイム情報が必要な質問には正直に答え、次に何をすればいいかを案内する。
          例：「最新の大会結果はこの場では確認できないので、Instagram・JBBF/FWJ/APFなどの公式リザルトページで調べると正確です。」
        - 「わかりません」だけで終わらない。確認先を具体的に1つ以上出す。
        - 知っている範囲（体型の特徴・カテゴリ・一般的な大会情報）は答えていい。その上で最新情報は外部確認を案内する。

        【メニュー提案のルール】
        - 「メニュー組んで」「今日何やればいい？」など、明示的に求められた場合のみ提案する。
        - 提案する場合のみ "exercises" に種目を入れる。それ以外は必ず空配列 [] にする。
          種目フォーマット: {"name": "種目名", "reps": 回数, "sets": セット数}
        - 器具・分割法・鍛えたい部位が不明なら、メニューより先に質問する。

        【やってはいけないこと】
        - 勝手にトレーニングメニューを提案する。
        - 長文で診断・説教・アドバイスをまとめて出す。
        - 分割法や器具が不明なのに全身法などを決めつける。
        - 食欲を煽る表現（「美味しいですよね」「美味しそう」「テンション上がる」など）を使う。
        - 「何食べたい気分？」など食欲を広げる質問をする。
        - 毎回質問で終わらせる。
        - 画像から確認できない大会順位・結果・大会名を断定する。
        - ユーザーの伝聞情報（「らしい」）を事実として言い直す。
        - 何でも褒めるだけのテンプレ返答をする。

        返信は必ず以下のJSON形式で返してください:
        {
          "text": "ユーザーへのメッセージ",
          "exercises": []
        }
      `;

      // ユーザーメッセージを組み立て（テキスト＋画像）
      const userContent: any[] = [];
      if (images && images.length > 0) {
        images.forEach((img: string) => {
          const base64Data = img.split(',')[1] || img;
          userContent.push({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64Data}` },
          });
        });
      }
      userContent.push({ type: "text", text: message || "画像を送りました。" });

      // 会話履歴をOpenAI messages形式に変換
      const historyMessages: any[] = [];
      if (Array.isArray(history) && history.length > 0) {
        history.forEach((msg: any) => {
          if (msg.role === 'user') {
            historyMessages.push({ role: "user", content: msg.text || "" });
          } else if (msg.role === 'assistant') {
            historyMessages.push({ role: "assistant", content: msg.text || "" });
          }
        });
      }

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        max_tokens: 500,
        messages: [
          { role: "system", content: prompt },
          ...historyMessages,
          { role: "user", content: userContent },
        ],
      });

      const rawText = completion.choices[0]?.message?.content || "{}";
      let parsed: any;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = { text: rawText, exercises: [] };
      }
      if (!parsed.exercises) parsed.exercises = [];
      return res.json(parsed);
    } catch (error: any) {
      console.error("Trainer OpenAI Error:", error);
      return res.status(500).json({ error: error.message || "Failed to chat with AI trainer" });
    }
  }

  // 3️⃣ AI目標提案エンドポイント（身長・体重・目的等からカロリー/PFC/目標体重の目安を提案）
  // 数値の納得感を優先するため、他機能より上位のモデルを使用（このエンドポイントのみ）
  const SUGGEST_GOALS_MODEL = "gpt-4.1";
  // 増量・減量の「安全な月間ペース」。中間目標・カロリー補正の算出に使う（AIには判断させずサーバー側で決定的に計算する）
  const GAIN_PACE_KG_PER_MONTH = 1.3;
  const KCAL_PER_KG = 7700;
  const safeLossPaceKgPerMonth = (weightKg: number): number =>
    Math.min(4, Math.max(1.5, Math.round(weightKg * 0.008 * 4 * 10) / 10));
  if (req.url.includes("suggest-goals")) {
    try {
      const { height, weight, age, sex, activity, goal, intensity, targetWeight, periodMonths, struggles } = req.body;
      const h = parseFloat(height);
      const w = parseFloat(weight);
      const a = parseFloat(age);
      if (!(h > 100 && h < 250) || !(w > 25 && w < 300) || !(a > 10 && a < 100)) {
        return res.status(400).json({ error: "身長・体重・年齢を正しく入力してください" });
      }

      const suggestPrompt = `あなたはフィットネス・栄養に詳しいAIコーチです。以下のユーザー情報から、1日の目標カロリーとPFC、目標体重の「目安」を提案してください。
これは医療・栄養指導ではなく、一般的な目安の提案です。断定的な効果（必ず痩せる・必ず筋肉が増える等）は約束しません。

【ユーザー情報】
身長: ${h}cm / 体重: ${w}kg / 年齢: ${a}歳${sex ? ` / 性別: ${String(sex).slice(0, 10)}` : ''}
運動頻度: ${String(activity || '不明').slice(0, 20)}
目的: ${String(goal || '不明').slice(0, 20)}
食事管理の本気度: ${String(intensity || '標準').slice(0, 10)}
${targetWeight ? `目標体重: ${parseFloat(targetWeight)}kg` : ''}
${periodMonths ? `希望期間: ${parseFloat(periodMonths)}ヶ月` : ''}
${struggles ? `続かなくなりがちな理由: ${String(struggles).slice(0, 100)}` : ''}

【提案の考え方】
- 基礎代謝・活動量から消費カロリーを概算し、目的に応じて増減させる（筋肉を増やしたい/体を大きくしたい→やや多め、体脂肪を落としたい/引き締めたい→やや少なめ、健康維持→維持量）
- 増減は無理のない範囲にする（極端な赤字・黒字は避ける）
- タンパク質は体重1kgあたり1.6〜2.2gを目安にする
- 脂質はカロリーの20〜30%程度、残りを炭水化物に配分する
- 「続かなくなりがちな理由」が書かれていたら、reasonの中でその対策に軽く触れる（例：自炊が苦手→コンビニで揃えやすい配分に寄せた、等）
- targetWeightが指定されている場合は、その数値をそのままtargetWeightとして返す（ペースが現実的かどうかの判断・調整はシステム側で別途行うため、あなたはユーザーの希望をそのまま反映してよい）
- targetWeightが未指定の場合は、現在体重から目的に沿った無理のない目安値を提案してよい
- periodMonthsが未指定の場合は3〜12の範囲で妥当な期間を提案する

【reasonのルール】
- 2〜3文の日本語。「なぜこのカロリーか」「なぜこのPFCか」の根拠を簡潔に説明する
- 「必ず」「絶対」「保証」等の断定語は禁止
- 「まずはこの数値から始めましょう」のような、試しながら調整していくトーンにする
- 医療用語・診断的な言い回しは禁止

【nextStepsのルール】
- 1〜2文の日本語。次に何をすればいいか、体を大きくしたい/絞りたい人がそれぞれ何を見ればいいかが分かる具体的な行動を書く
- 例：「2週間ごとに体重の増え方を確認し、増えなさすぎ・増えすぎに応じてカロリーを100〜200kcal単位で調整しましょう。」
- 断定語・医療用語は禁止

必ず以下のJSON形式のみで返してください：
{"calories":数値,"protein":数値,"fat":数値,"carbs":数値,"targetWeight":数値,"periodMonths":数値,"reason":"2〜3文の説明","nextSteps":"1〜2文の次の行動"}`;

      const completion = await openai.chat.completions.create({
        model: SUGGEST_GOALS_MODEL,
        response_format: { type: "json_object" },
        max_tokens: 500,
        messages: [{ role: "user", content: suggestPrompt }],
      });

      const rawText = completion.choices[0]?.message?.content || "{}";
      let parsed: any;
      try { parsed = JSON.parse(rawText); } catch { parsed = {}; }

      let calories = Math.round(parseFloat(parsed.calories) || 0);
      let protein  = Math.round(parseFloat(parsed.protein)  || 0);
      let fat      = Math.round(parseFloat(parsed.fat)      || 0);
      let carbs    = Math.round(parseFloat(parsed.carbs)    || 0);
      let suggestedTargetWeight = Math.round((parseFloat(parsed.targetWeight) || w) * 10) / 10;
      let suggestedPeriodMonths = Math.round(parseFloat(parsed.periodMonths) || 6);

      if (calories <= 0 || protein <= 0 || fat <= 0 || carbs <= 0) {
        return res.status(422).json({ error: "目標を提案できませんでした。入力内容を見直してもう一度試してください。" });
      }

      const clampNotes: string[] = [];

      // カロリー：一般的な安全範囲（1200〜4500kcal）にクランプ
      calories = Math.min(4500, Math.max(1200, calories));

      // 目標体重：現在体重の±20%以内にクランプ（極端な増減提案を防ぐ）。これが「最終目標」
      const twBefore = Math.round((parseFloat(parsed.targetWeight) || w) * 10) / 10;
      let finalTargetWeight = Math.min(w * 1.2, Math.max(w * 0.8, suggestedTargetWeight));
      finalTargetWeight = Math.round(finalTargetWeight * 10) / 10;
      if (finalTargetWeight !== twBefore) clampNotes.push('目標体重を無理のない範囲に調整しました');

      // 期間：1〜24ヶ月にクランプ
      suggestedPeriodMonths = Math.min(24, Math.max(1, suggestedPeriodMonths));

      // 「まずの中間目標」の算出：最終目標までのペースが安全な月間ペースを超える場合のみ、
      // 現在体重から安全ペース×期間ぶんだけ進んだ地点を中間目標にする（AIには判断させず決定的に計算する）
      const totalChange = finalTargetWeight - w;
      const direction: 'gain' | 'loss' | 'maintain' = totalChange > 0.1 ? 'gain' : totalChange < -0.1 ? 'loss' : 'maintain';
      const recommendedPaceKgPerMonth = direction === 'gain' ? GAIN_PACE_KG_PER_MONTH : direction === 'loss' ? safeLossPaceKgPerMonth(w) : 0;
      const maxRealisticChange = recommendedPaceKgPerMonth * suggestedPeriodMonths;

      let interimTargetWeight = finalTargetWeight;
      let isAggressiveGoal = false;
      if (direction !== 'maintain' && Math.abs(totalChange) > maxRealisticChange) {
        isAggressiveGoal = true;
        const sign = direction === 'gain' ? 1 : -1;
        interimTargetWeight = Math.round((w + sign * maxRealisticChange) * 10) / 10;

        // カロリーも中間目標のペースに合わせて補正する（最終目標向けの過剰な黒字/赤字をそのまま出さない）
        const excessKg = Math.abs(totalChange) - maxRealisticChange;
        const dailyCalorieAdjustment = Math.round((excessKg * KCAL_PER_KG) / (suggestedPeriodMonths * 30));
        calories = direction === 'gain' ? calories - dailyCalorieAdjustment : calories + dailyCalorieAdjustment;
        calories = Math.min(4500, Math.max(1200, calories));
        clampNotes.push('急なペースにならないよう、カロリーも中間目標に合わせて調整しました');
      }

      // タンパク質：体重×0.8〜3.0gの範囲にクランプ
      const proteinBefore = protein;
      protein = Math.min(w * 3.0, Math.max(w * 0.8, protein));
      protein = Math.round(protein);
      if (protein !== proteinBefore) clampNotes.push('タンパク質量を無理のない範囲に調整しました');

      // 脂質：カロリーの15〜35%の範囲にクランプ（補正後のカロリーを基準にする）
      const fatMin = Math.round((calories * 0.15) / 9);
      const fatMax = Math.round((calories * 0.35) / 9);
      const fatBefore = fat;
      fat = Math.min(fatMax, Math.max(fatMin, fat));
      if (fat !== fatBefore) clampNotes.push('脂質量を調整しました');

      // 炭水化物：PFC×カロリー整合チェック（25%以上ズレたら炭水化物側で吸収して補正）
      const pfcCaloriesWithoutCarbs = protein * 4 + fat * 9;
      const impliedCarbs = Math.max(0, Math.round((calories - pfcCaloriesWithoutCarbs) / 4));
      const carbsDiffRatio = carbs > 0 ? Math.abs(carbs - impliedCarbs) / carbs : 1;
      if (carbsDiffRatio > 0.25) {
        carbs = impliedCarbs;
        clampNotes.push('炭水化物量をカロリーと整合するよう調整しました');
      }

      let reason = String(parsed.reason || 'あなたの入力をもとに、まずはこの数値から始める目安を計算しました。体調や続けやすさに合わせて少しずつ調整してください。').slice(0, 200);
      if (clampNotes.length > 0) {
        reason += ` （${Array.from(new Set(clampNotes)).join('、')}）`;
      }
      const nextSteps = String(parsed.nextSteps || '2週間ごとに体重の変化を確認し、増え方・減り方が想定とズレていたらカロリーを100〜200kcal単位で調整しましょう。').slice(0, 200);

      return res.json({
        calories,
        protein,
        fat,
        carbs,
        targetWeight: finalTargetWeight,
        interimTargetWeight,
        isAggressiveGoal,
        recommendedPaceKgPerMonth: Math.round(recommendedPaceKgPerMonth * 10) / 10,
        periodMonths: suggestedPeriodMonths,
        reason: reason.slice(0, 260),
        nextSteps,
        note: "一般的な目安の提案です。医療・栄養指導ではありません。体調に合わせて無理なく調整してください。",
      });
    } catch (error: any) {
      console.error("Suggest-goals OpenAI Error:", error);
      return res.status(500).json({ error: error.message || "Failed to suggest goals" });
    }
  }

  return res.status(444).json({ error: "Not found" });
}
