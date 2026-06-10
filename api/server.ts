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
        model: "gemini-2.5-flash", // 💡 廃止された旧モデルから、2026年最新の超爆速モデルへリプレイス！
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
      const { message, images, workouts, meals, userData } = req.body;

      // 今日のトレーニング内容を文字列化
      let workoutSummary = "（未記録）";
      if (Array.isArray(workouts) && workouts.length > 0) {
        const workout = workouts[0];
        if (Array.isArray(workout.exercises) && workout.exercises.length > 0) {
          workoutSummary = workout.exercises.map((ex: any) => {
            const sets = Array.isArray(ex.sets) && ex.sets.length > 0
              ? ex.sets.map((s: any) => `${s.weight}kg×${s.reps}回`).join(', ')
              : "セットなし";
            return `  - ${ex.name}：${sets}`;
          }).join('\n');
        } else {
          workoutSummary = "（記録開始済・種目未入力）";
        }
      }

      // 今日の食事と摂取合計・目標達成率を文字列化
      let mealSummary = "（未記録）";
      let totalCalories = 0, totalProtein = 0, totalFat = 0, totalCarbs = 0;
      if (Array.isArray(meals) && meals.length > 0) {
        mealSummary = meals.map((m: any) =>
          `  - ${m.name}（${m.calories}kcal / P:${m.protein}g F:${m.fat}g C:${m.carbs}g）`
        ).join('\n');
        meals.forEach((m: any) => {
          totalCalories += Number(m.calories) || 0;
          totalProtein  += Number(m.protein)  || 0;
          totalFat      += Number(m.fat)       || 0;
          totalCarbs    += Number(m.carbs)     || 0;
        });
      }
      const calGoal     = Number(userData?.calories) || 0;
      const proteinGoal = Number(userData?.protein)  || 0;
      const calPct     = calGoal     > 0 ? Math.round((totalCalories / calGoal)     * 100) : 0;
      const proteinPct = proteinGoal > 0 ? Math.round((totalProtein  / proteinGoal) * 100) : 0;

      const prompt = `
        あなたはプロのパーソナルトレーナーAIです。
        ユーザーの目標達成のために、具体的で科学的な根拠に基づいたアドバイスを提供してください。

        【ユーザーの基本情報】
        体重: ${userData?.weight || "未測定"}kg
        目標体重: ${userData?.targetWeight || "未設定"}kg
        1日の目標カロリー: ${calGoal || "未設定"}kcal
        1日の目標PFC: P:${userData?.protein || 0}g / F:${userData?.fat || 0}g / C:${userData?.carbs || 0}g

        【今日のトレーニング】
${workoutSummary}

        【今日の食事】
${mealSummary}
        摂取合計: ${Math.round(totalCalories)}kcal（目標の${calPct}%）/ P:${Math.round(totalProtein)}g（${proteinPct}%達成）/ F:${Math.round(totalFat)}g / C:${Math.round(totalCarbs)}g

        【指示】
        1. 上記の今日のトレーニングと食事状況を踏まえて、ユーザーのメッセージに具体的に答えてください。
        2. もし「現在の体」と「目標の体」の画像（2枚）が送られてきた場合、そのギャップを分析し、最適なメニューを提案してください。
        3. タンパク質の達成率が低い場合は、補食のアドバイスを積極的に行ってください。
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
        model: "gemini-2.5-flash", // 💡 404エラーを完全に葬り去る本物の次世代ブレイン！
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
