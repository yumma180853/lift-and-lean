/**
 * 録音 → 文字起こしのテスト。
 *
 * 守りたいのは
 *   - 端末ごとに違う録音形式を、そのまま正しい拡張子で渡せる
 *   - 失敗しても**内部の理由を画面へ出さない**（決まった一文だけ）
 *   - 音声そのものを保存しない（このAPIは文字しか返さない）
 *   - 大きすぎる録音は断る
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../api/_core/errors.ts';
import { MAX_AUDIO_BYTES, createTranscriber, decodeAudio, extensionFor, runTranscription } from '../api/_v1/transcribe.ts';

const base64 = (text: string) => Buffer.from(text).toString('base64');

/** 外部を呼ばない差し替え */
const fakeTranscriber = (reply: string | Error) => {
  const calls: { size: number; extension: string; mimeType: string }[] = [];
  return {
    calls,
    transcribe: async (audio: Buffer, extension: string, mimeType: string) => {
      calls.push({ size: audio.length, extension, mimeType });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
};

// ---------------------------------------------------------------- 形式

test('端末ごとの録音形式を、対応する拡張子で渡す', () => {
  assert.equal(extensionFor('audio/mp4;codecs=mp4a.40.2'), 'mp4', 'iPhone の形式が通らない');
  assert.equal(extensionFor('audio/mp4'), 'mp4');
  assert.equal(extensionFor('audio/webm;codecs=opus'), 'webm');
  assert.equal(extensionFor('audio/ogg'), 'ogg');
  assert.equal(extensionFor('audio/wav'), 'wav');
  assert.equal(extensionFor('audio/x-m4a'), 'mp4');
  // 分からない形式でも止めない（既定に寄せる）
  assert.equal(extensionFor(undefined), 'webm');
  assert.equal(extensionFor('audio/なにか'), 'webm');
});

test('iPhone の録音（mp4）がそのまま扱える', async () => {
  const deps = fakeTranscriber('ベンチプレス60キロ10回3セット');
  const result = await runTranscription(deps, { audio: base64('audio-bytes'), mimeType: 'audio/mp4;codecs=mp4a.40.2' });

  assert.equal(result.text, 'ベンチプレス60キロ10回3セット');
  assert.equal(deps.calls[0].extension, 'mp4');
  assert.equal(deps.calls[0].mimeType, 'audio/mp4', 'codecs 付きのまま渡している');
});

// ---------------------------------------------------------------- 受け取り

test('data URL 形式で送られてきても受ける', () => {
  const buffer = decodeAudio(`data:audio/webm;base64,${base64('hello')}`);
  assert.equal(buffer.toString(), 'hello');
});

test('空の録音は断る（内部文言を出さない）', () => {
  for (const bad of [undefined, '', '   ', 123]) {
    assert.throws(() => decodeAudio(bad as any), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal((error as AppError).message, '録音できませんでした。もう一度試してください。');
      return true;
    });
  }
});

test('大きすぎる録音は断る', () => {
  const huge = Buffer.alloc(MAX_AUDIO_BYTES + 1).toString('base64');
  assert.throws(() => decodeAudio(huge), (error: unknown) => {
    assert.equal((error as AppError).status, 413);
    assert.match((error as AppError).message, /短く/);
    return true;
  });
});

// ---------------------------------------------------------------- 失敗

test('文字起こしに失敗しても、内部の理由は画面へ出さない', async () => {
  const deps = fakeTranscriber(new Error('OpenAI 429 rate limit exceeded for org-xxxx'));

  await assert.rejects(
    () => runTranscription(deps, { audio: base64('audio'), mimeType: 'audio/mp4' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      const message = (error as AppError).message;
      assert.equal(message, '聞き取れませんでした。もう一度お願いします。');
      for (const leak of ['OpenAI', 'rate limit', 'org-']) {
        assert.equal(message.includes(leak), false, `内部情報が漏れている: ${message}`);
      }
      return true;
    },
  );
});

test('何も聞き取れなかったときも同じ一文を返す', async () => {
  const deps = fakeTranscriber('   ');
  await assert.rejects(
    () => runTranscription(deps, { audio: base64('audio'), mimeType: 'audio/webm' }),
    (error: unknown) => {
      assert.equal((error as AppError).message, '聞き取れませんでした。もう一度お願いします。');
      return true;
    },
  );
});

test('前後の空白は落として返す', async () => {
  const deps = fakeTranscriber('  体重72.4キロ  ');
  const result = await runTranscription(deps, { audio: base64('audio'), mimeType: 'audio/webm' });
  assert.equal(result.text, '体重72.4キロ');
});

test('返すのは文字だけ（音声を持ち回らない）', async () => {
  const deps = fakeTranscriber('体重72キロ');
  const result = await runTranscription(deps, { audio: base64('audio'), mimeType: 'audio/webm' });
  assert.deepEqual(Object.keys(result), ['text']);
});

// ---------------------------------------------------------------- 呼び出しの再試行

test('まず日本語と語彙の手がかりを付けて呼ぶ', async () => {
  const seen: any[] = [];
  const deps = createTranscriber(async params => { seen.push(params); return { text: 'ベンチプレス' }; });

  const result = await deps.transcribe(Buffer.from('audio'), 'mp4', 'audio/mp4');

  assert.equal(result, 'ベンチプレス');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].language, 'ja');
  assert.match(String(seen[0].prompt), /ラットプルダウン/, '筋トレ語彙の手がかりが無い');
  assert.equal(seen[0].response_format, 'json');
});

test('付加的な指定で断られたら、最小の形でもう一度だけ試す', async () => {
  const seen: any[] = [];
  const deps = createTranscriber(async params => {
    seen.push(params);
    if (seen.length === 1) throw new Error('400 Unrecognized request argument supplied: prompt');
    return { text: '体重72.4キロ' };
  });

  const result = await deps.transcribe(Buffer.from('audio'), 'mp4', 'audio/mp4');

  assert.equal(result, '体重72.4キロ', '再試行できていない');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].language, undefined, '最小の形になっていない');
  assert.equal(seen[1].prompt, undefined);
  assert.ok(seen[1].model, 'モデル指定まで落ちている');
});

test('再試行しても駄目なら、決まった一文で断る', async () => {
  const deps = createTranscriber(async () => { throw new Error('503 upstream'); });

  await assert.rejects(
    () => runTranscription(deps, { audio: base64('audio'), mimeType: 'audio/mp4' }),
    (error: unknown) => {
      assert.equal((error as AppError).message, '聞き取れませんでした。もう一度お願いします。');
      return true;
    },
  );
});
