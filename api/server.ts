import express from "express";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
});

const app = express();
app.use(express.json({ limit: '10mb' }));

// 1. 食事の写真解析ルート（最新のスキーマ記述に完全修正！）
app.post("/api/analyze-diet-image", async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: "Image is required" });
    
    const mimeTypeMatch = image.match(/^data:(image\/[a-zA-Z+]+);base64,/);
    const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : "image/jpeg";
    const base64Data = image.split(',')[1] || image;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
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
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            calories: { type: "NUMBER" },
            protein: { type: "NUMBER" },
            fat: { type: "NUMBER" },
            carbs: { type: "NUMBER" },
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

// 2. AIパーソナルトレーナー チャットルート（最新のスキーマ記述＆対話最優先版）
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
【⚠️最重要ルール：メニュー提案の厳重制限】
ユーザーから明確に新しい筋トレメニューの作成・変更を求められた場合以外は、絶対に新しいメニューを提案してはいけません。通常の相談や食事アドバイスの際はexercisesは必ず空の配列 [] にしてください。

【目標設定】体重: ${userData?.weight || "--"}kg / 目標: ${userData?.targetWeight || "--"}kg / カロリー: ${userData?.calories || "--"}kcal
【🔥本日の筋トレ】\n${workoutSummary}\n\n【🍏本日の食事】\n合計: ${totalCal}kcal (P:${totalP.toFixed(1)}g, F:${totalF.toFixed(1)}g, C:${totalC.toFixed(1)}g)\n${mealSummary}
`;

    let contents: any[] = [];
    if (history && Array.isArray(history)) {
      contents = history.map((h: any) => ({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.text || h.message || "" }]
      }));
    }

    const currentParts: any[] = [];
    if (images && images.length > 0) {
      images.forEach((img: string) => {
        const mimeTypeMatch = img.match(/^data:(image\/[a-zA-Z+]+);base64,/);
        const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : "image/jpeg";
        const base64Data = img.split(',')[1] || img;
        currentParts.push({ inlineData: { mimeType, data: base64Data } });
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
          type: "OBJECT",
          properties: {
            text: { type: "STRING", description: "ユーザーへの自然な返答メッセージ。文脈に沿った対話を行ってください。" },
            exercises: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: { name: { type: "STRING" }, reps: { type: "NUMBER" }, sets: { type: "NUMBER" } },
                required: ["name", "reps", "sets"]
              },
              description: "メニュー提案を求められた場合のみ。それ以外は必ず空の配列 []"
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
