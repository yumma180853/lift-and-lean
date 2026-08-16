/**
 * 端末で直接録音する部分のテスト。
 *
 * 守りたいのは
 *   - 使えない端末では**録音を出さず**、文字入力へ落ちる
 *   - 形式を決め打ちしない（iOS は mp4、他は webm。実機に聞いてから決める）
 *   - 許可されなかったときと、失敗したときを取り違えない
 *   - 話し終わりで自動停止し、**必ずマイクを解放する**
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIME_CANDIDATES,
  SilenceTracker,
  VoiceRecorder,
  bytesToBase64,
  candidatesFor,
  classifyMediaError,
  detectRecorderSupport,
  isAppleBrowser,
  levelOf,
  pickMimeType,
} from '../src/utils/recorder.ts';

// ---------------------------------------------------------------- 使えるかどうか

test('MediaRecorder が無い端末では「使えない」と分かる', () => {
  assert.deepEqual(
    detectRecorderSupport({ navigator: { mediaDevices: { getUserMedia: () => {} } } }),
    { supported: false, reason: 'no-recorder' },
  );
});

test('getUserMedia が無い端末では「使えない」と分かる', () => {
  assert.deepEqual(
    detectRecorderSupport({ navigator: {}, MediaRecorder: () => {} }),
    { supported: false, reason: 'no-mediadevices' },
  );
  assert.equal(detectRecorderSupport(undefined).supported, false);
});

test('両方あれば使える', () => {
  assert.equal(
    detectRecorderSupport({ navigator: { mediaDevices: { getUserMedia: () => {} } }, MediaRecorder: () => {} }).supported,
    true,
  );
});

// ---------------------------------------------------------------- 形式

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';

test('iPhone（mp4しか対応しない）では mp4 を選ぶ', () => {
  const isTypeSupported = (type: string) => type.startsWith('audio/mp4');
  assert.equal(pickMimeType(isTypeSupported, candidatesFor(IPHONE_UA)), 'audio/mp4;codecs=mp4a.40.2');
});

test('iPhone は webm も録れると答えても mp4 を選ぶ（枯れているほうを使う）', () => {
  // Safari 18.4 以降は webm も true を返すが、iOS で確実なのは mp4
  assert.equal(pickMimeType(() => true, candidatesFor(IPHONE_UA)), 'audio/mp4;codecs=mp4a.40.2');
});

test('webm が使える端末では webm/opus を選ぶ', () => {
  assert.equal(pickMimeType(() => true, candidatesFor(ANDROID_UA)), 'audio/webm;codecs=opus');
});

test('iPhone かどうかで並びを変える', () => {
  assert.equal(isAppleBrowser(IPHONE_UA), true);
  assert.equal(isAppleBrowser(ANDROID_UA), false);
  assert.equal(isAppleBrowser(''), false);
  assert.equal(candidatesFor(IPHONE_UA)[0].startsWith('audio/mp4'), true);
  assert.equal(candidatesFor(ANDROID_UA)[0].startsWith('audio/webm'), true);
});

test('どれも使えなければ指定しない（ブラウザに選ばせる）', () => {
  assert.equal(pickMimeType(() => false), undefined);
  assert.equal(pickMimeType(undefined), undefined, 'isTypeSupported が無い端末で落ちている');
});

test('判定自体が例外を投げても次の候補へ進む', () => {
  const isTypeSupported = (type: string) => {
    if (type.includes('webm')) throw new Error('boom');
    return type === 'audio/mp4';
  };
  assert.equal(pickMimeType(isTypeSupported), 'audio/mp4');
});

test('候補は実機で使われる形式を網羅している', () => {
  assert.ok(MIME_CANDIDATES.some(type => type.startsWith('audio/mp4')), 'iOS 用の候補が無い');
  assert.ok(MIME_CANDIDATES.some(type => type.startsWith('audio/webm')), 'Android/PC 用の候補が無い');
});

// ---------------------------------------------------------------- 失敗の分け方

test('許可されなかった場合と、その他の失敗を分ける', () => {
  assert.equal(classifyMediaError({ name: 'NotAllowedError' }), 'permission-denied');
  assert.equal(classifyMediaError({ name: 'SecurityError' }), 'permission-denied');
  assert.equal(classifyMediaError({ name: 'NotFoundError' }), 'unsupported');
  assert.equal(classifyMediaError({ name: 'AbortError' }), 'failed');
  assert.equal(classifyMediaError(new Error('なにか')), 'failed');
});

// ---------------------------------------------------------------- 自動停止

test('喋ったあと静かになったら止める', () => {
  const tracker = new SilenceTracker({ threshold: 0.05, silenceMs: 1000, maxMs: 60_000 });
  assert.equal(tracker.push(0.2, 100), false, '喋っている最中に止まっている');
  assert.equal(tracker.push(0.01, 500), false);
  assert.equal(tracker.push(0.01, 1400), false, '1秒経つ前に止まっている');
  assert.equal(tracker.push(0.01, 1600), true, '話し終わっても止まらない');
});

test('喋る前の間では止めない（考えている時間を切らない）', () => {
  const tracker = new SilenceTracker({ silenceMs: 1000, noSpeechMs: 8000 });
  assert.equal(tracker.push(0.001, 3000), false);
  assert.equal(tracker.hasSpoken, false);
});

test('何も拾えないまま時間が過ぎたら止める', () => {
  const tracker = new SilenceTracker({ noSpeechMs: 8000 });
  assert.equal(tracker.push(0.001, 8100), true);
});

test('長すぎる録音は打ち切る', () => {
  const tracker = new SilenceTracker({ maxMs: 60_000 });
  assert.equal(tracker.push(0.5, 60_001), true);
});

test('音量は無音で0、振れ幅が大きいほど大きい', () => {
  assert.equal(levelOf(new Uint8Array(64).fill(128)), 0);
  assert.ok(levelOf(new Uint8Array(64).fill(200)) > 0.5);
  assert.equal(levelOf(new Uint8Array(0)), 0);
});

// ---------------------------------------------------------------- 送る形

test('大きな録音でも base64 にできる', () => {
  const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
  const encoded = bytesToBase64(bytes);
  assert.equal(encoded, Buffer.from(bytes).toString('base64'));
});

// ---------------------------------------------------------------- 実際の流れ（偽のブラウザ）

/** 最低限の MediaRecorder / getUserMedia を持つ偽の window を用意する */
function fakeBrowser(options: {
  deny?: boolean;
  noRecorder?: boolean;
  audio?: { state: string; level: number };
  /** iOS で報告されている「stop しても onstop が来ない」状態 */
  silentStop?: boolean;
} = {}) {
  const stopped: string[] = [];
  const tracks = [{ kind: 'audio', stop() { stopped.push('audio'); } }];
  const stream = { getTracks: () => tracks };

  class FakeRecorder {
    static isTypeSupported = (type: string) => type === 'audio/mp4';
    state = 'inactive';
    mimeType: string;
    ondataavailable: any = null;
    onstop: any = null;
    onerror: any = null;
    constructor(_stream: any, opts?: { mimeType?: string }) { this.mimeType = opts?.mimeType ?? ''; }
    start(timeslice?: number) {
      this.state = 'recording';
      // 小分け指定があれば、実機と同じように録れたぶんが届く
      if (timeslice) this.ondataavailable?.({ data: { size: 12 } });
    }
    requestData() { this.ondataavailable?.({ data: { size: 12 } }); }
    stop() {
      this.state = 'inactive';
      if (options.silentStop) return; // 何も起きない（iOS の不具合）
      this.ondataavailable?.({ data: { size: 12 } });
      this.onstop?.();
    }
  }

  /** 波形を返す偽の音声処理。level=0 は「拾えていない」状態を表す */
  const frames: (() => void)[] = [];
  const audio = options.audio;
  const FakeAudioContext = audio ? class {
    state = audio.state;
    async resume() { /* iOS では効かないことがある */ }
    async close() { /* 実害なし */ }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() {
      return {
        fftSize: 1024,
        connect() {},
        getByteTimeDomainData(target: Uint8Array) {
          target.fill(128 + Math.round(audio.level * 128));
        },
      };
    }
  } : undefined;

  const scope: any = {
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          if (options.deny) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
          return stream;
        },
      },
    },
    MediaRecorder: options.noRecorder ? undefined : FakeRecorder,
    Blob: class { size: number; type: string; constructor(parts: any[], opts: any) { this.size = parts.length * 12; this.type = opts?.type; } },
    AudioContext: FakeAudioContext,
    requestAnimationFrame: audio ? (callback: () => void) => { frames.push(callback); return frames.length; } : undefined,
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
  };
  /** 溜まっている描画待ちを1回進める */
  const nextFrame = () => { const callback = frames.shift(); callback?.(); };
  return { scope, stopped, nextFrame };
}

