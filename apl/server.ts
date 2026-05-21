import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
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

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // API Route: Analyze Meal Image
  app.post("/api/analyze-meal", async (req, res) => {
    try {
      const { image } = req.body; // base64 string
      if (!image) {
        return res.status(400).json({ error: "Image is required" });
      }

      // Extract base64 part
      const base64Data = image.split(',')[1] || image;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Data,
                },
              },
              {
                text: "Analyze this meal image. Estimate the following: meal name, total calories (kcal), protein (g), fat (g), and carbohydrates (g). Provide reasonable estimates based on the visual contents. Return the result in Japanese.",
              },
            ],
          },
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

  // API Route: AI Personal Trainer Chat
  app.post("/api/chat-trainer", async (req, res) => {
    try {
      const { message, images, userData } = req.body;
      
      const prompt = `
        あなたはプロのパーソナルトレーナーAIです。
        ユーザーの目標達成のために、具体的で科学的な根拠に基づいたアドバイスを提供してください。
        
        【現在の状況】
        体重: ${userData.weight}kg
        目標体重: ${userData.targetWeight}kg
        目標カロリー: ${userData.calories}kcal
        PFCバランス: P:${userData.protein}g, F:${userData.fat}g, C:${userData.carbs}g
        
        【指示】
        1. ユーザーからのメッセージに答え、モチベーションを高めてください。
        2. もし「現在の体」と「目標の体」の画像（2枚）が送られてきた場合、そのギャップを分析し、最適なメニューを提案してください。
        3. 毎回、必ず「現在の筋肉痛の有無・部位」や「今日の体調」を質問してください。
        4. トレーニングメニューを提案する場合は、以下のJSONフォーマットの配列を "exercises" フィールドに含めてください。
           {"name": "種目名", "reps": 回数, "sets": セット数}
        
        回答は常に元気で親しみやすく、かつ誠実な態度で行ってください。
        
        返信は必ず以下のJSON形式で返してください:
        {
          "text": "ユーザーへのメッセージ",
          "exercises": [{"name": "種目名", "reps": 10, "sets": 3}] // 提案がある場合のみ
        }
      `;

      const parts: any[] = [{ text: prompt }];
      
      if (images && images.length > 0) {
        images.forEach((img: string) => {
          const base64Data = img.split(',')[1] || img;
          parts.push({
            inlineData: {
              mimeType: "image/jpeg",
              data: base64Data,
            },
          });
        });
      }

      parts.push({ text: message });

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ role: "user", parts }],
        config: {
          responseMimeType: "application/json",
        },
      });

      const result = JSON.parse(response.text || "{}");
      res.json(result);
    } catch (error: any) {
      console.error("Trainer Gemini Error:", error);
      res.status(500).json({ error: error.message || "Failed to chat with AI trainer" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
