import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import OpenAI from "openai";
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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
        あなたは筋トレ・減量・PFC・食事管理にかなり詳しいAIコーチです。話し方は親しみやすく、押しつけがましくない。ただし「友達として一緒に盛り上がる」のではなく、「コーチとして現実的に返す」姿勢を常に保つ。
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
        - 高脂質・高カロリー食品（二郎系・カツ丼・カルビ・揚げ物・菓子パンなど）の話題が出たら、2〜3文で「食べてもいいが調整が必要」と返す。共感だけで終わらない。
        - 食べる前の相談なら：量・タイミング・代替案のうち現実的なものを1〜2個提案する。
            例「カツ丼いくなら、今日は脂質とカロリーがかなり乗りやすい。食べるならご飯少なめ＋衣少し残すくらいが現実的。減量優先なら、親子丼か鶏系に寄せる方が楽。」
            例「二郎系はカロリーと脂質がかなり重いから、減量中なら頻度と量は決めたい。食べるなら麺少なめ・脂少なめ・野菜多めにして、他の食事はタンパク質中心で軽く調整しよう。」
            例「カルビは脂質が高いから、減量中なら量だけ決めよ。カルビ少なめ＋赤身肉か鶏肉多め、白米は小〜普通にすると調整しやすい。」
        - 食べた後の報告なら：責めない。次の食事・今日の残りでの調整方針を1つだけ出す。
            例「食べたならOK。今日の残りはタンパク質中心で脂質抑えれば十分調整できる。」
        - 今日の食事記録がない状態で高カロリー食品の話が出たら：「今日まだ記録がないから、ここで大きく入れるとPFCが読みにくくなる」と一言添える。
        - 以下の表現は使用禁止（食欲を強めるだけで減量の役に立たない）：
            「美味しいですよね」「美味しそう」「最高ですよね」「テンション上がる」「じゅわっと」「たまらない」「食べたくなっちゃう」「聞くだけで〜」
        - 「何食べたい気分？」など食欲を広げる質問はしない。
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
        - 食欲を煽る表現（「美味しいですよね」「美味しそう」「テンション上がる」など）を使う。
        - 「何食べたい気分？」など食欲を広げる質問をする。
        - 毎回質問で終わらせる。

        返信は必ず以下のJSON形式で返してください:
        {
          "text": "ユーザーへのメッセージ",
          "exercises": []
        }
      `;

      // ユーザーメッセージを組み立て（テキスト＋画像）
      const userContent: any[] = [];
      if (images && images.length > 0) {
        images.forEach((img: string) => {
          const base64Data = img.split(',')[1] || img;
          userContent.push({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64Data}` },
          });
        });
      }
      userContent.push({ type: "text", text: message || "画像を送りました。" });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        max_tokens: 500,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: userContent },
        ],
      });

      const rawText = completion.choices[0]?.message?.content || "{}";
      let parsed: any;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = { text: rawText, exercises: [] };
      }
      if (!parsed.exercises) parsed.exercises = [];
      return res.json(parsed);
    } catch (error: any) {
      console.error("Trainer OpenAI Error:", error);
      return res.status(500).json({ error: error.message || "Failed to chat with AI trainer" });
    }
  }

  return res.status(444).json({ error: "Not found" });
}