/** グローバルを差し替えて実行する（後片付けまで含める） */
async function withBrowser(scope: any, run: () => Promise<void>): Promise<void> {
  const globals = globalThis as any;
  const saved = {
    window: globals.window, navigator: globals.navigator, MediaRecorder: globals.MediaRecorder,
    Blob: globals.Blob, requestAnimationFrame: globals.requestAnimationFrame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
  };
  try {
    globals.window = scope;
    Object.defineProperty(globals, 'navigator', { value: scope.navigator, configurable: true, writable: true });
    globals.MediaRecorder = scope.MediaRecorder;
    globals.Blob = scope.Blob;
    globals.requestAnimationFrame = scope.requestAnimationFrame;
    globals.cancelAnimationFrame = scope.cancelAnimationFrame;
    await run();
  } finally {
    globals.window = saved.window;
    Object.defineProperty(globals, 'navigator', { value: saved.navigator, configurable: true, writable: true });
    globals.MediaRecorder = saved.MediaRecorder;
    globals.Blob = saved.Blob;
    globals.requestAnimationFrame = saved.requestAnimationFrame;
    globals.cancelAnimationFrame = saved.cancelAnimationFrame;
  }
}

test('マイクを許可しなかったら、その旨だけを返してマイクは掴まない', async () => {
  const { scope } = fakeBrowser({ deny: true });
  await withBrowser(scope, async () => {
    const failures: string[] = [];
    const recorder = new VoiceRecorder({ onStop: () => {}, onError: f => failures.push(f) });
    await recorder.start();
    assert.deepEqual(failures, ['permission-denied']);
  });
});

