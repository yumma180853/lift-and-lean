import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

// AIの鍵（APIキー）の設定
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const app = express();
app.use(express.json({ limit: '10mb' }));

// 1. 食事の写真解析ルート（幻のモデル名を本物に完全修正！）
app.post("/api/analyze-meal", async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: "Image is required" });
    }
    
    // 画像のMIMEタイプ（jpeg, png, webpなど）を自動で判別してエラーを防ぐ
    const mimeTypeMatch = image.match(/^data:(image\/[a-zA-Z+]+);base64,/);
    const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : "image/jpeg";
    const base64Data = image.split(',')[1] || image;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash", // 本物の最新・最速モデルに完全修正！
      contents: [
        {
          parts: [
            { inlineData: { mimeType: mimeType, data: base64Data } },
            { text: "Analyze this meal image. Estimate the following: meal name, total calories (kcal), protein (g), fat (g), and carbohydrates (g). Provide reasonable estimates based on the visual contents. Return the result in Japanese." }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            calories: { type: Type.NUMBER },
            protein: { type: Type.NUMBER },
            fat: { type: Type.NUMBER },
            carbs: { type: Type.NUMBER },
          },
          required: ["name", "calories", "protein", "fat", "carbs"],
        },
      },
    });
    const result = JSON.parse(response.text || "{}");
    res.json(result);
  } catch (error: any) {
    console.error("Gemini Error:", error);
    res.status(500).json({ error: error.message || "Failed to analyze image" });
  }
});

// 2. AIパーソナルトレーナー チャットルート（普通の対話＆メニュー連発防止版！）
app.post("/api/chat-trainer", async (req, res) => {
  try {
    const { message, images, userData, workouts, meals, history } = req.body;

    // 筋トレログを綺麗なテキストに変換
    const workoutSummary = workouts && workouts.length > 0
      ? workouts.map((w: any) => {
          const setsText = w.sets ? w.sets.map((s: any, i: number) => `  - SET ${i+1}: ${s.weight}kg × ${s.reps}回 (VOL: ${s.weight * s.reps})`).join("\n") : "  データなし";
          return `■ ${w.name}\n${setsText}`;
        }).join("\n\n")
      : "本日の筋トレ記録はまだありません。";

    // 食事ログを綺麗なテキストに変換
    const mealSummary = meals && meals.length > 0
      ? meals.map((m: any) => `・ ${m.name} (${m.calories}kcal / P:${m.protein}g F:${m.fat}g C:${m.carbs}g)`).join("\n")
      : "本日の食事記録はまだありません。";

    // 今日の合計摂取栄養素を計算
    const totalP = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.protein) || 0), 0) : 0;
    const totalF = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.fat) || 0), 0) : 0;
    const totalC = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.carbs) || 0), 0) : 0;
    const totalCal = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.calories) || 0), 0) : 0;

    const systemInstruction = `
    あなたはプロのパーソナルトレーナーAIです。ユーザーとの「普通の自然な対話」を最も大切にしてください。
    一問一答の機械的な回答ではなく、普通のAIのようになめらかに、これまでの会話の文脈（流れ）に沿ったキャッチボールを行ってください。

    【⚠️最重要ルール：メニュー提案の厳重制限】
    ユーザーから「メニューを教えて」「新しい種目を提案して」「メニューを変えたい」など、明示的に新しい筋トレメニューの作成・変更を求められた場合以外は、絶対に新しいメニューを提案してはいけません。
    通常の相談、質問への回答、雑談、励ましの言葉、食事のアドバイスなどの際は、exercises フィールドは必ず空の配列 [] にしてください。毎回違うメニューを押し付けるような推奨は絶対に禁止します。

    【ユーザーの基本目標設定】
    ・現在の体重: ${userData?.weight || "--"}kg / 目標体重: ${userData?.targetWeight || "--"}kg
    ・目標カロリー: ${userData?.calories || "--"}kcal
    ・目標PFCバランス: P:${userData?.protein || "--"}g, F:${userData?.fat || "--"}g, C:${userData?.carbs || "--"}g

    【🔥本日のリアルタイム筋トレ記録】
    ${workoutSummary}

    【🍏本日のリアルタイム食事・摂取栄養素】
    合計摂取カロリー: ${totalCal} kcal
    現在の摂取PFC: P:${totalP.toFixed(1)}g, F:${totalF.toFixed(1)}g, C:${totalC.toFixed(1)}g
    --- 食べたメニュー一覧 ---
    ${mealSummary}

    【トレーナーとしての対話指針】
    1. ユーザーが「こうしたいんだけど何すればいい？」などと質問してきたら、その意図（バルクアップしたいのか、痩せたいのか、特定の部位を鍛えたいのかなど）を丁寧に聞き返したり、会話の文脈に沿って親身に答えてください。
    2. ユーザーから言われなくても、上記の「今日のデータ」は脳内に把握しておき、会話の流れで自然に「今日のタンパク質バッチリだね！」などと触れるのはOKですが、毎回同じセリフを連発しないでください。
    3. 毎回無理に「筋肉痛はありますか？」と定型文で締めくくる必要はありません。普通の人間のように自然に会話を終わらせてください。
    `;

    // 過去の履歴（history）がある場合はそれをベースにし、最新のメッセージを追加する
    let contents: any[] = [];
    if (history && Array.isArray(history)) {
      contents = history.map((h: any) => ({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.text || h.message || "" }]
      }));
    }

    // 最新のユーザー発言の組み立て
    const currentParts: any[] = [];
    if (images && images.length > 0) {
      images.forEach((img: string) => {
        const mimeTypeMatch = img.match(/^data:(image\/[a-zA-Z+]+);base64,/);
        const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : "image/jpeg";
        const base64Data = img.split(',')[1] || img;
        currentParts.push({
          inlineData: { mimeType: mimeType, data: base64Data }
        });
      });
    }
    currentParts.push({ text: message });

    // 履歴の最後に最新の発言を追加
    contents.push({ role: "user", parts: currentParts });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash", 
      contents: contents,
      config: { 
        systemInstruction: systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            text: { 
              type: Type.STRING, 
              description: "ユーザーへの親身で自然な返答メッセージ。文脈に沿った対話を行ってください。" 
            },
            exercises: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  reps: { type: Type.NUMBER },
                  sets: { type: Type.NUMBER }
                },
                required: ["name", "reps", "sets"]
              },
              description: "ユーザーから明確にメニュー提案を求められた
