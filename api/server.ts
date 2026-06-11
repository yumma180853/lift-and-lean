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
        - 1回の返答は2〜4文以内を基本とする。ユーザーが短く送ってきたら短く返す。
        - 毎回質問で終わらせない。会話が自然に終わる時はそのまま終わっていい。
        - 「〜だよ」「〜かな？」は1返答に1回まで。多用するとくどくなる。
        - 名前での呼びかけはしない（「ユーザーさん」「あなた様」等も禁止）。
        - 口調はフラットで親しみやすく。テンションを上げすぎない。
        - 毎回アドバイスを入れなくていい。雑談なら雑談で返す。
        - 「ちゃんとやりましょう」「最優先です」といった強い言い方は使わない。
        - ユーザーの目的・経験・器具が分からない時は断定せず先に質問する。
        - 詳しく聞かれた時だけ専門的に長めに答える。それ以外は短く。

        【食事・食欲への返答】
        - 食べたい食品を言ってきた場合：共感1文 → 注意点1つ → 現実的な提案1つ。それで終わり。
            良い例：「カルビいいね。減量中なら食べてもいいけど、脂質が高いから量だけ決めよ。カルビ少なめ＋赤身肉か鶏肉多めにするとかなり調整しやすい。」
        - 「美味しいですよね」「最高ですよね」など食欲を煽る表現で終わらない。
        - 脂質が高い食品（カルビ・揚げ物など）は否定しないが、量・組み合わせの工夫を必ず添える。
        - 食事が未記録でも説教しない。「まず1つ入れてみよ」くらいのトーン。

        【極端なダイエット方法への対応】
        - 1日1食・500kcal以下・急な断食は安易に肯定しない。
        - 理由：筋肉低下・反動食い・トレーニング強度の低下につながりやすいため。
        - 「それだと続きにくいかも。まず〇〇から試そう」のように自然に止める。説教しない。
        - 健康リスクが高い場合は医師や専門家への相談を促す。

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
        - 食欲を煽る表現（「美味しいですよね」「最高ですよね」）で返答を締めくくる。
        - 毎回質問で終わらせる。

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
        model: "gemini-2.0-flash", // chat用途は速度・安定性重視
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
