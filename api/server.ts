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

// Vercelのサーバーレス環境（API Routes）として動くようにエクスポート
export default async function handler(req: any, res: any) {
  // CORSなどの暫定対応（必要に応じて）
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1️⃣ 食事画像解析エンドポイント
  if (req.url.includes("analyze-meal")) {
    try {
      const { image } = req.body;
      if (!image) return res.status(400).json({ error: "Image is required" });
      const base64Data = image.split(',')[1] || image;

      const response = await ai.models.generateContent({
        model: "gemini-1.5-flash", // 💡 製品版を見据えて安定の爆速1.5-flashに最適化
        contents: [
          {
            parts: [
              { inlineData: { mimeType: "image/jpeg", data: base64Data } },
              { text: "Analyze this meal image. Estimate the following: meal name, total calories (kcal), protein (g), fat (g), and carbohydrates (g). Provide reasonable estimates based on the visual contents. Return the result in Japanese." },
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

      return res.json(JSON.parse(response.text || "{}"));
    } catch (error: any) {
      console.error("Gemini Error:", error);
      return res.status(500).json({ error: error.message || "Failed to analyze image" });
    }
  }

  // 2️⃣ AIパーソナルトレーナー・チャットエンドポイント
  if (req.url.includes("chat-trainer")) {
    try {
      const { message, images, userData } = req.body;
      
      const prompt = `
        あなたはプロのパーソナルトレーナーAIです。
        ユーザーの目標達成のために、具体的で科学的な根拠に基づいたアドバイスを提供してください。
        
        【現在の状況】
        体重: ${userData?.weight || "未測定"}kg
        目標体重: ${userData?.targetWeight || "未設定"}kg
        目標カロリー: ${userData?.calories || "未設定"}kcal
        PFCバランス: P:${userData?.protein || 0}g, F:${userData?.fat || 0}g, C:${userData?.carbs || 0}g
        
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
          parts.push({ inlineData: { mimeType: "image/jpeg", data: base64Data } });
        });
      }

      parts.push({ text: message });

      const response = await ai.models.generateContent({
        model: "gemini-1.5-flash", // 💡 制限のない最強の爆速本物ブレイン
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json" },
      });

      return res.json(JSON.parse(response.text || "{}"));
    } catch (error: any) {
      console.error("Trainer Gemini Error:", error);
      return res.status(500).json({ error: error.message || "Failed to chat with AI trainer" });
    }
  }

  return res.status(444).json({ error: "Not found" });
}