test('録音できない端末では unsupported を返す（文字入力へ落とせる）', async () => {
  const { scope } = fakeBrowser({ noRecorder: true });
  await withBrowser(scope, async () => {
    const failures: string[] = [];
    const recorder = new VoiceRecorder({ onStop: () => {}, onError: f => failures.push(f) });
    await recorder.start();
    assert.deepEqual(failures, ['unsupported']);
  });
});

test('停止したら音が返り、**マイクは必ず解放される**', async () => {
  const { scope, stopped } = fakeBrowser();
  await withBrowser(scope, async () => {
    let got: { size: number; type: string } | null = null;
    const recorder = new VoiceRecorder({
      onStop: (audio: any, mimeType) => { got = { size: audio.size, type: mimeType }; },
      onError: () => assert.fail('失敗になっている'),
    });
    await recorder.start();
    assert.deepEqual(stopped, [], '録音中にマイクを離している');

    recorder.stop();
    assert.ok(got, '音が返ってきていない');
    assert.equal(got!.type, 'audio/mp4', '端末が対応する形式が使われていない');
    assert.deepEqual(stopped, ['audio'], 'マイクが解放されていない');
  });
});

test('画面を閉じたときも（結果を捨てても）マイクを解放する', async () => {
  const { scope, stopped } = fakeBrowser();
  await withBrowser(scope, async () => {
    const recorder = new VoiceRecorder({
      onStop: () => assert.fail('捨てたはずの結果が返っている'),
      onError: () => assert.fail('失敗になっている'),
    });
    await recorder.start();
    recorder.cancel();
    assert.deepEqual(stopped, ['audio'], 'マイクが解放されていない');
  });
});

test('音声処理が動かない端末（iOS）で、早合点して録音を切らない', async () => {
  // 波形が「ぴったり無音」で返り、AudioContext も動いていない状態
  const { scope, nextFrame } = fakeBrowser({ audio: { state: 'suspended', level: 0 } });
  await withBrowser(scope, async () => {
    let stopped = false;
    const recorder = new VoiceRecorder(
      { onStop: () => { stopped = true; }, onError: () => assert.fail('失敗になっている') },
      // 「喋り出す前の待ち時間ゼロ」＝ふつうなら即座に打ち切る設定にしておく
      new SilenceTracker({ noSpeechMs: 0, maxMs: 60_000 }),
    );
    await recorder.start();

    for (let i = 0; i < 5; i++) nextFrame();
    assert.equal(stopped, false, '拾えていないだけなのに録音を止めている');

    recorder.cancel();
  });
});

test('音声処理が動いていれば、無音の判定はそのまま効く', async () => {
  const { scope, nextFrame } = fakeBrowser({ audio: { state: 'running', level: 0 } });
  await withBrowser(scope, async () => {
    let stopped = false;
    const recorder = new VoiceRecorder(
      { onStop: () => { stopped = true; }, onError: () => assert.fail('失敗になっている') },
      new SilenceTracker({ noSpeechMs: 0, maxMs: 60_000 }),
    );
    await recorder.start();

    nextFrame();
    assert.equal(stopped, true, '無音でも止まらない');
  });
});

test('iOS で stop の合図が返ってこなくても、録れたぶんを取り出してマイクを解放する', async () => {
  const { scope, stopped } = fakeBrowser({ silentStop: true });
  await withBrowser(scope, async () => {
    let got: any = null;
    let failed: string | null = null;
    const recorder = new VoiceRecorder({
      onStop: (audio: any, mimeType) => { got = { size: audio.size, type: mimeType }; },
      onError: failure => { failed = failure; },
    });
    await recorder.start();

    recorder.stop();
    assert.equal(got, null, '待たずに返している');

    // 待ちの上限（1.5秒）を過ぎたら、手元のぶんで組み立てる
    await new Promise(resolve => setTimeout(resolve, 1700));

    assert.equal(failed, null, `失敗になっている: ${failed}`);
    assert.ok(got, '録れたぶんが返ってこない');
    assert.ok(got.size > 0, '空の録音になっている');
    assert.deepEqual(stopped, ['audio'], 'マイクが解放されていない');
  });
});

test('結果は1回だけ返る（遅れて onstop が来ても二重に返さない）', async () => {
  const { scope } = fakeBrowser();
  await withBrowser(scope, async () => {
    let count = 0;
    const recorder = new VoiceRecorder({
      onStop: () => { count++; },
      onError: () => assert.fail('失敗になっている'),
    });
    await recorder.start();

    recorder.stop();
    recorder.stop(); // 二度押し
    assert.equal(count, 1, `${count}回返っている`);
  });
});
