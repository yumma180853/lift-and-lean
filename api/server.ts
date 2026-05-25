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

// 1. 食事の写真解析ルート（URLをフロントに完全に合わせました！）
app.post("/api/analyze-diet-image", async (req, res) => {
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
            { text: "Analyze this meal image. Estimate the following: meal name, total calories (kcal), protein (g), fat (g), and carbohydrates (g). Return the result in Japanese." }
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
    res.json(JSON.parse(response.text || "{}"));
  } catch (error: any) {
    console.error("Gemini Error:", error);
    res.status(500).json({ error: error.message || "Failed to analyze image" });
  }
});

// 2. AIパーソナルトレーナー チャットルート（普通の対話＆メニュー連発防止版！）
app.post("/api/chat-trainer", async (req, res) => {
  try {
    const { message, images, userData, workouts, meals, history } = req.body;

    const workoutSummary = workouts && workouts.length > 0
      ? workouts.map((w: any) => `■ ${w.name}\n` + (w.sets ? w.sets.map((s: any, i: number) => `  - SET ${i+1}: ${s.weight}kg × ${s.reps}回`).join("\n") : "")).join("\n\n")
      : "本日の筋トレ記録はまだありません。";

    const mealSummary = meals && meals.length > 0
      ? meals.map((m: any) => `・ ${m.name} (${m.calories}kcal / P:${m.protein}g F:${m.fat}g C:${m.carbs}g)`).join("\n")
      : "本日の食事記録はまだありません。";

    const totalP = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.protein) || 0), 0) : 0;
    const totalF = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.fat) || 0), 0) : 0;
    const totalC = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.carbs) || 0), 0) : 0;
    const totalCal = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.calories) || 0), 0) : 0;

    const systemInstruction = `
あなたはプロのパーソナルトレーナーAIです。ユーザーとの「普通の自然な対話」を最も大切にしてください。
一問一答の機械的な回答ではなく、普通のAIのようになめらかに、これまでの会話の文脈（流れ）に沿ったキャッチボールを行ってください。

【⚠️最重要ルール：メニュー提案の厳重制限】
ユーザーから明確に新しい筋トレメニューの作成・変更を求められた場合以外は、絶対に新しいメニューを提案してはいけません。
通常の相談や励ましの際は、exercises フィールドは必ず空の配列 [] にしてください。毎回違うメニューを押し付けるような推奨は絶対に禁止します。

【目標設定】体重: ${userData?.weight || "--"}kg / 目標体重: ${userData?.targetWeight || "--"}kg / カロリー: ${userData?.calories || "--"}kcal
【🔥本日のリアルタイム筋トレ記録】\n${workoutSummary}
\n\n【🍏本日のリアルタイム食事・摂取栄養素】\n合計摂取カロリー: ${totalCal} kcal (P:${totalP.toFixed(1)}g, F:${totalF.toFixed(1)}g, C:${totalC.toFixed(1)}g)\n${mealSummary}
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
        const base64Data = img.split(',')[1] || img;
        currentParts.push({ inlineData: { mimeType: "image/jpeg", data: base64Data } });
      });
    }
    currentParts.push({ text: message });
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
            text: { type: Type.STRING, description: "ユーザーへの自然な返答メッセージ。文脈に沿った対話を行ってください。" },
            exercises: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: { name: { type: Type.STRING }, reps: { type: Type.NUMBER }, sets: { type: Type.NUMBER } },
                required: ["name", "reps", "sets"]
              },
              description: "メニュー提案を求められた場合のみ、提案する筋トレメニューのリスト。それ以外は空の配列 [] にしてください。"
            }
          },
          required: ["text", "exercises"]
        }
      },
    });

    res.json(JSON.parse(response.text || "{}"));
  } catch (error: any) {
    console.error("Trainer Error:", error);
    res.status(500).json({ error: error.message || "Failed to chat" });
  }
});

// 開発環境と本番環境の振り分け設定
if (process.env.NODE_ENV !== "production") {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  const distPath = path.join(process.cwd(), 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => { res.sendFile(path.join(distPath, 'index.html')); });
}

export default app;
