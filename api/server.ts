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

// 1. 食事の写真解析ルート（フロントの気絶を200%防ぐ、超安全データ保証版！）
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

    // 🚨AIの返答から余計なマークダウン装飾（```json）などを綺麗にお掃除
    let rawText = response.text || "{}";
    rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(rawText);

    // 🚨【最重要】データが万が一空っぽ（{}）でも、フロントに必ず安全な初期値を届ける！
    // これにより、スマホ画面側のReactがパニックを起こして真っ白になるのを完全に防ぎます。
    res.json({
      name: parsed.name || "解析された料理",
      calories: Number(parsed.calories) || 0,
      protein: Number(parsed.protein) || 0,
      fat: Number(parsed.fat) || 0,
      carbs: Number(parsed.carbs) || 0
    });

  } catch (error: any) {
    console.error("Gemini Error:", error);
    // 万が一の通信エラー時も画面を絶対に真っ白にさせない安全な身代わりデータ
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

// 2. AIパーソナルトレーナー チャットルート（こちらも不完全なJSONによる画面クラッシュを徹底防御！）
app.post("/api/chat-trainer", async (req, res) => {
  try {
    const { message, images, userData, workouts, meals, history } = req.body;
    
    const workoutSummary = workouts && workouts.length > 0
      ? workouts.map((w: any) => `■ ${w.name}\n` + (w.sets ? w.sets.map((s: any, i: number) => `  - SET ${i+1}: ${s.weight}kg × ${s.reps}回`).join("\n") : ""))
      : "なし";

    const mealSummary = meals && meals.length > 0
      ? meals.map((m: any) => `・ ${m.name} (${m.calories}kcal / P:${m.protein}g F:${m.fat}g C:${m.carbs}g)`)
      : "なし";

    const totalP = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.protein) || 0), 0) : 0;
    const totalF = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.fat) || 0), 0) : 0;
    const totalC = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.carbs) || 0), 0) : 0;
    const totalCal = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.calories) || 0), 0) : 0;

    const systemInstruction = `あなたはプロのパーソナルトレーナーAIです。ユーザーとの「普通の自然な対話」を最も大切にしてください。
【⚠️超重要：画像認識ルール】
あなたには、ユーザーから送られてきた写真や画像（食事、体型、トレーニング風景など）が「100%完全に直接見えています」。
絶対に「私はテキストベースのAIなので画像が見えません」と言い訳や嘘をついてはいけません。具体的にアドバイスしてください。
【⚠️最重要ルール：メニュー提案の厳重制限】
要望がない限りexercisesは必ず空の配列 [] にしてください。

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

    // チャット側も、万が一プロパティが欠けていても絶対にフロントを落とさない安全ガード！
    res.json({
      text: parsed.text || "お返事の作成中に少し迷ってしまいました。もう一度話しかけてみてください！",
      exercises: Array.isArray(parsed.exercises) ? parsed.exercises : []
    });

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
