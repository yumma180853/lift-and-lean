/**
 * 話しことば／打ちことばを、既存の操作へ橋渡しする。
 *
 *   「ベンチ60キロ10回3セット」 → log_workout
 *   「体重72.4キロ」             → log_weight
 *   「昼に牛丼並」               → log_meal
 *   「今日タンパク質あと何g？」   → get_today_summary
 *
 * ## これはチャットではない
 * 雑談も、自由な問い合わせも受け付けない。**決められた操作に振り分けるだけ**。
 * 振り分け先は MCP と同じ `TOOLS`（同じ入力schema・同じ実行関数）を使う。
 * schema を二重に持たないこと自体が、ChatGPT 経由と画面経由で
 * 挙動がズレないための仕掛けになっている。
 *
 * ## 消す操作は無い
 * `TOOLS` にそもそも削除系が無いので、ここから消すことはできない。
 *
 * ## 呼ぶのは1回だけ
 * 1つの指示につき、言語モデルの呼び出しは**1回**。
 * 食事のカロリー推定もその1回の中で一緒に出させる（別呼び出しにしない）。
 */

import { z } from 'zod';
import { TOOLS } from '../_mcp/tools.js';
import type { ToolContext, ToolDefinition } from '../_mcp/tools.js';
import { jstToday } from '../_core/dates.js';
import { AppError } from '../_core/errors.js';
import { explainIssue, normalizeArgs } from './normalize.js';

/** 言い直してもらうときの上限。長文＝雑談化を防ぐ */
const MAX_TEXT_LENGTH = 300;

export const commandInputSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  /**
   * 'client' なら**サーバーは書き込まず**、書く内容（plan）だけを返す。
   * 画面はそれを既存の local-first / outbox 経路へ流す（＝通信を待たない）。
   * 省略時は今までどおりサーバーが書く（ChatGPT経由・古い画面のため）。
   */
  apply: z.enum(['server', 'client']).optional(),
});

/** 画面が local-first で書くための指示。**サーバーはまだ保存していない** */
export type CommandPlan =
  | { kind: 'meal'; date: string; meal: Record<string, unknown> }
  | { kind: 'weight'; date: string; weight: number }
  | { kind: 'workout'; date: string; exercises: { name: string; sets: { weight: number; reps: number }[] }[] };

export interface CommandResult {
  /** done=実行した / plan=画面側で保存する / clarify=聞き返す / unsupported=対象外 */
  status: 'done' | 'plan' | 'clarify' | 'unsupported';
  /** 画面に出す短い文 */
  message: string;
  intent?: string;
  data?: Record<string, unknown>;
  /** 画面側で保存する内容（status='plan' のときだけ） */
  plan?: CommandPlan;
  /** 取り消しに使う情報（作られた行が1つに決まるときだけ） */
  undo?: { kind: 'meal'; rowId: string };
  /** 何と聞き取ったか。取り違えの確認用に必ず返す */
  transcript: string;
}

// ---------------------------------------------------------------- 道具の説明

const isOptional = (schema: z.ZodTypeAny): boolean => schema.safeParse(undefined).success;

/**
 * 入力schema を言語モデル向けの短い仕様に直す。
 * `.describe()` に書いた説明をそのまま使うので、説明は1か所（tools.ts）にしかない。
 */
function describeShape(shape: Record<string, z.ZodTypeAny>): string {
  return Object.entries(shape)
    .filter(([key]) => key !== 'clientRequestId') // 冪等キーはサーバーが決める
    .map(([key, schema]) => {
      const mark = isOptional(schema) ? '?' : '';
      const note = (schema as any).description ?? '';
      return `    ${key}${mark}: ${note}`;
    })
    .join('\n');
}

function toolCatalog(tools: ToolDefinition[]): string {
  return tools
    .map(tool => `- ${tool.name}: ${tool.description}\n${describeShape(tool.inputShape)}`)
    .join('\n');
}

// ---------------------------------------------------------------- 振り分け

const parsedSchema = z.object({
  intent: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  /** 聞き返したいときの短い質問。埋まっていたら実行しない */
  clarify: z.string().nullable().optional(),
});

export interface Parsed {
  intent: string;
  args: Record<string, unknown>;
  clarify: string | null;
}

