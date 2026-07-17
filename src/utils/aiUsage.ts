// AI機能の1日あたり利用回数制限（端末ローカル・localStorageベース）。
// テスト運用中のOpenAIコスト暴発防止が目的の簡易対策で、厳密な不正防止ではない。
// ログイン導入後はサーバー側のユーザー単位制限へ移行する想定。

export const AI_DAILY_LIMITS = {
  // 料理名PFC推定の合計（Web/公式参照つきを含む）
  estimateMeal: 10,
  // うちWeb/公式参照つき推定。使用有無はサーバーが判定するため事後カウント（表示用の目安）
  estimateMealWeb: 5,
  // AI目標提案
  suggestGoals: 3,
} as const;

const USAGE_KEY = 'ai_usage_limits';

export interface AiUsage {
  date: string;
  estimateMealCount: number;
  estimateMealWebCount: number;
  suggestGoalsCount: number;
}

// ローカル日付 YYYY-MM-DD（UTCではなく端末のタイムゾーン基準）
const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const emptyUsage = (): AiUsage => ({
  date: localToday(),
  estimateMealCount: 0,
  estimateMealWebCount: 0,
  suggestGoalsCount: 0,
});

// 日付が変わっていたら自動リセット。parse失敗時も安全側でリセットする
export const loadAiUsage = (): AiUsage => {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (!raw) return emptyUsage();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.date !== localToday()) return emptyUsage();
    return {
      date: parsed.date,
      estimateMealCount: Number(parsed.estimateMealCount) || 0,
      estimateMealWebCount: Number(parsed.estimateMealWebCount) || 0,
      suggestGoalsCount: Number(parsed.suggestGoalsCount) || 0,
    };
  } catch {
    return emptyUsage();
  }
};

export const incrementAiUsage = (
  key: 'estimateMealCount' | 'estimateMealWebCount' | 'suggestGoalsCount',
): AiUsage => {
  const usage = loadAiUsage();
  usage[key] += 1;
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    // 保存に失敗しても機能自体は止めない（制限より記録継続を優先）
  }
  return usage;
};

export const remainingOf = (used: number, limit: number): number => Math.max(0, limit - used);
