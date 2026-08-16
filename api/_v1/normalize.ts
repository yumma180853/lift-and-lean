/**
 * 言語モデルが返した引数を、実行できる形へそろえる（検証の**手前**）。
 *
 * ## なぜ要るか（実機で起きたこと）
 * 「懸垂8回と7回」「ラットプル70kg7回2セット、65kg7回2セット」のように
 * 自然に話すと、モデルは
 *   - 自重種目の `weight` を書かない（自重だから言われていない）
 *   - 2件目以降の `reps` を省く
 *   - `sets: 3` のようにセット数を数値で返す
 * といった形を返す。これを **そのまま zod へ渡すと**
 * `Invalid input: expected number, received undefined` になり、
 * 内部の検証文言がそのまま画面に出ていた。
 *
 * ここでは
 *   1. 直せる形（省略形・文字列の数値・自重）は**直す**
 *   2. 直せないもの（回数が本当に無い等）は**推測せず、足りない点だけ聞き返す**
 * の2つだけを行う。0 や平均値で埋めることはしない。
 *
 * ## 検証そのものは緩めない
 * ここを通ったあとも `tools.ts` の schema で検証する。
 * この層は「言い方の揺れ」を吸収するだけで、範囲や必須の判断はしない。
 */

// ---------------------------------------------------------------- 数値

/** 全角数字・単位付き文字列（"70kg" "7回"）も数値として読む */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const half = value.replace(/[０-９．]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const match = half.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const first = (...values: unknown[]): unknown => values.find(v => v !== undefined && v !== null && v !== '');

// ---------------------------------------------------------------- 自重種目

/**
 * 重量を言わないのが普通の種目。**ここに載っているものだけ** weight=0 を補う。
 *
 * schema 側も「自重なら0」と定義しているので、これは推測ではなく既定の意味づけ。
 * 載っていない種目（ラットプル等）で重量が無ければ、0にせず聞き返す。
 */
const BODYWEIGHT_WORDS = [
  '自重', '懸垂', 'チンニング', 'チンアップ', 'プルアップ', '斜め懸垂',
  '腕立て', 'プッシュアップ', '腕立て伏せ',
  '腹筋', 'シットアップ', 'クランチ', 'レッグレイズ', 'アブローラー',
  'ディップス', 'ディップ',
  '背筋', 'バックエクステンション', 'ハイパーエクステンション',
  'プランク', 'ヒップリフト', 'マウンテンクライマー', 'バーピー',
];

export function isBodyweightExercise(name: string): boolean {
  const normalized = name.replace(/\s/g, '');
  return BODYWEIGHT_WORDS.some(word => normalized.includes(word));
}

// ---------------------------------------------------------------- 筋トレ

export interface NormalizedSet { weight: number; reps: number }
export interface NormalizedExercise { name: string; sets: NormalizedSet[] }

/**
 * 目印は文字列にしてある。この tsconfig は strictNullChecks が無いため、
 * 真偽値の目印だと片側の型が絞り込まれない（実際に型検査を通り抜けた）。
 */
export type NormalizeResult<T> =
  | { outcome: 'ready'; args: T }
  /** 足りない点だけを短く聞き返す（推測して保存しない） */
  | { outcome: 'ask'; clarify: string };

interface SetDraft { weight?: number; reps?: number; count?: number }

/** セット1つぶんの下書きを読む。キー名の揺れ（reps/rep/回数…）を吸収する */
function readSetDraft(raw: unknown): SetDraft {
  // 数値だけのときは回数とみなす（"sets": [10, 8, 6]）
  const asNumber = toNumber(raw);
  if (typeof raw !== 'object' || raw === null) {
    return asNumber === undefined ? {} : { reps: asNumber };
  }

  const record = raw as Record<string, unknown>;
  const weight = toNumber(first(record.weight, record.kg, record.load, record['重量']));
  const reps = toNumber(first(record.reps, record.rep, record.repetitions, record['回数'], record['回']));

  // `count` は「回数」にも「セット数」にも使われる。
  // 回数が別に取れているならセット数、取れていないなら回数として読む
  const countLike = toNumber(first(record.sets, record.setCount, record.setsCount, record['セット数'], record['セット']));
  const bare = toNumber(record.count);
  const count = countLike ?? (reps !== undefined ? bare : undefined);
  const repsFinal = reps ?? (countLike !== undefined ? bare : undefined);

  return { weight, reps: repsFinal, count };
}

/** 種目1つぶんのセット列を、省略形も含めて展開する */
function expandSets(exercise: Record<string, unknown>): SetDraft[] {
  const raw = first(exercise.sets, exercise.set, exercise['セット']);
  const outer = readSetDraft(exercise); // 種目の直下に weight/reps がある形にも備える

  const drafts: SetDraft[] = [];
  const push = (draft: SetDraft) => {
    const merged: SetDraft = {
      weight: draft.weight ?? outer.weight,
      reps: draft.reps ?? outer.reps,
    };
    const times = Math.min(Math.max(Math.round(draft.count ?? 1), 1), 50);
    for (let i = 0; i < times; i++) drafts.push({ ...merged });
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) push(readSetDraft(entry));
    return drafts;
  }
  if (typeof raw === 'object' && raw !== null) {
    push(readSetDraft(raw));
    return drafts;
  }
  // "sets": 3 のようにセット数だけが来る形
  const times = toNumber(raw);
  if (times !== undefined) {
    push({ ...outer, count: times });
    return drafts;
  }
  // セットの記述が無い（「ベンチ60キロ10回」）。1セットとして扱う
  if (outer.reps !== undefined || outer.weight !== undefined) push({});
  return drafts;
}

