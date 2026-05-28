import express from "express";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import webpush from "web-push";
import { kv } from "@vercel/kv";

dotenv.config();

const publicKey = "BEFkZqIn2Xp-B9yjenzQLjzGXqGorbZPYI7qHfjC8qrYKmbP81KLM54WzVPrBx0ErP5ITrv0SGms7goEfPyQHeg";
const privateKey = "XZBvEvk2fSZ1NagRfbqweXGizvxBk99nUAvaewhC6tA";
webpush.setVapidDetails("mailto:test@example.com", publicKey, privateKey);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
});

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get("/api/wp-public-key", (req, res) => {
  res.json({ publicKey });
});

// 毎日朝7時、データベースに登録されている「全員のスマホ」へ一斉に自動大砲を発射！
app.get("/api/cron-morning-reminder", async (req, res) => {
  try {
    const subs: any[] = await kv.get("push_subscriptions") || [];
    const promises = subs.map(sub => 
      webpush.sendNotification(sub, JSON.stringify({
        title: "LIFT & LEAN",
        body: "おはようございます！今日の体重を記録しましょう。🔥"
      })).catch(e => console.error("送信失敗した宛先をスキップ:", e))
    );
    await Promise.all(promises);
    res.json({ success: true, count: subs.length });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// オンならデータベースに追加、オフならデータベースから自動削除するハイテク処理
app.post("/api/send-test-notification", async (req, res) => {
  try {
    const { subscription, action } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: "No sub" });
    
    let subs: any[] = await kv.get("push_subscriptions") || [];
    
    if (action === "unsubscribe") {
      subs = subs.filter(s => s.endpoint !== subscription.endpoint);
      await kv.set("push_subscriptions", subs);
      return res.json({ success: true, message: "Unsubscribed" });
    }

    if (!subs.some(s => s.endpoint === subscription.endpoint)) {
      subs.push(subscription);
      await kv.set("push_subscriptions", subs);
    }

    await webpush.sendNotification(subscription, JSON.stringify({
      title: "LIFT & LEAN リマインダー",
      body: "通知の連携が完了しました！明日から毎朝7時に自動でチェックします。🔥"
    }));

    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: String(error) }); }
});

// 1. 食事の写真解析ルート（ここは速度重視でFlashのままキープ！）
app.post("/api/analyze-diet-image", async (req, res) => {
  try {
    const { image } = req.body;
    if ( !image ) return res.status(400).json({ error: "Image is required" });
    const mime = image.match(/^data:(image\/[a-zA-Z+]+);base64,/) ? image.match(/^data:(image\/[a-zA-Z+]+);base64,/)[1] : "image/jpeg";
    const base64Data = image.split(',')[1] || image;
    
    let response;
    let attempts = 0;
    while (attempts < 3) {
      try {
        response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: base64Data } }, { text: "Analyze this meal image. Estimate the following: meal name, total calories (kcal), protein (g), fat (g), and carbohydrates (g). Return the result in Japanese." } ] }],
          config: { responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { success: { type: "BOOLEAN" }, name: { type: "STRING" }, mealName: { type: "STRING" }, calories: { type: "NUMBER" }, protein: { type: "NUMBER" }, fat: { type: "NUMBER" }, carbs: { type: "NUMBER" } }, required: ["success", "name", "mealName", "calories", "protein", "fat", "carbs"] } }
        });
        break;
      } catch (err) {
        attempts++;
        if (attempts >= 3) throw err;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    let text = response.text || "{}";
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(text);
    res.json({ success: true, name: parsed.name || parsed.mealName || "解析された料理", mealName: parsed.mealName || parsed.name || "解析された料理", calories: Number(parsed.calories) || 0, protein: Number(parsed.protein) || 0, fat: Number(parsed.fat) || 0, carbs: Number(parsed.carbs) || 0 });
  } catch (error: any) {
    const errStr = String(error);
    const isQuota = errStr.includes("429") || errStr.includes("Quota") || error?.status === 429;
    res.json({ success: true, name: isQuota ? "解析制限（無料枠の上限に達しました。明日復活します）" : "解析スキップ（手動入力してください）", mealName: isQuota ? "解析制限（無料枠の上限に達しました。明日復活します）" : "解析スキップ（手動入力してください）", calories: 0, protein: 0, fat: 0, carbs: 0 });
  }
});

