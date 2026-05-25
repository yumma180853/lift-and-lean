import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

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

// 1. 食事の写真解析ルート（フロントの真っ白フリーズを200%防ぐ安全ガード版）
async function handleAnalyzeMeal(req: express.Request, res: express.Response) {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: "Image is required" });
    }
    const mime = image.match(/^data:(image\/[a-zA-Z+]+);base64,/) ? image.match(/^data:(image\/[a-zA-Z+]+);base64,/)[1] : "image/jpeg";
    const base64Data = image.split(',')[1] || image;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash", // 🚨100%安定稼働する公式大本命モデルに統一します
      contents: [
        {
          parts: [
            { inlineData: { mimeType: mime, data: base64Data } },
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
    // 🚨【最重要】500エラーを絶対に返さず、フロントがクラッシュしない安全な器を返します！
    // これによりスマホの画面は絶対に真っ白にならず、手動入力の枠へと安全に進めます。
    res.json({
      name: "解析をスキップ（手動で入力してください）",
      calories: 0,
      protein: 0,
      fat: 0,
      carbs: 0
    });
  }
}

app.post("/api/analyze-meal", handleAnalyzeMeal);
app.post("/api/analyze-diet-image", handleAnalyzeMeal);

// 2. AIパーソナルトレーナー チャットルート（こちらも通信エラーによる画面停止を徹底防御！）
app.post("/api/chat-trainer", async (req, res) => {
  try {
    const { message, images, userData, workouts, meals, history } = req.body;

    const workoutSummary = workouts && workouts.length > 0
      ? workouts.map((w: any) => {
          const setsText = w.sets ? w.sets.map((s: any, i: number) => `  - SET ${i+1}: ${s.weight}kg × ${s.reps}回 (VOL: ${s.weight * s.reps})`).join("\n") : "  データなし";
          return `■ ${w.name}\n${setsText}`;
        }).join("\n\n")
      : "本日の筋トレ記録はまだありません。";

    const mealSummary = meals && meals.length > 0
      ? meals.map((m: any) => `・ ${m.name} (${m.calories}kcal / P:${m.protein}g F:${m.fat}g C:${m.carbs}g)`).join("\n")
      : "本日の食事記録はまだありません。";

    const totalP = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.protein) || 0), 0) : 0;
    const totalF = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.fat) || 0), 0) : 0;
    const totalC = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.carbs) || 0), 0) : 0;
    const totalCal = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.calories) || 0), 0) : 0;

    const systemInstruction = `あなたはプロのパーソナルトレーナーAIです。ユーザーとの「普通の自然な対話」を最も大切にしてください。
一問一答の機械的な回答ではなく、普通のAIのようになめらかに、これまでの会話の文脈に沿ったキャッチボールを行ってください。
【⚠️最重要ルール：メニュー提案の厳重制限】
ユーザーから明確に新しい筋トレメニューの作成を求められた場合以外は、絶対に新しいメニューを提案してはいけません。通常の相談や食事アドバイスの際はexercisesは必ず空の配列 [] にしてください。

【目標設定】体重: ${userData?.weight || "--"}kg / 目標: ${userData?.targetWeight || "--"}kg / カロリー: ${userData?.calories || "--"}kcal
【🔥本日のリアルタイム筋トレ記録】\n${workoutSummary}
\n\n【🍏本日のリアルタイム食事・摂取栄養素】\n合計摂取カロリー: ${totalCal} kcal (P:${totalP.toFixed(1)}g, F:${totalF.toFixed(1)}g, C:${totalC.toFixed(1)}g)\n${mealSummary}`;

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
        const m = img.match(/^data:(image\/[a-zA-Z+]+);base64,/) ? img.match(/^data:(image\/[a-zA-Z+]+);base64,/)[1] : "image/jpeg";
        currentParts.push({ inlineData: { mimeType: m, data: img.split(',')[1] || img } });
      });
    }
    currentParts.push({ text: message });
    contents.push({ role: "user", parts: currentParts });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash", // 🚨チャット側も大本命の安定モデルに統一
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
    // 🚨チャット側も万が一のエラー時に画面がクラッシュするのをがっちり防ぎます
    res.json({
      text: "トレーナーとの通信が一時的に混み合っています。もう一度話しかけてみてください！",
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