/** 言語モデルを呼ぶところだけ差し替えられるようにしておく（試験用） */
export interface CommandDeps {
  parse(text: string, prompt: string): Promise<unknown>;
  today?: () => string;
}

export function buildPrompt(today: string, tools: ToolDefinition[]): string {
  return [
    'あなたは Lift & Lean の入力係です。利用者の短い発話を、次の操作のどれか1つに振り分けます。',
    '会話やアドバイスはしません。振り分けと引数の抽出だけを行います。',
    '',
    '使える操作:',
    toolCatalog(tools),
    '',
    `今日の日付は ${today}（日本時間）です。`,
    '',
    '規則:',
    '- 出力は JSON のみ。{"intent": string, "args": object, "clarify": string|null}',
    '- 日付は「昨日」「一昨日」など明示されたときだけ args.date に入れる。指定が無ければ入れない。',
    '- 重量・回数・セット数は log_workout の exercises[].sets に展開する。',
    '  例:「ベンチ60キロ10回3セット」→ exercises:[{name:"ベンチプレス", sets:[{weight:60,reps:10},{weight:60,reps:10},{weight:60,reps:10}]}]',
    '- **複数の種目を1回の発話で言われたら、exercises に全て並べる**（1種目しか記録しない、はしない）。',
    '  例:「ベンチ60キロ10回3セットとラットプル70キロ7回2セット」→ exercises に2件。',
    '- **セットごとに重量や回数が違うときは、1セットずつ別の要素にする。**',
    '  例:「ラットプル70キロ7回2セット、65キロ7回2セット」',
    '  → sets:[{weight:70,reps:7},{weight:70,reps:7},{weight:65,reps:7},{weight:65,reps:7}]',
    '- **自重の種目（懸垂・腕立て・腹筋など）は weight を 0 にする。**省略しない。',
    '  例:「懸垂8回と7回」→ exercises:[{name:"懸垂", sets:[{weight:0,reps:8},{weight:0,reps:7}]}]',
    '- sets の各要素には weight と reps を必ず両方入れる。片方だけにしない。',
    '- 種目名は正式名称に直す（ベンチ→ベンチプレス、ラットプル→ラットプルダウン）。',
    '- log_meal では calories/protein/fat/carbs を必ず埋める。分からなければ一般的な値を推定し、',
    '  sourceType は "ai_estimate" にする。分量が言われていれば servingLabel に入れる。',
    '- 記録を消す・目標を変える・アカウントを操作する指示は受け付けない。',
    '  その場合は intent を "unsupported" にする。',
    '- 種目や食べ物が特定できない、数値が足りないなど**推測すると間違える**ときは、',
    '  intent を "clarify" にして clarify に短い質問を入れる。勝手に決めない。',
    '  例:「60キロ10回」だけで種目が不明 → clarify:"種目は何ですか？"',
  ].join('\n');
}

/** 言語モデルの答えを、実行できる形にそろえる */
export function normalizeParsed(raw: unknown): Parsed {
  const parsed = parsedSchema.safeParse(raw);
  if (!parsed.success) {
    return { intent: 'clarify', args: {}, clarify: 'うまく聞き取れませんでした。もう一度お願いします。' };
  }
  return {
    intent: parsed.data.intent,
    args: (parsed.data.args ?? {}) as Record<string, unknown>,
    clarify: parsed.data.clarify ?? null,
  };
}

// ---------------------------------------------------------------- 実行