// 2. AIパーソナルトレーナー チャットルート
app.post("/api/chat-trainer", async (req, res) => {
  try {
    const { message, images, userData, workouts, meals, history } = req.body;
    const workoutSummary = workouts && workouts.length > 0 ? workouts.map((w: any) => `■ ${w.name}\n` + (w.sets ? w.sets.map((s: any, i: number) => `  - SET ${i+1}: ${s.weight}kg × ${s.reps}回`).join("\n") : "")).join("\n\n") : "なし";
    const totalP = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.protein) || 0), 0) : 0;
    const totalF = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.fat) || 0), 0) : 0;
    const totalC = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.carbs) || 0), 0) : 0;
    const totalCal = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.calories) || 0), 0) : 0;
    
    // 🚨【裏指示書の超・大改造】解剖学、運動生理学、スポーツ栄養学のプロ知識を叩き込むプロンプト！
    const systemInstruction = `あなたは超一流のプロパーソナルトレーナーAIです。
【思考・回答プロセス】
1. ユーザーから食事内容、筋トレログ、写真が送られてきたら、まずその日の努力や成果を必ずポジティブに全力で褒めちぎり、モチベーションを最高潮に引き上げてください。
2. 解剖学、運動生理学、スポーツ栄養学の科学的エビデンスに基づき、抽象的な表現ではなく「超具体的かつ実践的」にアドバイスを生成してください。
3. ユーザーの現在の体重、目標体重、目標PFCバランス、および本日入力された「筋トレ履歴」「食事履歴」の数値を完全に分析してください。
4. 目標値に対して、本日の摂取カロリーやPFCバランスが「あと何g、何kcal足りないか」または「どれくらいオーバーしているか」を明確に数値ベースで指摘してください。
5. ユーザーが次に行うべき具体的なアクション（例：「あとタンパク質が30g足りないので、コンビニのギリシャヨーグルトとサラダチキンをプラスしよう！」「明日は胸と三頭筋の日だね、この種目を追加すると効果的だよ！🔥」など）を最低1つ以上、明確に提案してください。

【トーン＆マナー】
* 情熱的でポジティブ、絶対に否定せず、ユーザーの心に寄り添う親切で頼りになるカリスマトレーナーの口調（例：「〜だよ！」「〜していこう！🔥」）。
* 専門用語を使う場合は、初心者にも一瞬でわかるように噛み砕いて説明すること。
* 要望がない限りexercisesは必ず空の配列 [] にしてください。

【目標】体重: ${userData?.weight || "--"}kg / 目標: ${userData?.targetWeight || "--"}kg / カロリー: ${userData?.calories || "--"}kcal\n【本日の筋トレ】\n${workoutSummary}\n【本日の食事】\n合計: ${totalCal}kcal (P:${totalP.toFixed(1)}g, F:${totalF.toFixed(1)}g, C:${totalC.toFixed(1)}g)`;
    
    let contents = [];
    if (history && Array.isArray(history)) { contents = history.map((h: any) => ( { role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text || h.message || "" }] } )); }
    
    const currentParts = [];
    if (images && images.length > 0) {
      images.forEach((img: string) => {
        const m = img.match(/^data:(image\/[a-zA-Z+]+);base64,/) ? img.match(/^data:(image\/[a-zA-Z+]+);base64,/)[1] : "image/jpeg";
        currentParts.push({ inlineData: { mimeType: m, data: img.split(',')[1] || img } });
      });
    }
    
    const finalMessage = message && message.trim() ? message : "この写真を見て、今日の食事やトレーニングへのアドバイス、またはモチベーションが上がる言葉をください！";
    currentParts.push({ text: finalMessage }); 
    contents.push({ role: "user", parts: currentParts });
    
    let response;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        // 🚨【脳みそのコンバート】モデルを「gemini-2.5-flash」から、高度な推論ができる最上位の「gemini-2.5-pro」へ大アップグレード！！！
        response = await ai.models.generateContent({ 
          model: "gemini-2.5-pro", 
          contents, 
          config: { systemInstruction, responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { text: { type: "STRING" }, exercises: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, reps: { type: "NUMBER" }, sets: { type: "NUMBER" } }, required: ["name", "reps", "sets"] } } }, required: ["text", "exercises"] } } 
        });
        break;
      } catch (err) {
        attempts++;
        if (attempts >= maxAttempts) throw err;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    let rawText = response.text || "{}"; rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(rawText);
    res.json({ text: parsed.text || "お返事の作成中に少し迷ってしまいました。もう一度話しかけてみてください！", exercises: Array.isArray(parsed.exercises) ? parsed.exercises : [] });
  } catch (error) {
    const errStr = String(error); const isQuota = errStr.includes("429") || errStr.includes("Quota") || error?.status === 429;
    res.json({ text: isQuota ? "【Gemini AIの無料制限】1日の無料利用枠（20回）の上限に達しました！数時間〜明日になると自動リセットされて満タンになりますので、しばらく時間を置いてからもう一度話しかけてみてください！" : "トレーナーAIとの通信に一時的なエラーが発生しました。もう一度だけ送ってみていただけますか？", exercises: [] });
  }
});

if (process.env.NODE_ENV !== "production") {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" }); app.use(vite.middlewares);
} else {
  const distPath = path.join(process.cwd(), 'dist'); app.use(express.static(distPath));
  app.get('*', (req, res) => { res.sendFile(path.join(distPath, 'index.html')); });
}
export default app;
