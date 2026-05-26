import express from "express";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import webpush from "web-push";
import { kv } from "@vercel/kv"; // 🚨さっき繋いだ無料データベースを召喚！

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

// 🚨【大手術】毎日朝7時、データベースに登録されている「全員のスマホ」へ一斉に自動大砲を発射！
app.get("/api/cron-morning-reminder", async (req, res) => {
  try {
    // データベースから全員分の住所リスト（大砲の宛先）をガサッと一括取得
    const subs: any[] = await kv.get("push_subscriptions") || [];
    
    // 全員に向けて弾幕発射！
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

// 🚨【大手術】通知ボタンが押されたら、その人のスマホ住所をデータベースに自動で書き込む！
app.post("/api/send-test-notification", async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: "No sub" });
    
    // 1. 今ある住所リストをノートから読み出す
    const subs: any[] = await kv.get("push_subscriptions") || [];
    
    // 2. すでに同じ住所がなければ、新しくノートに追記する
    if (!subs.some(s => s.endpoint === subscription.endpoint)) {
      subs.push(subscription);
      await kv.set("push_subscriptions", subs);
    }

    // 3. 登録完了の記念に、その場で即時テスト大砲を発射！
    await webpush.sendNotification(subscription, JSON.stringify({
      title: "LIFT & LEAN システム開通",
      body: "データベースへの自動住所登録が完了しました！明日から毎朝自動で通知が届きます！🔥"
    }));

    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: String(error) }); }
});

// 1. 食事の写真解析ルート（いつもの無敵版！）
app.post("/api/analyze-diet-image", async (req, res) => {
  try {
    const { image } = req.body;
    if ( !image ) return res.status(400).json({ error: "Image is required" });
    const mime = image.match(/^data:(image\/[a-zA-Z+]+);base64,/) ? image.match(/^data:(image\/[a-zA-Z+]+);base64,/)[1] : "image/jpeg";
    const base64Data = image.split(',')[1] || image;
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: base64Data } }, { text: "Analyze this meal image. Estimate the following: meal name, total calories (kcal), protein (g), fat (g), and carbohydrates (g). Return the result in Japanese." } ] }],
      config: { responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { success: { type: "BOOLEAN" }, name: { type: "STRING" }, mealName: { type: "STRING" }, calories: { type: "NUMBER" }, protein: { type: "NUMBER" }, fat: { type: "NUMBER" }, carbs: { type: "NUMBER" } }, required: ["success", "name", "mealName", "calories", "protein", "fat", "carbs"] } }
    });
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

// 2. AIパーソナルトレーナー チャットルート（いつもの無敵版！）
app.post("/api/chat-trainer", async (req, res) => {
  try {
    const { message, images, userData, workouts, meals, history } = req.body;
    const workoutSummary = workouts && workouts.length > 0 ? workouts.map((w: any) => `■ ${w.name}\n` + (w.sets ? w.sets.map((s: any, i: number) => `  - SET ${i+1}: ${s.weight}kg × ${s.reps}回`).join("\n") : "")).join("\n\n") : "なし";
    const totalP = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.protein) || 0), 0) : 0;
    const totalF = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.fat) || 0), 0) : 0;
    const totalC = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.carbs) || 0), 0) : 0;
    const totalCal = meals ? meals.reduce((sum: number, m: any) => sum + (Number(m.calories) || 0), 0) : 0;
    const systemInstruction = `あなたはプロのパーソナルトレーナーAIです。ユーザーとの普通の自然な対話を最も大切にしてください。ユーザーから送られてきた写真は100%完全に見えています。具体的にアドバイスしてください。要望がない限りexercisesは必ず空の配列 [] にしてください。【目標】体重: ${userData?.weight || "--"}kg / 目標: ${userData?.targetWeight || "--"}kg / カロリー: ${userData?.calories || "--"}kcal\n【本日の筋トレ】\n${workoutSummary}\n【本日の食事】\n合計: ${totalCal}kcal (P:${totalP.toFixed(1)}g, F:${totalF.toFixed(1)}g, C:${totalC.toFixed(1)}g)`;
    let contents = [];
    if (history && Array.isArray(history)) { contents = history.map((h: any) => ( { role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text || h.message || "" }] } )); }
    const currentParts = [];
    if (images && images.length > 0) { images.forEach((img: string) => { const m = img.match(/^data:(image\/[a-zA-Z+]+);base64,/) ? img.match(/^data:(image\/[a-zA-Z+]+);base64,/)[1] : "image/jpeg"; currentParts.push({ inlineData: { mimeType: m, data: img.split(',')[1] || img } }); }); }
    currentParts.push({ text: message }); contents.push({ role: "user", parts: currentParts });
    const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents, config: { systemInstruction, responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { text: { type: "STRING" }, exercises: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, reps: { type: "NUMBER" }, sets: { type: "NUMBER" } }, required: ["name", "reps", "sets"] } } }, required: ["text", "exercises"] } } });
    let rawText = response.text || "{}"; rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(rawText);
    res.json({ text: parsed.text || "お返事の作成中に少し迷ってしまいました。もう一度話しかけてみてください！", exercises: Array.isArray(parsed.exercises) ? parsed.exercises : [] });
  } catch (error) {
    const errStr = String(error); const isQuota = errStr.includes("429") || errStr.includes("Quota") || error?.status === 429;
    res.json({ text: isQuota ? "【Gemini AIの無料制限】1日の無料利用枠（20回）の上限に達しました！数時間〜明日になると自動でリセットされて満タンになりますので、しばらく時間を置いてからもう一度話しかけてみてください！" : "トレーナーAIとの通信に一時的なエラーが発生しました。もう一度だけ送ってみていただけますか？", exercises: [] });
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
