/**
 * 発話を操作に振り分けるための、言語モデル呼び出し（本番用）。
 *
 * **1つの指示につき1回だけ呼ぶ。** 食事のカロリー推定もこの1回に含める。
 * 鍵はサーバーにしか無い（画面側の束には入らない）。
 */

import OpenAI from 'openai';

/** 短い振り分けなので、速くて安いもので足りる */
const COMMAND_MODEL = process.env.COMMAND_MODEL ?? 'gpt-4o-mini';

let client: OpenAI | null = null;
const openai = (): OpenAI => {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
};

export async function parseCommandWithLLM(text: string, prompt: string): Promise<unknown> {
  const completion = await openai().chat.completions.create({
    model: COMMAND_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: text },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