export async function runCommand(
  ctx: ToolContext,
  deps: CommandDeps,
  rawInput: unknown,
): Promise<CommandResult> {
  const input = commandInputSchema.safeParse(rawInput);
  if (!input.success) {
    throw new AppError('invalid_input', 400, '指示が長すぎるか、空です。短く言い直してください。');
  }
  const text = input.data.text.trim();
  const today = (deps.today ?? jstToday)();

  const parsed = normalizeParsed(await deps.parse(text, buildPrompt(today, TOOLS)));

  if (parsed.intent === 'unsupported') {
    return {
      status: 'unsupported',
      message: '音声からは記録と確認だけができます。削除や設定変更は画面から操作してください。',
      transcript: text,
    };
  }
  if (parsed.intent === 'clarify' || parsed.clarify) {
    return {
      status: 'clarify',
      message: parsed.clarify ?? 'もう少し詳しく教えてください。',
      transcript: text,
    };
  }

  const tool = TOOLS.find(t => t.name === parsed.intent);
  if (!tool) {
    return {
      status: 'clarify',
      message: 'うまく聞き取れませんでした。「体重72キロ」のように言ってみてください。',
      transcript: text,
    };
  }

  /**
   * 言い方の揺れ（自重で重量を言わない・セット数の省略形・文字列の数値）を先に吸収する。
   * **足りない値を作り出すことはしない。** 足りなければここで聞き返す。
   */
  const normalized = normalizeArgs(tool.name, parsed.args);
  if (normalized.outcome === 'ask') {
    return { status: 'clarify', message: normalized.clarify, transcript: text };
  }

  // **入力の検証は MCP と同じ schema で行う。** ここを緩めない
  const validated = z.object(tool.inputShape).safeParse(normalized.args);
  if (!validated.success) {
    // zod の英語文言は**絶対に画面へ出さない**。日本語の短い聞き返しに置き換える
    const first = validated.error.issues[0];
    return {
      status: 'clarify',
      message: first
        ? explainIssue(tool.name, first)
        : 'うまく聞き取れませんでした。もう一度お願いします。',
      transcript: text,
    };
  }

  // 画面が local-first で書く場合、サーバーはここで**保存せずに**内容だけ返す
  if (input.data.apply === 'client') {
    const plan = toPlan(tool.name, validated.data as Record<string, unknown>, today);
    if (plan) {
      return { status: 'plan', message: describePlan(plan), intent: tool.name, plan, transcript: text };
    }
  }

  const result = await tool.run(ctx, validated.data);
  const rowId = typeof result.data?.rowId === 'string' ? result.data.rowId : null;

  return {
    status: 'done',
    message: result.text,
    intent: tool.name,
    data: result.data,
    // 取り消せるのは、作られた行が1つに決まる食事だけ
    undo: tool.name === 'log_meal' && rowId ? { kind: 'meal', rowId } : undefined,
    transcript: text,
  };
}

// ---------------------------------------------------------------- 画面側で保存する形

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * 検証済みの引数を、画面の既存操作（addMeal / saveWeight / 種目とセット）へ
 * そのまま渡せる形に直す。**ここで値を作らない**（検証を通ったものだけを詰め替える）。
 */
export function toPlan(
  intent: string,
  args: Record<string, unknown>,
  today: string,
): CommandPlan | null {
  const date = typeof args.date === 'string' ? args.date : today;

  if (intent === 'log_weight') {
    return { kind: 'weight', date, weight: args.weight as number };
  }

  if (intent === 'log_meal') {
    const meal: Record<string, unknown> = {
      name: args.name,
      calories: round1(args.calories as number),
      protein: round1(args.protein as number),
      fat: round1(args.fat as number),
      carbs: round1(args.carbs as number),
    };
    for (const key of ['mealType', 'servingLabel', 'sourceType', 'sourceLabel', 'sourceUrl', 'note']) {
      if (args[key] !== undefined) meal[key] = args[key];
    }
    return { kind: 'meal', date, meal };
  }

  if (intent === 'log_workout') {
    return {
      kind: 'workout',
      date,
      exercises: args.exercises as { name: string; sets: { weight: number; reps: number }[] }[],
    };
  }

  // 読み取り系はサーバーで実行する（画面に無い集計もあるため）
  return null;
}

/** 画面に出す一文。サーバーが書いたときと同じ言い方にそろえる */
export function describePlan(plan: CommandPlan): string {
  if (plan.kind === 'weight') {
    return `体重 ${plan.weight}kg を記録しました。同じ日に再度記録すると上書きされます。`;
  }
  if (plan.kind === 'meal') {
    const meal = plan.meal as Record<string, number | string>;
    return `${meal.name} を記録しました（${meal.calories}kcal / P${meal.protein}g F${meal.fat}g C${meal.carbs}g）。`;
  }
  const names = plan.exercises.map(exercise => exercise.name).join('、');
  const sets = plan.exercises.reduce((total, exercise) => total + exercise.sets.length, 0);
  return `${names} を記録しました（${plan.exercises.length}種目 / ${sets}セット）。`;
}
