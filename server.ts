import express from "express";
import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // API Route: Analyze Meal Image
  app.post("/api/analyze-meal", async (req, res) => {
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
      try { parsed = JSON.parse(rawText); }
      catch { parsed = { name: "不明", calories: 0, protein: 0, fat: 0, carbs: 0 }; }
      res.json(parsed);
    } catch (error: any) {
      console.error("Analyze-meal OpenAI Error:", error);
      res.status(500).json({ error: error.message || "Failed to analyze image" });
    }
  });

  // API Route: AI Personal Trainer Chat (delegates to api/server.ts handler)
  app.post("/api/chat-trainer", async (req, res) => {
    const { default: handler } = await import("./api/server.js");
    return handler(req, res);
  });

  // Vite middleware for development
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
