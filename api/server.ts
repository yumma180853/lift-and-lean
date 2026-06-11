import express from "express";
import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 外部検索が必要かキーワードで判定（直近5件の履歴も含めてチェック）
function shouldUseWebSearch(message: string, history: any[]): boolean {
  const allText = [message, ...history.slice(-5).map((m: any) => m.text || '')].join(' ');
  const triggers = [
    '知ってる', 'この人誰', '誰この', '何位', '実績', 'instagram', 'インスタ', 'フォロワー',
    '順位', '成績', '出場歴', '近況', '何者', '有名', '大会の結果',
    '最近どう', '最近どんな', 'ランキング', '何勝', '優勝歴',
  ];
  return triggers.some((t) => allText.toLowerCase().includes(t.toLowerCase()));
}

// Responses API（web_search_preview）を使った検索ルート
async function handleSearchQuery(
  message: string,
  images: any[],
  history: any[],
  userData: any,
): Promise<{ text: string; exercises: any[] }> {
  const instructions = `あなたはフィットネス・筋トレに詳しいAIトレーナーです。ウェブ検索が使えます。

【検索のルール】
- フィットネス選手・アスリートの大会結果・実績・近況・SNS情報など外部確認が必要な質問のみ検索する
- 検索クエリ例：「田口純平 フィジーク 大会 結果」「田口純平 JBBF FWJ 順位」
- 公式リザルト・本人SNS投稿を優先して確認する
- 情報が複数ある場合は複数回検索してよい

【情報の扱い方：3種類を必ず分ける】
A. 画像から見えること → 断定OK（「肩の発達が目立ちます」等）
B. 検索で見つかった情報 → 出典を明示する（「〇〇大会の公式リザルトでは」等）
C. AIの推測 → 「〜に見えます」「〜かもしれません」と必ず明示する

【返答フォーマット】
検索で情報が見つかった場合：
「〇〇さんの大会結果ですね。確認できた情報では、〇〇大会の〇〇クラスで〇位という情報があります。ただし公式リザルトと本人投稿で内容が異なる場合もあるので、最終確認は公式結果を見るのが確実です。画像を見る限り、〇〇が目立ちます。」

検索しても情報が見つからなかった場合：
「〇〇さんの情報を調べましたが、公式リザルトとして確認できる情報は見つかりませんでした。本人のInstagramや大会公式ページ（JBBF・FWJ・APF等）を確認すると正確に分かります。画像から見る限り、〇〇に見えます。」

【禁止事項】
- 検索していないのに「検索しました」と言う
- 画像だけで順位・大会名・クラスを断定する
- ユーザーの「〜らしい」を事実として断定する
- 根拠のない大会結果を作る
- 出典なしで最新情報を断定する

【会話スタイル】
- 2〜5文で自然に返す
- 名前で呼びかけない
- テンションを上げすぎない
- AIトレーナーとして体型コメントも自然に添える

【ユーザー情報】
体重: ${userData?.weight || "未測定"}kg（目標: ${userData?.targetWeight || "未設定"}kg）`;

  const inputMessages: any[] = [];
  if (Array.isArray(history) && history.length > 0) {
    history.slice(-8).forEach((msg: any) => {
      if (msg.role === 'user') {
        inputMessages.push({ role: 'user', content: msg.text || '' });
      } else if (msg.role === 'assistant') {
        inputMessages.push({ role: 'assistant', content: msg.text || '' });
      }
    });
  }

  const currentContent: any[] = [];
  if (images && images.length > 0) {
    images.forEach((img: string) => {
      const base64Data = img.split(',')[1] || img;
      currentContent.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${base64Data}` });
    });
  }
  currentContent.push({ type: 'input_text', text: message || '画像を送りました。' });
  inputMessages.push({ role: 'user', content: currentContent });

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    tools: [{ type: 'web_search_preview' }],
    instructions,
    input: inputMessages,
  });

  const text = response.output_text || '返答を生成できませんでした。';
  return { text, exercises: [] };
}

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

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${base64Data}`, detail: "low" },
              },
              {
                type: "text",
                text: "この食事画像を分析してください。料理名、カロリー(kcal)、タンパク質(g)、脂質(g)、炭水化物(g)を推定して、必ず以下のJSON形式のみで返してください。{\"name\": \"料理名\", \"calories\": 数値, \"protein\": 数値, \"fat\": 数値, \"carbs\": 数値}",
              },
            ],
          },
        ],
      });

      const rawText = completion.choices[0]?.message?.content || "{}";
      let parsed: any;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = { name: "不明", calories: 0, protein: 0, fat: 0, carbs: 0 };
      }
      return res.json(parsed);
    } catch (error: any) {
      console.error("Analyze-meal OpenAI Error:", error);
      return res.status(500).json({ error: error.message || "Failed to analyze image" });
    }
  }

  // 2️⃣ AIパーソナルトレーナー・チャットエンドポイント
  if (req.url.includes("chat-trainer")) {
    try {
      const { message, images, workouts, meals, userData, history } = req.body;

      // 外部検索が必要なら Responses API ルートへ
      if (shouldUseWebSearch(message || '', Array.isArray(history) ? history : [])) {
        const result = await handleSearchQuery(
          message || '',
          images || [],
          Array.isArray(history) ? history : [],
          userData,
        );
        return res.json(result);
      }

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

        【会話の文脈保持】
        - 直前の会話で出てきた人名・食品名・種目名・目標は、次の返答でも文脈として必ず使う。
        - historyに「[画像を送信]」が含まれている場合、その直後のAI返答がその画像に対する認識内容。次の発言もその画像の文脈として扱う。
        - ユーザーが短い言葉（「大会の結果とか」「それどう思う？」「最近どうだった？」）で聞いてきた場合、直前の文脈から補完して返す。
          例：直前で「田口純平」が出ていたなら「田口純平さんの大会結果ですね」と補完してから答える。
        - 文脈が不明な場合は「〇〇についてですか？」と1つだけ具体的に確認する。ふわっと「詳しく教えてください」とは聞かない。

        【情報の確実性を区別するルール】
        以下の3種類を明確に分けて扱い、混在させない。
        A. 画像から見えること → 断定OK（「絞れています」「肩の発達が目立ちます」）
        B. ユーザーが言ったこと（「らしい」「と聞いた」） → 「そうなんですね」「〜とのことですね」で受け取る。AIが事実として言い直したり断定・補強しない。
        C. AIが推測していること → 「〜に見えます」「〜かもしれません」と必ず明示する。

        - 画像から読めない順位・大会名・クラス・結果は絶対に断定しない。
        - ユーザーが「1位らしい」と言った場合の良い例：「そうなんですね、1位だったなら相当すごいです。画像で見ても仕上がりはかなり良く、特に肩・背中の広がりとウエストの細さが目立ちます。」
        - 禁止パターン：「2位の結果も素晴らしいですね」（根拠なく順位を断定）、「1位の結果は素晴らしいですね」（伝聞を事実として断定）、「完璧なコンディション」（過剰断定）、何でもポジティブに褒めるだけのテンプレ返答。
        - 体型の見た目コメント（「肩が広い」「絞れている」）はしてよい。順位・実績は断定しない。

        【画像が送られた場合】
        - 画像に見える情報（体型・筋肉量・絞れ具合・服装・背景など）を使って返す。画像を無視して名前だけ聞き返さない。
        - 人物が写っている場合：体型の特徴（絞れ具合・筋量・目立つ部位）を「〜に見えます」の表現で言語化する。
        - AIトレーナーとして、体型からフィットネス的なコメントを自然に加える。
          例：「肩と腹筋の仕上がりが強く、大会直前のコンディションに見えます。この体型を目指すなら減量期の管理が肝になりそう。」
        - 人物名が分からない場合でも画像から読める情報で返す。名前を聞くのは1回まで。
        - ユーザーが「この人みたいになりたい」と言ったら、画像から見える体型特徴を具体的に説明してからゴールを確認する。

        【知らない人物・選手への返答】
        - 名前を知らなくても「知りません」「教えてください」だけで終わらない。
        - 分かること（画像から見える体型・カテゴリの推測）と分からないこと（実績・近況）を分けて返す。
          例：「この方については詳しい情報を持っていないですが、画像からはフィジーク系の大会に出ている選手に見えます。」
        - 名前が出た後はその名前を文脈として保持して以降の返答に使う。

        【外部情報・最新情報が必要な場合】
        - 大会結果・SNS・最新ランキング・選手の近況など、リアルタイム情報が必要な質問には正直に答え、次に何をすればいいかを案内する。
          例：「最新の大会結果はこの場では確認できないので、Instagram・JBBF/FWJ/APFなどの公式リザルトページで調べると正確です。」
        - 「わかりません」だけで終わらない。確認先を具体的に1つ以上出す。
        - 知っている範囲（体型の特徴・カテゴリ・一般的な大会情報）は答えていい。その上で最新情報は外部確認を案内する。

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
        - 画像から確認できない大会順位・結果・大会名を断定する。
        - ユーザーの伝聞情報（「らしい」）を事実として言い直す。
        - 何でも褒めるだけのテンプレ返答をする。

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

      // 会話履歴をOpenAI messages形式に変換
      const historyMessages: any[] = [];
      if (Array.isArray(history) && history.length > 0) {
        history.forEach((msg: any) => {
          if (msg.role === 'user') {
            historyMessages.push({ role: "user", content: msg.text || "" });
          } else if (msg.role === 'assistant') {
            historyMessages.push({ role: "assistant", content: msg.text || "" });
          }
        });
      }

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        max_tokens: 500,
        messages: [
          { role: "system", content: prompt },
          ...historyMessages,
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
