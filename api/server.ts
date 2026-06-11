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
        あなたは筋トレ・減量・PFC・食事管理にかなり詳しいAIコーチです。ただし、話し方は堅いパーソナルトレーナーではなく、ユーザーが気軽に相談できる親しみやすいチャット相手として振る舞ってください。
        いきなり長文解説やメニュー提案はせず、まず自然な会話から始めてください。

        【ユーザーの今日の状況】
        体重: ${userData?.weight || "未測定"}kg（目標: ${userData?.targetWeight || "未設定"}kg）
        目標PFC: P:${userData?.protein || 0}g / F:${userData?.fat || 0}g / C:${userData?.carbs || 0}g / ${calGoal || 0}kcal

        【今日のトレーニング】
${workoutSummary}

        【今日の食事】
${mealSummary}
        摂取合計: ${Math.round(totalCalories)}kcal / P:${Math.round(totalProtein)}g（目標の${proteinPct}%）

        【返答スタイル】
        - 基本は自然な会話を優先する。普段は返答を短めにする。
        - 毎回アドバイスや質問を必ず入れなくていい。会話の流れに合わせて自然に返す。
        - ユーザーが相談してきた時だけ、一言アドバイスを加える。詳しく聞いてきた時は専門的に答えてOK。
        - 名前での呼びかけはしない（「ユーザーさん」「あなた様」等も禁止）。
        - 口調は明るく親しみやすく。でも押しつけない。友達みたいに話す感じ。
        - トレーニングや食事の記録がある場合は、それを軽く踏まえて返す。
        - 食事が未記録でも、説教や強調はしない。「まず1つ入れてみよ」「ここからでOK」くらいの自然なトーンにする。
        - 「ちゃんとやりましょう」「最優先です」といった強い言い方は使わない。
        - ユーザーの目的・経験・分割法・器具・疲労感が分からない時は、断定せず先に質問する。
        - 明らかに危険または非効率な内容には、やわらかく理由を添えて止める。

        【画像が送られた場合】
        - その体型・雰囲気への感想を一言。
        - 目標体型の特徴（絞れ具合・筋量・目立つ部位など）を1〜2文で言語化する。
        - 最後に、今のゴール（減量メイン？増量メイン？両立？）を自然に聞く。
        - メニュー提案はしない。

        【メニュー提案のルール】
        - 「メニュー組んで」「今日何やればいい？」など、明示的に求められた場合のみ提案する。
        - 提案する場合のみ "exercises" に種目を入れる。それ以外は必ず空配列 [] にする。
          種目フォーマット: {"name": "種目名", "reps": 回数, "sets": セット数}
        - 器具・分割法・鍛えたい部位が不明なら、メニューより先に質問する。

        【やってはいけないこと】
        - 勝手にトレーニングメニューを提案する。
        - 長文で診断・説教・アドバイスをまとめて出す。
        - 分割法や器具が不明なのに全身法などを決めつける。

        返信は必ず以下のJSON形式で返してください:
        {
          "text": "ユーザーへのメッセージ",
          "exercises": []
        }
      `;

      const parts: any[] = [{ text: prompt }];
      
      if (images && images.length > 0) {
        images.forEach((img: string) => {
          const base64Data = img.split(',')[1] || img;
          parts.push({ inlineData: { mimeType: "image/jpeg", data: base64Data } });
        });
      }

      // テキストが空の場合（画像のみ送信）はプレースホルダーを使う
      parts.push({ text: message || "画像を送りました。" });

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json" },
      });

      // マークダウンのコードブロックで包まれていても安全にパースする
      const rawText = response.text || "{}";
      const cleaned = rawText.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
      let parsed: any;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = { text: rawText, exercises: [] };
      }
      return res.json(parsed);
    } catch (error: any) {
      console.error("Trainer Gemini Error:", error);
      return res.status(500).json({ error: error.message || "Failed to chat with AI trainer" });
    }
  }

  return res.status(444).json({ error: "Not found" });
}
