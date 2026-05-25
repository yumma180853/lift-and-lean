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

// 1. 食事の写真解析ルート（100%成功している安定版）
async function handleAnalyzeMeal(req: express.Request, res: express.Response) {
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
            { text: "Analyze this meal image. Estimate: name, calories, protein, fat, carbs. Return the result in Japanese." }
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
            carbs: { type: "NUMBER" }
          },
          required: ["name", "calories", "protein", "fat", "carbs"]
        }
      }
    });

    res.json(JSON.parse(response.text || "{}"));
  } catch (error: any) {
    console.error("Gemini Error:", error);
    res.json({
      name: "画像解析スキップ（手動入力してください）",
      calories: 0,
      protein: 0,
      fat: 0,
      carbs: 0
    });
  }
}

app.post("/api/analyze-meal", handleAnalyzeMeal);
app.post("/api/analyze-diet-image", handleAnalyzeMeal);

// 2. AIパーソナルトレーナー チャットルート（AIの「画像見えない嘘」を完全に粉砕する強力プロンプト版！）
app.post("/api/chat-trainer", async (req, res) => {
  try {
    const { message, images, userData, workouts, meals, history } = req.body;
    
    const workoutSummary = workouts && workouts.length > 0
      ? workouts.map((w: any) => `■ ${w.name}\n` + (w.sets ? w.sets.map((s: any, i: number) => `  - SET ${i+1}: ${s.weight}kg × ${s.reps}回`).join("\n") : "")).join("\n\n")
      : "なし";

    const mealSummary = meals && meals.length > 0
      ? meals.map((m: any) => `・ ${m.name} (${m.calories}kcal / P:${m.protein}g F:${m.fat}g C:${m.carbs}g)`).join("\n")
      : "なし";

    const totalP = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.protein) || 0), 0) : 0;
    const totalF = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.fat) || 0), 0) : 0;
    const totalC = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.carbs) || 0), 0) : 0;
    const totalCal = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.calories) || 0), 0) : 0;

    // 🚨最重要：AIの勘違いお断りセリフを絶対に言わせない強力な自覚命令をセット！
    const systemInstruction = `あなたはプロのパーソナルトレーナーAIです。ユーザーとの「普通の自然な対話」を最も大切にしてください。
【⚠️超重要：画像認識ルール】
あなたには、ユーザーから送られてきた写真や画像（食事、体型、トレーニング風景など）が「100%完全に直接見えています」。
絶対に「私はテキストベースのAIなので画像が見えません」「写真を確認できません」と言い訳や嘘をついてはいけません。画像に写っている色、形、食材、体型の特徴を具体的に言葉にして褒めたりアドバイスしてください。

【⚠️最重要ルール：メニュー提案の厳重制限】
ユーザーから明確に新しい筋トレメニューの作成を求められた場合以外は、絶対に新しいメニューを提案してはいけません。通常の相談や食事アドバイスの際はexercisesは必ず空の配列 [] にしてください。

【目標】体重: ${userData?.weight || "--"}kg / 目標: ${userData?.targetWeight || "--"}kg / カロリー: ${userData?.calories || "--"}kcal
【本日の筋トレ】\n${workoutSummary}\n【本日の食事】\n合計: ${totalCal}kcal (P:${totalP.toFixed(1)}g, F:${totalF.toFixed(1)}g, C:${totalC.toFixed(1)}g)\n${mealSummary}`;
    
    let contents = [];
    if (history && Array.isArray(history)) {
      contents = history.map((h: any) => ({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.text || h.message || "" }]
      }));
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
            text: { type: "STRING", description: "ユーザーへの自然な返答メッセージ。画像が送られている場合はその見た目（色や形、写っている物）に必ず具体的に触れてください。" },
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
    res.json(JSON.parse(response.text || "{}"));
  } catch (error) {
    res.status(500).json({ error: "Failed to chat" });
  }
});

if (process.env.NODE_ENV !== "production") {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  const distPath = path.join(process.cwd(), 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => { res.sendFile(path.join(distPath, 'index.html')); });
}
export default app;
