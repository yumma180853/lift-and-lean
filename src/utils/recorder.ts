/**
 * iPhone のマイクで直接録音する（キーボードを開かない）。
 *
 * ## なぜ Web 標準で自前録音するのか
 * `webkitSpeechRecognition` は Safari のタブでは動くが、
 * **ホーム画面に追加した PWA では動かない**。Lift & Lean の主戦場は後者。
 * そこで `getUserMedia` + `MediaRecorder` で自分で録り、
 * 文字起こしはサーバー（鍵のある側）に任せる。
 *
 * ## 端末ごとの違いは feature detection で吸収する
 * 形式は固定しない。iOS は `audio/mp4`(AAC)、Android/PC は `audio/webm`(Opus) が多い。
 * `MediaRecorder.isTypeSupported` に聞き、どれも駄目なら**指定せず**ブラウザに選ばせる。
 *
 * ## 終わったら必ずマイクを離す
 * `MediaStreamTrack.stop()` を呼ばないと、iOS は録音インジケータが出たままになる。
 * 停止・失敗・画面離脱のどの経路でも通るように、解放は1か所（`release`）に集める。
 */

export type RecorderFailure =
  /** マイクの使用が許可されなかった */
  | 'permission-denied'
  /** この端末では録音そのものができない */
  | 'unsupported'
  /** 途中で失敗した */
  | 'failed';

export interface RecorderSupport {
  supported: boolean;
  reason?: 'no-mediadevices' | 'no-recorder';
}

/** 録音に必要なものが揃っているか。**呼ぶ前に必ず確かめる** */
export function detectRecorderSupport(scope: any = typeof window === 'undefined' ? undefined : window): RecorderSupport {
  if (!scope) return { supported: false, reason: 'no-mediadevices' };
  const media = scope.navigator?.mediaDevices;
  if (!media || typeof media.getUserMedia !== 'function') {
    return { supported: false, reason: 'no-mediadevices' };
  }
  if (typeof scope.MediaRecorder !== 'function') {
    return { supported: false, reason: 'no-recorder' };
  }
  return { supported: true };
}

/**
 * 使える形式を選ぶ。**上から順に試す**（軽い順・文字起こしの通りやすい順）。
 * どれも駄目なら undefined を返し、`MediaRecorder` に選ばせる。
 */
export const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/aac',
];

export function pickMimeType(
  isTypeSupported?: (type: string) => boolean,
  candidates: string[] = MIME_CANDIDATES,
): string | undefined {
  if (typeof isTypeSupported !== 'function') return undefined;
  for (const candidate of candidates) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      // 判定自体が投げる実装もある。次の候補へ
    }
  }
  return undefined;
}

/** getUserMedia の失敗を、画面に出す種類へ分ける（内部メッセージは使わない） */
export function classifyMediaError(error: unknown): RecorderFailure {
  const name = (error as any)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'permission-denied';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotSupportedError') {
    return 'unsupported';
  }
  return 'failed';
}

// ---------------------------------------------------------------- 自動停止

/**
 * 話し終わりの判定。
 *
 * 「一定の大きさを超えた（＝喋り始めた）あと、静かな時間が続いたら止める」。
 * 喋り出す前の無音では止めない（考えている時間を切らないため）。
 * 判定は数値だけで完結させてあるので、そのまま試験できる。
 */
export class SilenceTracker {
  /** これを超えたら「喋っている」とみなす音量(0〜1) */
  readonly threshold: number;
  /** 喋ったあと、これだけ静かなら止める */
  readonly silenceMs: number;
  /** 何も喋らなくても、これを過ぎたら止める */
  readonly maxMs: number;
  /** 喋り始める前に、これだけ何も無ければ止める（マイクが拾えていない） */
  readonly noSpeechMs: number;

  private spoke = false;
  private quietSince: number | null = null;

  constructor(options: { threshold?: number; silenceMs?: number; maxMs?: number; noSpeechMs?: number } = {}) {
    this.threshold = options.threshold ?? 0.045;
    this.silenceMs = options.silenceMs ?? 1600;
    this.maxMs = options.maxMs ?? 60_000;
    this.noSpeechMs = options.noSpeechMs ?? 8_000;
  }

  /** 喋ったことがあるか（画面の表示を変えるのに使う） */
  get hasSpoken(): boolean { return this.spoke; }

  /** @returns 止めるべきなら true */
  push(level: number, elapsedMs: number): boolean {
    if (elapsedMs >= this.maxMs) return true;

    if (level >= this.threshold) {
      this.spoke = true;
      this.quietSince = null;
      return false;
    }

    if (!this.spoke) return elapsedMs >= this.noSpeechMs;

    if (this.quietSince === null) this.quietSince = elapsedMs;
    return elapsedMs - this.quietSince >= this.silenceMs;
  }
}