function readExerciseName(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw !== 'object' || raw === null) return '';
  const record = raw as Record<string, unknown>;
  const name = first(record.name, record.exercise, record.exerciseName, record['種目'], record['種目名']);
  return typeof name === 'string' ? name.trim() : '';
}

/** 「60kgはどの種目ですか？」のように、分かっている手がかりを添えて聞き返す */
function askForName(sets: SetDraft[]): string {
  const known = sets.find(set => set.weight !== undefined || set.reps !== undefined);
  if (known?.weight !== undefined) return `${known.weight}kgはどの種目ですか？`;
  if (known?.reps !== undefined) return `${known.reps}回はどの種目ですか？`;
  return '種目は何ですか？';
}

const ordinal = (index: number): string => `${index + 1}セット目`;

/**
 * log_workout の引数をそろえる。
 *
 * 直す:
 *   - exercises が配列でない / 1種目だけ直に来ている
 *   - "sets": 3 のような省略形、文字列の数値
 *   - 自重種目の重量（0を補う。schema の「自重なら0」と同じ意味）
 *   - 同じ種目で重量が省かれた続きのセット（直前のセットの重量を引き継ぐ）
 * 直さない（聞き返す）:
 *   - 回数が無い    → 「ラットプルダウン65kgは何回ですか？」
 *   - 種目名が無い  → 「60kgはどの種目ですか？」
 *   - 加重種目の重量が最初から無い → 「ラットプルダウンは何kgですか？」
 */
