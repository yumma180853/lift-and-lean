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

// 1. 食事の写真解析ルート
app.post("/api/analyze-meal", async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: "Image is required" });
    }
    const base64Data = image.split(',')[1] || image;
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: base64Data } },
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
    console.error("Gemini Error:", error ) ;
    res.status(500).json({ error: error.message || "Failed to analyze image" });
  }
});

// 2. AIパーソナルトレーナー チャットルート（食事・筋トレ完全連動＆お留守番対策版！）
app.post("/api/chat-trainer", async (req, res) => {
  try {
    const { message, images, userData, workouts, meals } = req.body;

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

    const prompt = `
あなたはプロのパーソナルトレーナーAIです。
ユーザーが入力した本日の筋トレ内容や食事ログを完全に把握した上で、具体的で科学的な根拠に基づいた「オリジナルのアドバイス」を毎回考えて提供してください。テンプレ文章をそのまま返してはいけません。

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

【トレーナーへの指示】
1. ユーザーから言われなくても、上記の「今日の筋トレ内容」や「食事のPFCバランス」を自動的にチェックし、具体的に褒めたり、目標値に対するアドバイスを最初から会話に盛り込んでください。必ず毎回、ユーザーの実際の記録に応じた個別のメッセージを生成してください。
2. もし「現在の体」と「目標の体」の画像（2枚）が送られてきた場合、そのギャップを分析し、最適なメニューを提案してください。
3. 毎回、必ず「現在の筋肉痛の有無・部位」や「今日の体調」を最後に質問してください。
回答は常に元気で親しみやすく、かつ誠実な態度で行ってください。
`;

    const parts: any[] = [{ text: prompt }];
    if (images && images.length > 0) {
      images.forEach((img: string) => {
        const base64Data = img.split(',')[1] || img;
        parts.push({
          inlineData: { mimeType: "image/jpeg", data: base64Data }
        });
      });
    }
    parts.push({ text: message });

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ role: "user", parts }],
      config: { 
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            text: { 
              type: Type.STRING, 
              description: "ユーザーへの親身で具体的なオリジナルアドバイス（今日の食事や筋トレのフィードバックを含めてください）" 
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
              description: "新しく提案する筋トレメニューのリスト（ない場合は空の配列 []）"
            }
          },
          required: ["text", "exercises"]
        }
      },
    });

    const result = JSON.parse(response.text || "{}");
    res.json(result);
  } catch (error: any) {
    console.error("Trainer Gemini Error:", error);
    res.status(500).json({ error: error.message || "Failed to chat with AI trainer" });
  }
});

// 開発環境と本番環境の振り分け設定
if (process.env.NODE_ENV !== "production") {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const distPath = path.join(process.cwd(), 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

export default app;
