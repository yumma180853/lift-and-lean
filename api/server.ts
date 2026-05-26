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

// 1. 食事の写真解析ルート（無料制限のときは、理由をハッキリ表示！）
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
          type: "OBJECT",
          properties: {
            success: { type: "BOOLEAN" },
            name: { type: "STRING" },
            mealName: { type: "STRING" },
            calories: { type: "NUMBER" },
            protein: { type: "NUMBER" },
            fat: { type: "NUMBER" },
            carbs: { type: "NUMBER" },
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
    const errStr = String(error);
    const isQuota = errStr.includes("429") || errStr.includes("Quota") || error?.status === 429;
    
    // 🚨無料制限（429）の時は、スキップではなく「無料枠の上限」とハッキリ表示！
    res.json({
      success: true,
      name: isQuota ? "解析制限（無料枠の上限に達しました。明日復活します）" : "解析スキップ（手動入力してください）",
      mealName: isQuota ? "解析制限（無料枠の上限に達しました。明日復活します）" : "解析スキップ（手動入力してください）",
      calories: 0, protein: 0, fat: 0, carbs: 0
    });
  }
});

// 2. AIパーソナルトレーナー チャットルート（無料制限のチケット切れをハッキリ喋るように大改造！）
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
ユーザーから送られてきた写真は100%完全に見えています。具体的にアドバイスしてください。要望がない限りexercisesは必ず空の配列 [] にしてください。

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
          type: "OBJECT",
          properties: {
            text: { type: "STRING" },
            exercises: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: { name: { type: "STRING" }, reps: { type: "NUMBER" }, sets: { type: "NUMBER" } },
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
    console.error("Trainer Error:", error);
    const errStr = String(error);
    const isQuota = errStr.includes("429") || errStr.includes("Quota") || error?.status === 429;
    
    // 🚨チケット切れ(429)のときは、AI自身がハッキリと理由を叫ぶように大手術！
    res.json({
      text: isQuota 
        ? "【Gemini AIの無料制限】1日の無料利用枠（20回）の上限に達しました！数時間〜明日になると自動でリセットされて満タンになりますので、しばらく時間を置いてからもう一度話しかけてみてください！" 
        : "トレーナーAIとの通信に一時的なエラーが発生しました。もう一度だけ送ってみていただけますか？",
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