/** 波形（-1〜1 相当の Uint8）から音量を出す */
export function levelOf(samples: Uint8Array | number[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = (samples[i] - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

// ---------------------------------------------------------------- 送る形

/**
 * 音のかたまりを base64 にする。
 * 一度に `String.fromCharCode` へ渡すと大きい録音で落ちるので、少しずつ繋ぐ。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------- 本体

export interface VoiceRecorderCallbacks {
  /** 録音が始まった（許可が下りた） */
  onStart?(): void;
  /** 音量の変化。0〜1。画面の「聞いています…」の反応に使う */
  onLevel?(level: number, hasSpoken: boolean): void;
  /** 録れた。**この時点でマイクは解放済み** */
  onStop(audio: Blob, mimeType: string): void;
  onError(failure: RecorderFailure): void;
}

/**
 * 1回ぶんの録音。使い捨て（`start` → `stop` で終わり）。
 *
 * `start()` は**タップの流れの中で呼ぶこと**。
 * iOS は user gesture から離れると許可を求められない。
 */
export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private frame: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chunks: BlobPart[] = [];
  private tracker: SilenceTracker;
  private startedAt = 0;
  private stopping = false;
  private released = false;

  constructor(private callbacks: VoiceRecorderCallbacks, tracker?: SilenceTracker) {
    this.tracker = tracker ?? new SilenceTracker();
  }

  async start(): Promise<void> {
    const support = detectRecorderSupport();
    if (!support.supported) { this.callbacks.onError('unsupported'); return; }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      this.callbacks.onError(classifyMediaError(error));
      return;
    }
    this.stream = stream;

    const mimeType = pickMimeType((window as any).MediaRecorder?.isTypeSupported?.bind((window as any).MediaRecorder));
    try {
      // 話し声に十分な音質で、送信を軽くする。指定が通らない端末では下で作り直す
      this.recorder = mimeType
        ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 })
        : new MediaRecorder(stream, { audioBitsPerSecond: 64_000 });
    } catch {
      // 形式指定が拒まれることがある。指定なしでもう一度だけ試す
      try {
        this.recorder = new MediaRecorder(stream);
      } catch {
        this.release();
        this.callbacks.onError('unsupported');
        return;
      }
    }

    this.recorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onerror = () => { this.fail(); };
    this.recorder.onstop = () => {
      const type = this.recorder?.mimeType || mimeType || 'audio/webm';
      const audio = new Blob(this.chunks, { type });
      this.release();
      if (audio.size === 0) { this.callbacks.onError('failed'); return; }
      this.callbacks.onStop(audio, type);
    };

    try {
      this.recorder.start();
    } catch {
      this.release();
      this.callbacks.onError('failed');
      return;
    }

    this.startedAt = Date.now();
    this.callbacks.onStart?.();
    this.watch(stream);
  }

  /** 手で止める（自動停止が効かない端末のための逃げ道） */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop(); // onstop で release される
        return;
      }
    } catch { /* 下で解放する */ }
    this.release();
  }

  /** 画面を閉じるなど、結果が要らないとき。**必ずマイクを離す** */
  cancel(): void {
    this.stopping = true;
    this.callbacks = { onStop: () => {}, onError: () => {} };
    try { if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop(); } catch { /* 実害なし */ }
    this.release();
  }

  private fail(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.release();
    this.callbacks.onError('failed');
  }

  /**
   * 無音での自動停止。
   * `AudioContext` が使えない端末では**時間切れだけ**で止める（停止ボタンが本命）。
   */
  private watch(stream: MediaStream): void {
    const Ctor = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (typeof Ctor !== 'function' || typeof requestAnimationFrame !== 'function') {
      this.timer = setTimeout(() => this.stop(), this.tracker.maxMs);
      return;
    }

    try {
      const context: AudioContext = new Ctor();
      this.context = context;
      void context.resume?.();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);

      const tick = () => {
        if (this.stopping) return;
        analyser.getByteTimeDomainData(samples);
        const level = levelOf(samples);
        this.callbacks.onLevel?.(level, this.tracker.hasSpoken);
        const elapsed = Date.now() - this.startedAt;

        /**
         * **解析が動いていないときに早合点しない。**
         *
         * iOS は音声処理を始める合図（タップ）から離れると `AudioContext` が
         * 止まったままになることがあり、その間は波形がぴったり無音で返る。
         * 生きたマイクなら必ず僅かに揺れるので、**完全な 0 は「拾えていない」**
         * とみなし、時間切れだけで判断する（録音そのものは続いている）。
         */
        const silentBecauseIdle = level === 0 && context.state !== 'running';
        const shouldStop = silentBecauseIdle
          ? elapsed >= this.tracker.maxMs
          : this.tracker.push(level, elapsed);

        if (shouldStop) { this.stop(); return; }
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    } catch {
      this.timer = setTimeout(() => this.stop(), this.tracker.maxMs);
    }
  }

  /** マイクと音声処理を手放す。**何度呼んでも安全** */
  private release(): void {
    if (this.released) return;
    this.released = true;
    if (this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.stream?.getTracks().forEach(track => track.stop()); } catch { /* 実害なし */ }
    this.stream = null;
    try { void this.context?.close(); } catch { /* 実害なし */ }
    this.context = null;
  }
}