export function normalizeWorkoutArgs(raw: unknown): NormalizeResult<Record<string, unknown>> {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const rawExercises = first(record.exercises, record.exercise, record['種目']);
  const list: unknown[] = Array.isArray(rawExercises)
    ? rawExercises
    : rawExercises !== undefined
      ? [rawExercises]
      // exercises 自体が無く、引数の直下に種目が書かれている形
      : (record.name || record.sets || record.reps) ? [record] : [];

  if (list.length === 0) {
    return { outcome: 'ask', clarify: '何の種目を何回やりましたか？' };
  }

  const exercises: NormalizedExercise[] = [];
  for (const entry of list) {
    const source = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const name = readExerciseName(entry);
    const drafts = expandSets(source);

    if (!name) return { outcome: 'ask', clarify: askForName(drafts) };
    if (drafts.length === 0) return { outcome: 'ask', clarify: `${name}は何回やりましたか？` };

    const bodyweight = isBodyweightExercise(name);
    const sets: NormalizedSet[] = [];
    let lastWeight: number | undefined;

    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i];

      // 重量: 明示 → 直前のセットから引き継ぐ → 自重なら0 → それ以外は聞き返す
      let weight = draft.weight;
      if (weight === undefined) weight = lastWeight;
      if (weight === undefined && bodyweight) weight = 0;
      if (weight === undefined) {
        return {
          outcome: 'ask',
          clarify: drafts.length > 1
            ? `${name}の${ordinal(i)}は何kgですか？`
            : `${name}は何kgですか？（自重なら「自重」と言ってください）`,
        };
      }
      lastWeight = weight;

      // 回数は引き継がない。言われていないものを推測して保存しないため
      if (draft.reps === undefined) {
        const label = bodyweight || weight === 0 ? name : `${name}${weight}kg`;
        return {
          outcome: 'ask',
          clarify: drafts.length > 1 ? `${label}は何回ですか？（${ordinal(i)}）` : `${label}は何回ですか？`,
        };
      }

      sets.push({ weight, reps: draft.reps });
    }

    exercises.push({ name, sets });
  }

  const args: Record<string, unknown> = { exercises };
  if (typeof record.date === 'string') args.date = record.date;
  return { outcome: 'ready', args };
}

// ---------------------------------------------------------------- 体重・食事

const coerceFields = (record: Record<string, unknown>, fields: string[]): Record<string, unknown> => {
  const next = { ...record };
  for (const field of fields) {
    if (next[field] === undefined) continue;
    const value = toNumber(next[field]);
    if (value !== undefined) next[field] = value;
  }
  return next;
};

/** 数値が文字列（"72.4" "72.4kg"）で返ってきても通す。欠けている値は足さない */
export function normalizeArgs(intent: string, raw: unknown): NormalizeResult<Record<string, unknown>> {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  if (intent === 'log_workout') return normalizeWorkoutArgs(record);
  if (intent === 'log_weight') return { outcome: 'ready', args: coerceFields(record, ['weight']) };
  if (intent === 'log_meal') return { outcome: 'ready', args: coerceFields(record, ['calories', 'protein', 'fat', 'carbs']) };
  return { outcome: 'ready', args: record };
}

// ---------------------------------------------------------------- 検証の言い換え

/**
 * zod の指摘を**日本語の短い聞き返し**に置き換える。
 *
 * `Invalid input: expected number, received undefined` のような内部文言は
 * 画面に出さない。ここが最後の砦なので、既定値も日本語にしておく。
 */
export interface ValidationIssue {
  code: string;
  path: PropertyKey[];
}

export function explainIssue(intent: string, issue: ValidationIssue): string {
  const path = issue.path.map(String);
  const field = path[path.length - 1] ?? '';
  const missing = issue.code === 'invalid_type';

  if (intent === 'log_weight') {
    return missing
      ? '体重が聞き取れませんでした。「体重72.4キロ」のように言ってください。'
      : '体重の値がうまく取れませんでした。もう一度お願いします。';
  }

  if (intent === 'log_meal') {
    if (field === 'name') return '何を食べたか、もう一度教えてください。';
    return '食事の内容がうまく取れませんでした。「昼に牛丼並」のように言ってください。';
  }

  if (intent === 'log_workout') {
    const setIndex = Number(path[3]);
    const where = Number.isInteger(setIndex) ? `${setIndex + 1}セット目の` : '';
    if (field === 'reps') return `${where}回数がうまく取れませんでした。もう一度お願いします。`;
    if (field === 'weight') return `${where}重量がうまく取れませんでした。もう一度お願いします。`;
    if (field === 'name') return '種目名がうまく取れませんでした。もう一度お願いします。';
    return '筋トレの内容がうまく取れませんでした。「ベンチプレス60キロ10回3セット」のように言ってください。';
  }

  return 'うまく聞き取れませんでした。もう一度お願いします。';
}
