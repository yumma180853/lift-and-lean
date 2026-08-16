/**
 * 録音した音声を文字にする（サーバー側だけで OpenAI を呼ぶ）。
 *
 * ## なぜサーバーでやるか
 * 鍵を画面側の束に入れないため。画面は音のかたまりを送るだけで、
 * 鍵にも外部サービスにも触れない。
 *
 * ## 音声そのものは残さない
 * 受け取った音は変換のあいだメモリに置くだけで、Appwrite にも
 * localStorage にも通常のログにも**書かない**。失敗しても中身は出さない。
 *
 * ## モデル
 * `gpt-4o-mini-transcribe`。短い発話向けで速く安い。
 * `language: ja` と、筋トレ語彙の短い手がかり（prompt）を渡して
 * 「ラットプルダウン」「懸垂」などの取り違えを減らす。
 */

import OpenAI, { toFile } from 'openai';
import { AppError } from '../_core/errors.js';

const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe';

/**
 * 聞き取りの手がかり。**辞書ではなく例示**なので、ここに無い語も認識される。
 * 長くすると効きが薄れるので、間違えやすいものだけに絞る。
 */
const VOCABULARY_HINT = [
  '筋トレと食事の記録です。',
  'ベンチプレス、ラットプルダウン、シーテッドロー、懸垂、チンニング、スクワット、デッドリフト、',
  'ショルダープレス、アームカール、レッグプレス、レッグエクステンション、腹筋、腕立て伏せ。',
  '「70kg7回2セット」「体重72.4キロ」「タンパク質」のように、kg・回・セットを使います。',
].join('');

/**
 * 送っていいかたまりの上限。
 *
 * base64 は元の約1.34倍になる。ホスティング側の本文上限（4.5MB）に
 * 余裕をもって収まる大きさにしておく（2.5MB → 約3.4MB）。
 * 1分の音声は 64kbps なら 0.5MB 程度なので、これで足りる。
 */
export const MAX_AUDIO_BYTES = 2.5 * 1024 * 1024;

/** 受け取る形。音は base64 で運ぶ（既存の JSON 経路をそのまま使えるため） */
export interface TranscribeRequest {
  audio: string;
  mimeType?: string;
}

/**
 * MIME から拡張子を決める。
 * OpenAI 側は**ファイル名の拡張子で形式を判断する**ので、ここを間違えると弾かれる。
 * 端末ごとに録れる形式が違う（iOS は mp4、Android/PC は webm が多い）ため固定しない。
 */
export function extensionFor(mimeType: string | undefined): string {
  const base = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  switch (base) {
    case 'audio/mp4':
    case 'video/mp4':
    case 'audio/x-m4a':
    case 'audio/m4a':
    case 'audio/aac':
      return 'mp4';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/ogg':
    case 'video/ogg':
      return 'ogg';
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      return 'wav';
    case 'audio/flac':
      return 'flac';
    case 'audio/webm':
    case 'video/webm':
    default:
      return 'webm';
  }
}

/** base64 を取り出す。data URL 形式で来ても受ける */
export function decodeAudio(raw: unknown): Buffer {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError('invalid_audio', 400, '録音できませんでした。もう一度試してください。');
  }
  const payload = raw.includes(',') && raw.slice(0, 64).includes('base64') ? raw.slice(raw.indexOf(',') + 1) : raw;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    throw new AppError('invalid_audio', 400, '録音できませんでした。もう一度試してください。');
  }
  if (buffer.length === 0) {
    throw new AppError('invalid_audio', 400, '録音できませんでした。もう一度試してください。');
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw new AppError('audio_too_large', 413, '録音が長すぎます。短く区切って話してください。');
  }
  return buffer;
}

let client: OpenAI | null = null;
const openai = (): OpenAI => {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
};

/** 差し替えできるようにしておく（試験で外部を呼ばないため） */
export interface TranscribeDeps {
  transcribe(audio: Buffer, extension: string, mimeType: string): Promise<string>;
}

export const openAiTranscriber: TranscribeDeps = {
  async transcribe(audio, extension, mimeType) {
    const file = await toFile(audio, `speech.${extension}`, { type: mimeType });
    const result = await openai().audio.transcriptions.create({
      file,
      model: TRANSCRIBE_MODEL,
      language: 'ja',
      prompt: VOCABULARY_HINT,
      // gpt-4o-mini-transcribe は json / text のみ。既定の json を使う
      response_format: 'json',
      temperature: 0,
    });
    return typeof result.text === 'string' ? result.text : '';
  },
};

/**
 * 音声 → 文字。**内部の失敗理由は外へ出さない**（決まった一文だけ返す）。
 */
export async function runTranscription(deps: TranscribeDeps, rawInput: unknown): Promise<{ text: string }> {
  const input = (typeof rawInput === 'object' && rawInput !== null ? rawInput : {}) as TranscribeRequest;
  const audio = decodeAudio(input.audio);
  const mimeType = typeof input.mimeType === 'string' && input.mimeType ? input.mimeType : 'audio/webm';
  const extension = extensionFor(mimeType);

  let text: string;
  try {
    text = await deps.transcribe(audio, extension, mimeType.split(';')[0]);
  } catch (error) {
    // 失敗の詳細は運用ログにだけ残す（音声そのものは残さない）
    console.error('transcription failed:', error instanceof Error ? error.message : 'unknown');
    throw new AppError('transcription_failed', 502, '聞き取れませんでした。もう一度お願いします。');
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new AppError('transcription_empty', 422, '聞き取れませんでした。もう一度お願いします。');
  }
  return { text: trimmed };
}
