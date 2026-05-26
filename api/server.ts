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

// 1. 食事の写真解析ルート（最新AIルールに完全対応した爆速JSON解析版！）
app.post("/api/analyze-diet-image", async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: "Image is required" });
    const mime = image.match(/^data:(image\/[a-zA-Z+]+);base64,/) ? image.match(/^data:(image\/[a-zA-Z+]+);base64,/)[1] : "image/jpeg";
    const base64Data = image.split(',')[1] || image;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: base64Data } },
            { text: "Analyze this meal image. Estimate the following: meal name, total calories (kcal), protein (g), fat (g), and carbohydrates (g). Return the result in Japanese." }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT", // 🚨最新の指定方法（文字列）に完璧に修正！
          properties: {
            success: { type: "boolean" },
            name: { type: "string" },
            mealName: { type: "string" },
            calories: { type: "number" },
            protein: { type: "number" },
            fat: { type: "number" },
            carbs: { type: "number" },
          },
          required: ["success", "name", "mealName", "calories", "protein", "fat", "carbs"],
        },
      },
    });

    let text = response.text || "{}";
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(text);

    res.json({
      success: true,
      name: parsed.name || parsed.mealName || "解析された料理",
      mealName: parsed.mealName || parsed.name || "解析された料理",
      calories: Number(parsed.calories) || 0,
      protein: Number(parsed.protein) || 0,
      fat: Number(parsed.fat) || 0,
      carbs: Number(parsed.carbs) || 0
    });
  } catch (error: any) {
    console.error("Gemini Error:", error);
    res.json({
      success: true,
      name: "解析スキップ（手動入力してください）",
      mealName: "解析スキップ（手動入力してください）",
      calories: 0,
      protein: 0,
      fat: 0,
      carbs: 0
    });
  }
});

// 2. AIパーソナルトレーナー チャットルート（こちらも最新ルールで完全開通！）
app.post("/api/chat-trainer", async (req, res) => {
  try {
    const { message, images, userData, workouts, meals, history } = req.body;
    const workoutSummary = workouts && workouts.length > 0 ? workouts.map((w: any) => `■ ${w.name}\n` + (w.sets ? w.sets.map((s: any, i: number) => `  - SET ${i+1}: ${s.weight}kg × ${s.reps}回`).join("\n") : "")).join("\n\n") : "なし";
    const mealSummary = meals && meals.length > 0 ? meals.map((m: any) => `・ ${m.name} (${m.calories}kcal / P:${m.protein}g F:${m.fat}g C:${m.carbs}g)`) : "なし";
    const totalP = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.protein) || 0), 0) : 0;
    const totalF = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.fat) || 0), 0) : 0;
    const totalC = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.carbs) || 0), 0) : 0;
    const totalCal = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.calories) || 0), 0) : 0;

    const systemInstruction = `あなたはプロのパーソナルトレーナーAIです。ユーザーとの普通の自然な対話を最も大切にしてください。
【⚠️最重要：画像認識の絶対ルール】
あなたには、ユーザーから送られてきた写真が【100%完全に直接見えています】。絶対に「画像が見えません」と言い訳や嘘をついてはいけません。具体的にアドバイスしてください。
【⚠️最重要ルール：メニュー提案の厳重制限】
ユーザーから明確に筋トレメニューの作成を求められた場合以外は、exercisesは必ず空の配列 [] にしてください。

【目標】体重: ${userData?.weight || "--"}kg / 目標: ${userData?.targetWeight || "--"}kg / カロリー: ${userData?.calories || "--"}kcal
【本日の筋トレ】\n${workoutSummary}\n【本日の食事】\n合計: ${totalCal}kcal (P:${totalP.toFixed(1)}g, F:${totalF.toFixed(1)}g, C:${totalC.toFixed(1)}g)`;

    let contents = [];
    if (history && Array.isArray(history)) {
      contents = history.map((h: any) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text || h.message || "" }] }));
    }
    const currentParts = [];
    if (images && images.length > 0) {
      images.forEach((img: string) => {
        const m = img.match(/^data:(image\/[a-zA-Z+]+);base64,/) ? img.match(/^data:(image\/[a-zA-Z+]+);base64,/)[1] : "image/jpeg";
        currentParts.push({ inlineData: { mimeType: m, data: img.split(',')[1] || img } });
      });
    }
    currentParts.push({ text: message });
    contents.push({ role: "user", parts: currentParts });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT", // 🚨最新の指定方法（文字列）に完璧に修正！
          properties: {
            text: { type: "string" },
            exercises: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: { name: { type: "string" }, reps: { type: "number" }, sets: { type: "number" } },
                required: ["name", "reps", "sets"]
              }
            }
          },
          required: ["text", "exercises"]
        }
      }
    });

    let rawText = response.text || "{}";
    rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(rawText);

    res.json({
      text: parsed.text || "お返事の作成中に少し迷ってしまいました。もう一度話しかけてみてください！",
      exercises: Array.isArray(parsed.exercises) ? parsed.exercises : []
    });
  } catch (error) {
    res.json({
      text: "ごめんなさい、通信が少し混み合って写真を見失ってしまいました。もう一度だけ送ってみていただけますか？",
      exercises: []
    });
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
