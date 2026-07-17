import React, { useState, useRef, useMemo, useEffect } from 'react';
import { Plus, Camera, Calendar, Sparkles, Trash2, Pencil, X, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { Meal, UserGoals } from '../types';
import { AI_DAILY_LIMITS, loadAiUsage, incrementAiUsage, remainingOf, AiUsage } from '../utils/aiUsage';

export interface SectionDietProps {
  /** 選択中の日付（selectedDate）の食事一覧 */
  dayMeals: Meal[];
  allMeals: Meal[];
  /** 表示・記録対象の日付 'YYYY-MM-DD' */
  selectedDate: string;
  today: string;
  onSelectDate: (date: string) => void;
  addMeal: (meal: Omit<Meal, 'id'>) => void;
  updateMeal: (id: string, patch: Partial<Omit<Meal, 'id'>>) => void;
  deleteMeal: (id: string) => void;
  goals: UserGoals;
  onEditingChange?: (open: boolean) => void;
}

// 'YYYY-MM-DD' をローカルタイムのDateとして安全に解釈する（UTCズレ防止）
const parseDateStr = (dateStr: string): Date => new Date(dateStr + 'T00:00:00');

const shiftDateStr = (dateStr: string, n: number): string => {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + n);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const formatDateLabel = (dateStr: string): string =>
  parseDateStr(dateStr).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });

const formatDateShort = (dateStr: string): string => {
  const d = parseDateStr(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

const MEAL_TYPES = ['朝食', '昼食', '夕食', '間食', 'プレWO', 'ポストWO'] as const;

interface EstimateResult {
  name: string;
  baseAmount: string;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  confidence: 'high' | 'medium' | 'low';
  sourceType?: 'official' | 'web' | 'ai_estimate';
  sourceLabel?: string;
  sourceUrl?: string;
  note: string;
  servingOptions: { label: string; multiplier: number }[];
}

interface CachedEstimate extends EstimateResult {
  createdAt: string;
}

// 推定ルール変更前の誤ったチェーン商品キャッシュを再利用しない。旧キーのデータ自体は削除しない。
const ESTIMATE_CACHE_KEY = 'estimatedMealCache:v2';

const normalizeMealNameForCache = (name: string): string => name.trim().toLowerCase();

const loadEstimateCache = (): Record<string, CachedEstimate> => {
  try {
    const raw = localStorage.getItem(ESTIMATE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const saveEstimateCache = (cache: Record<string, CachedEstimate>) => {
  try {
    localStorage.setItem(ESTIMATE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // キャッシュの保存に失敗しても食事記録自体には影響させない
  }
};

const CONFIDENCE_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  high:   { label: '推定精度 高', color: '#a3e635', bg: 'rgba(163,230,53,0.1)' },
  medium: { label: '推定精度 中', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  low:    { label: '推定精度 低', color: '#f43f5e', bg: 'rgba(244,63,94,0.1)' },
};

const SOURCE_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  official:    { label: '公式情報', color: '#a3e635', bg: 'rgba(163,230,53,0.1)' },
  web:         { label: 'Web参照', color: '#818cf8', bg: 'rgba(129,140,248,0.1)' },
  ai_estimate: { label: 'AI推定',  color: '#a1a1aa', bg: 'rgba(161,161,170,0.1)' },
};

const LEGACY_SOURCE_TYPES: Record<string, NonNullable<Meal['sourceType']>> = {
  '公式情報': 'official',
  'Web参照': 'web',
  'AI推定': 'ai_estimate',
};

const looksLikeServingLabel = (value: string): boolean =>
  /^(?:(?:少なめ|普通|大盛り?|特盛)\s*)?(?:\d+(?:\.\d+)?\s*)?(?:食|人前|杯|個|枚|皿|本|切れ|g|グラム)$/.test(value);

// 旧データの「料理名（1食・Web参照）」だけを表示時に分離する。
// Meal自体は更新しないため、既存localStorageデータを破壊しない。
const getMealDisplay = (meal: Meal): {
  name: string;
  servingLabel?: string;
  sourceType?: NonNullable<Meal['sourceType']>;
} => {
  let name = meal.name.trim();
  let servingLabel = meal.servingLabel;
  let sourceType = meal.sourceType;

  if (!servingLabel || !sourceType) {
    const suffixMatch = name.match(/^(.*?)[（(]([^()（）]+)[）)]\s*$/);
    if (suffixMatch) {
      const parts = suffixMatch[2].split('・').map(part => part.trim()).filter(Boolean);
      const parsedSource = parts.find(part => LEGACY_SOURCE_TYPES[part]);
      const parsedServing = parts.find(looksLikeServingLabel);
      const allPartsRecognized = parts.length > 0 && parts.every(part => LEGACY_SOURCE_TYPES[part] || looksLikeServingLabel(part));

      if (allPartsRecognized && (parsedSource || parsedServing)) {
        name = suffixMatch[1].trim();
        sourceType ||= parsedSource ? LEGACY_SOURCE_TYPES[parsedSource] : undefined;
        servingLabel ||= parsedServing;
      }
    }
  }

  return { name: name || meal.name, servingLabel, sourceType };
};

const MEAL_TYPE_STYLE: Record<string, { border: string; chip: string; label: string }> = {
  '朝食':    { border: '#f59e0b', chip: 'rgba(245,158,11,0.12)', label: '#f59e0b' },
  '昼食':    { border: '#a3e635', chip: 'rgba(163,230,53,0.12)', label: '#a3e635' },
  '夕食':    { border: '#818cf8', chip: 'rgba(129,140,248,0.12)', label: '#818cf8' },
  '間食':    { border: '#52525b', chip: 'rgba(113,113,122,0.1)', label: '#a1a1aa' },
  'プレWO':  { border: '#f43f5e', chip: 'rgba(244,63,94,0.12)', label: '#f43f5e' },
  'ポストWO':{ border: '#10b981', chip: 'rgba(16,185,129,0.12)', label: '#10b981' },
};

export function SectionDiet({ dayMeals, allMeals, selectedDate, today, onSelectDate, addMeal, updateMeal, deleteMeal, goals, onEditingChange }: SectionDietProps) {
  const [isAdding, setIsAdding] = useState(false);
  const isToday = selectedDate === today;
  const relativeLabel = isToday ? 'TODAY' : selectedDate === shiftDateStr(today, -1) ? '昨日' : selectedDate === shiftDateStr(today, -2) ? '一昨日' : '';

  // 日付ピッカー（ミニカレンダーシート）
  const [isPickingDate, setIsPickingDate] = useState(false);
  const [calMonth, setCalMonth] = useState(() => selectedDate.slice(0, 7)); // 'YYYY-MM'
  const mealDates = useMemo(() => new Set(allMeals.map(m => m.date || today)), [allMeals, today]);

  const openDatePicker = () => {
    setCalMonth(selectedDate.slice(0, 7));
    setIsPickingDate(true);
  };

  const shiftCalMonth = (n: number) => {
    const d = parseDateStr(calMonth + '-01');
    d.setMonth(d.getMonth() + n);
    setCalMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  // カレンダーのマス目（月初の曜日ぶん先頭にnullを詰める）
  const calCells = useMemo(() => {
    const first = parseDateStr(calMonth + '-01');
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells: (string | null)[] = Array(first.getDay()).fill(null);
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push(`${calMonth}-${String(day).padStart(2, '0')}`);
    }
    return cells;
  }, [calMonth]);
  const [mealName, setMealName] = useState('');
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [fat, setFat] = useState('');
  const [carbs, setCarbs] = useState('');
  const [mealType, setMealType] = useState('');
  const suggestions = useMemo(() => {
    const seen = new Map<string, Meal>();
    [...allMeals].sort((a, b) => b.date.localeCompare(a.date)).forEach(m => {
      if (m.name.length > 2 && !seen.has(m.name)) seen.set(m.name, m);
    });
    return Array.from(seen.values()).slice(0, 5);
  }, [allMeals]);

  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [isAiResult, setIsAiResult] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 「料理名から推定」フロー
  const [isEstimating, setIsEstimating] = useState(false);
  const [estName, setEstName] = useState('');
  const [estLoading, setEstLoading] = useState(false);
  const [estError, setEstError] = useState<string | null>(null);
  const [estResult, setEstResult] = useState<EstimateResult | null>(null);
  const [estMultiplier, setEstMultiplier] = useState(1);
  const [estMealType, setEstMealType] = useState('');
  const [estFromCache, setEstFromCache] = useState(false);
  // AI利用回数（1日あたりの端末ローカル制限）。表示更新用にstateにも持つ
  const [aiUsage, setAiUsage] = useState<AiUsage>(loadAiUsage);

  // 登録済み食事の編集
  const [editingMeal, setEditingMeal] = useState<Meal | null>(null);
  const [editName, setEditName] = useState('');
  const [editCalories, setEditCalories] = useState('');
  const [editProtein, setEditProtein] = useState('');
  const [editFat, setEditFat] = useState('');
  const [editCarbs, setEditCarbs] = useState('');
  const [editMealType, setEditMealType] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [keyboardInset, setKeyboardInset] = useState(0);

  // 編集中は下部ナビを隠す（呼び出し元に通知）
  useEffect(() => {
    onEditingChange?.(!!editingMeal);
  }, [editingMeal, onEditingChange]);

  // iOSのソフトキーボード表示に合わせてシートを持ち上げる（visualViewportで実測）
  useEffect(() => {
    if (!editingMeal) { setKeyboardInset(0); return; }
    const vv = window.visualViewport;
    if (!vv) return;
    const handleResize = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardInset(inset);
    };
    handleResize();
    vv.addEventListener('resize', handleResize);
    vv.addEventListener('scroll', handleResize);
    return () => {
      vv.removeEventListener('resize', handleResize);
      vv.removeEventListener('scroll', handleResize);
    };
  }, [editingMeal]);

  const openEdit = (meal: Meal) => {
    setEditingMeal(meal);
    setEditName(meal.name);
    setEditCalories(String(meal.calories));
    setEditProtein(String(meal.protein));
    setEditFat(String(meal.fat));
    setEditCarbs(String(meal.carbs));
    setEditMealType(meal.mealType || '');
    setEditError(null);
  };

  const closeEdit = () => {
    setEditingMeal(null);
    setEditError(null);
  };

  const handleEditSave = () => {
    if (!editingMeal) return;
    const name = editName.trim();
    const kcal = parseFloat(editCalories);
    const p = parseFloat(editProtein);
    const f = parseFloat(editFat);
    const c = parseFloat(editCarbs);
    if (!name) {
      setEditError('食事名を入力してください');
      return;
    }
    if ([kcal, p, f, c].some(v => Number.isNaN(v) || v < 0)) {
      setEditError('kcal・P・F・Cは0以上の数値で入力してください');
      return;
    }
    updateMeal(editingMeal.id, {
      name,
      calories: kcal,
      protein: p,
      fat: f,
      carbs: c,
      mealType: editMealType || undefined,
    });
    closeEdit();
  };

  const recordMealWithFeedback = (newMeal: Omit<Meal, 'id'>) => {
    addMeal(newMeal);
    const totalKcal = dayMeals.reduce((s, m) => s + m.calories, 0) + newMeal.calories;
    const totalProtein = dayMeals.reduce((s, m) => s + m.protein, 0) + newMeal.protein;
    const remainKcal = Math.round(goals.calories - totalKcal);
    const remainProtein = Math.round(goals.protein - totalProtein);
    const datePrefix = isToday ? '' : `${formatDateShort(selectedDate)}に`;
    const msg = remainKcal < 0
      ? `✓ ${newMeal.name}を${datePrefix}記録  ${isToday ? '今日' : 'この日'}はしっかり食べた日`
      : `✓ ${newMeal.name}を${datePrefix}記録  残り ${remainKcal}kcal · P あと ${remainProtein}g`;
    setFeedbackMsg(msg);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedbackMsg(null), 1500);
  };

  const resetEstimate = () => {
    setIsEstimating(false);
    setEstName('');
    setEstError(null);
    setEstResult(null);
    setEstMultiplier(1);
    setEstMealType('');
    setEstFromCache(false);
  };

  const handleEstimate = async (forceRefresh = false) => {
    const trimmed = estName.trim();
    if (!trimmed || estLoading) return;

    const cacheKey = normalizeMealNameForCache(trimmed);

    // キャッシュ優先：追加のAI呼び出しなしで前回の推定結果を再利用する
    if (!forceRefresh) {
      const cached = loadEstimateCache()[cacheKey];
      if (cached) {
        const { createdAt, ...result } = cached;
        setEstResult(result);
        setEstMultiplier(1);
        setEstFromCache(true);
        setEstError(null);
        return;
      }
    }

    // 1日あたりの利用回数制限（キャッシュヒットは消費しない）。上限時はAPIを呼ばない
    const usage = loadAiUsage();
    if (usage.estimateMealCount >= AI_DAILY_LIMITS.estimateMeal) {
      setEstError('今日のAI推定回数の上限に達しました。明日また使えます。（手入力での記録はいつでもできます）');
      return;
    }

    setEstLoading(true);
    setEstError(null);
    setEstResult(null);
    setEstFromCache(false);
    // API呼び出しが発生する時点でカウント（失敗してもサーバー側コストは発生するため）
    setAiUsage(incrementAiUsage('estimateMealCount'));
    try {
      const response = await fetch('/api/estimate-meal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await response.json();
      if (!response.ok || !data.name) {
        setEstError(data.error || '推定に失敗しました。別の書き方で試してください。');
      } else {
        const result = data as EstimateResult;
        // Web/公式参照の使用有無はサーバー判定のため、レスポンスのsourceTypeで事後カウント
        if (result.sourceType === 'official' || result.sourceType === 'web') {
          setAiUsage(incrementAiUsage('estimateMealWebCount'));
        }
        setEstResult(result);
        setEstMultiplier(1);
        const cache = loadEstimateCache();
        cache[cacheKey] = { ...result, createdAt: new Date().toISOString() };
        saveEstimateCache(cache);
      }
    } catch {
      setEstError('通信エラーが発生しました。時間をおいて試してください。');
    } finally {
      setEstLoading(false);
    }
  };

  const handleEstimateRecord = () => {
    if (!estResult) return;
    const opt = estResult.servingOptions.find(o => o.multiplier === estMultiplier);
    const amountLabel = opt ? opt.label : `×${estMultiplier}`;
    recordMealWithFeedback({
      date: selectedDate,
      name: estResult.name,
      calories: Math.round(estResult.calories * estMultiplier),
      protein: Math.round(estResult.protein * estMultiplier),
      fat: Math.round(estResult.fat * estMultiplier),
      carbs: Math.round(estResult.carbs * estMultiplier),
      mealType: estMealType || undefined,
      servingLabel: amountLabel,
      sourceType: estResult.sourceType || 'ai_estimate',
      sourceLabel: estResult.sourceLabel,
      sourceUrl: estResult.sourceUrl,
      note: estResult.note,
    });
    resetEstimate();
  };

  // 推定結果を手動フォームに引き継いで微調整
  const handleEstimateToManual = () => {
    if (!estResult) return;
    setMealName(estResult.name);
    setCalories(String(Math.round(estResult.calories * estMultiplier)));
    setProtein(String(Math.round(estResult.protein * estMultiplier)));
    setFat(String(Math.round(estResult.fat * estMultiplier)));
    setCarbs(String(Math.round(estResult.carbs * estMultiplier)));
    setMealType(estMealType);
    setIsAiResult(true);
    resetEstimate();
    setIsAdding(true);
  };

  const handleManualAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!mealName) return;
    recordMealWithFeedback({
      date: selectedDate,
      name: mealName,
      calories: parseFloat(calories) || 0,
      protein: parseFloat(protein) || 0,
      fat: parseFloat(fat) || 0,
      carbs: parseFloat(carbs) || 0,
      mealType: mealType || undefined,
    });

    setMealName('');
    setCalories('');
    setProtein('');
    setFat('');
    setCarbs('');
    setMealType('');
    setIsAiResult(false);
    setIsAdding(false);
  };

  const compressImage = (file: File): Promise<string> =>
    new Promise((resolve) => {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 1024;
        let { width, height } = img;
        if (width > height) {
          if (width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
        } else {
          if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
    });

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    if (files.length > 5) {
      alert('一度に解析できる画像は5枚までです');
      e.target.value = '';
      return;
    }

    setAiAnalyzing(true);
    setIsAdding(true);
    resetEstimate();

    try {
      const compressedImages = await Promise.all(files.map(compressImage));
      const response = await fetch('/api/analyze-meal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: compressedImages }),
      });
      const data = await response.json();

      if (data.name || data.mealName) {
        setMealName(data.mealName || data.name || '解析された食事');
        setCalories(String(Math.round(data.calories || 0)));
        setProtein(String(Math.round(data.protein || 0)));
        setFat(String(Math.round(data.fat || 0)));
        setCarbs(String(Math.round(data.carbs || 0)));
        setIsAiResult(true);
      } else {
        alert('画像の解析に失敗しました。手動で入力してください。');
      }
    } catch (error) {
      console.error(error);
      alert('エラーが発生しました。手動で入力してください。');
    } finally {
      setAiAnalyzing(false);
      e.target.value = '';
    }
  };

  // 今日の合計
  const totalKcal    = dayMeals.reduce((s, m) => s + (m.calories || 0), 0);
  const totalProtein = dayMeals.reduce((s, m) => s + (m.protein || 0), 0);
  const totalFat     = dayMeals.reduce((s, m) => s + (m.fat || 0), 0);
  const totalCarbs   = dayMeals.reduce((s, m) => s + (m.carbs || 0), 0);
  const calPct       = goals.calories > 0 ? Math.min(100, (totalKcal / goals.calories) * 100) : 0;

  return (
    <div className="space-y-4 pb-24">
      {/* HEADER */}
      <div className="flex justify-between items-start">
        <div>
          <div className="text-[9px] font-black tracking-widest text-zinc-500 uppercase font-mono">DIET LOG</div>
          <h2 className="text-lg font-black text-white italic uppercase tracking-wide mt-0.5">
            {isToday ? '今日の食事' : `${formatDateShort(selectedDate)}の食事`}
          </h2>
          {isToday ? (
            <div className="text-[10px] text-zinc-600 font-mono mt-0.5">{formatDateLabel(selectedDate)}</div>
          ) : (
            <span
              className="inline-block text-[9px] font-bold px-2 py-0.5 rounded-full mt-1"
              style={{ color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.28)' }}
            >
              過去の記録
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1.5 items-end">
          <button
            type="button"
            onClick={() => { setIsAdding(!isAdding); setIsAiResult(false); resetEstimate(); }}
            className="bg-lime-400 text-black px-4 py-2 rounded-xl font-black text-xs flex items-center gap-1.5 active:scale-95 transition-all"
            style={{ boxShadow: '0 0 14px rgba(163,230,53,0.18)' }}
          >
            <Plus size={14} /> 手動追加
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-indigo-400 px-4 py-2 rounded-xl font-bold text-xs flex items-center gap-1.5 active:scale-95 transition-all border"
            style={{ background: 'rgba(129,140,248,0.08)', borderColor: 'rgba(129,140,248,0.2)' }}
          >
            <Camera size={14} /> AI写真解析
          </button>
          <button
            type="button"
            onClick={() => {
              if (isEstimating) { resetEstimate(); return; }
              setIsAdding(false);
              setIsAiResult(false);
              setIsEstimating(true);
            }}
            className="text-lime-400 px-4 py-2 rounded-xl font-bold text-xs flex items-center gap-1.5 active:scale-95 transition-all border"
            style={{ background: 'rgba(163,230,53,0.06)', borderColor: 'rgba(163,230,53,0.2)' }}
          >
            <Sparkles size={14} /> 料理名から推定
          </button>
        </div>
        <input type="file" ref={fileInputRef} onChange={handlePhotoUpload} accept="image/*" multiple className="hidden" />
      </div>

      {/* DATE STRIP */}
      <div
        className="ll-card flex items-center justify-between gap-2 px-2.5 py-2"
        style={!isToday ? { borderColor: 'rgba(251,191,36,0.25)' } : undefined}
      >
        <button
          type="button"
          onClick={() => onSelectDate(shiftDateStr(selectedDate, -1))}
          className="w-9 h-9 rounded-xl bg-zinc-800/80 border border-zinc-800 text-zinc-400 flex items-center justify-center active:scale-95 transition-all"
          aria-label="前の日"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          onClick={openDatePicker}
          className="flex-1 text-center py-1 rounded-xl active:bg-zinc-900/60 transition-colors"
        >
          <div className={`text-sm font-black ${isToday ? 'text-white' : 'text-amber-400'}`}>{formatDateLabel(selectedDate)}</div>
          <div className="text-[9px] text-zinc-600 font-mono mt-0.5">{relativeLabel ? `${relativeLabel} ` : ''}▾ タップして日付を選ぶ</div>
        </button>
        <button
          type="button"
          onClick={() => { if (!isToday) onSelectDate(shiftDateStr(selectedDate, 1)); }}
          disabled={isToday}
          className="w-9 h-9 rounded-xl bg-zinc-800/80 border border-zinc-800 text-zinc-400 flex items-center justify-center active:scale-95 transition-all disabled:opacity-30"
          aria-label="次の日"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {!isToday && (
        <div className="flex justify-center -mt-1">
          <button
            type="button"
            onClick={() => onSelectDate(today)}
            className="text-[10px] font-bold text-lime-400 px-3 py-1 rounded-full active:scale-95 transition-all"
            style={{ background: 'rgba(163,230,53,0.1)', border: '1px solid rgba(163,230,53,0.3)' }}
          >
            ↩ 今日へ戻る
          </button>
        </div>
      )}

      {/* DAY SUMMARY */}
      {dayMeals.length > 0 && (
        <div className="ll-card p-3.5">
          <div className="flex justify-between items-center mb-2">
            <span className="ll-label text-zinc-500 text-[9px]">{isToday ? "TODAY'S TOTAL" : `${formatDateShort(selectedDate)} TOTAL`}</span>
            <span className="text-[10px] font-mono font-bold text-zinc-500">{dayMeals.length}食</span>
          </div>
          <div className="flex justify-between items-center">
            <div className="text-center">
              <div className="ll-num text-lg text-white leading-none">{Math.round(totalKcal)}</div>
              <div className="ll-label text-zinc-600 text-[8px] mt-0.5">KCAL</div>
            </div>
            <div className="w-px h-8 bg-zinc-800" />
            <div className="text-center">
              <div className="ll-num text-lg text-rose-400 leading-none">{Math.round(totalProtein)}</div>
              <div className="ll-label text-zinc-600 text-[8px] mt-0.5">P(g)</div>
            </div>
            <div className="w-px h-8 bg-zinc-800" />
            <div className="text-center">
              <div className="ll-num text-lg text-amber-400 leading-none">{Math.round(totalFat)}</div>
              <div className="ll-label text-zinc-600 text-[8px] mt-0.5">F(g)</div>
            </div>
            <div className="w-px h-8 bg-zinc-800" />
            <div className="text-center">
              <div className="ll-num text-lg text-blue-400 leading-none">{Math.round(totalCarbs)}</div>
              <div className="ll-label text-zinc-600 text-[8px] mt-0.5">C(g)</div>
            </div>
            <div className="w-px h-8 bg-zinc-800" />
            <div className="text-center">
              <div className="ll-num text-lg text-lime-400 leading-none">{Math.round(calPct)}%</div>
              <div className="ll-label text-zinc-600 text-[8px] mt-0.5">目標</div>
            </div>
          </div>
          <div className="mt-2.5 h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full rounded-full ll-bar-fill" style={{ width: `${calPct}%`, background: 'linear-gradient(90deg,#84cc16,#a3e635)' }} />
          </div>
        </div>
      )}

      <p className="text-[10px] text-zinc-700">写真はAI解析のため外部サービスに送信されます</p>

      {isEstimating && (
        <div className="ll-card ll-pop p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-lime-400 font-bold text-xs">
              <Sparkles size={14} /> 料理名からかんたん追加
              {!isToday && <span className="text-[9px] font-bold text-amber-400">→ {formatDateShort(selectedDate)}に記録</span>}
            </div>
            <span className="text-[9px] font-bold text-zinc-500 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 tracking-widest font-mono uppercase">AI推定</span>
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              placeholder="例: 夏野菜カレーライス"
              value={estName}
              onChange={(e) => setEstName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleEstimate(false); } }}
              className="flex-1 min-w-0 bg-zinc-800 border-0 rounded-lg p-3 text-white placeholder:text-zinc-600 text-sm focus:ring-1 focus:ring-lime-400 outline-none"
            />
            <button
              type="button"
              onClick={() => handleEstimate(false)}
              disabled={estLoading || !estName.trim()}
              className="shrink-0 bg-lime-400 text-black px-4 rounded-lg font-black text-xs disabled:opacity-40 active:scale-95 transition-all"
            >
              {estLoading ? '推定中…' : '目安を出す'}
            </button>
          </div>

          <p className="text-[9px] font-bold text-zinc-600">
            今日あと{remainingOf(aiUsage.estimateMealCount, AI_DAILY_LIMITS.estimateMeal)}回
            {remainingOf(aiUsage.estimateMealWebCount, AI_DAILY_LIMITS.estimateMealWeb) === 0 && (
              <span className="text-amber-500/80">（公式/Web参照は本日の目安回数を使い切りました）</span>
            )}
          </p>

          {estLoading && (
            <div className="flex items-center justify-center gap-2 py-4 text-lime-400 text-xs font-bold animate-pulse">
              <div className="w-4 h-4 border-2 border-lime-400 border-t-transparent rounded-full animate-spin" />
              一般的な目安を推定しています…
            </div>
          )}

          {estError && (
            <p className="text-[11px] text-rose-400 font-bold">{estError}</p>
          )}

          {estResult && !estLoading && (
            <div className="space-y-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h4 className="font-bold text-white text-sm ll-clamp2">{estResult.name}</h4>
                  <div className="text-[10px] text-zinc-500 font-mono mt-0.5">基準量：{estResult.baseAmount}</div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span
                    className="text-[9px] font-bold px-2 py-0.5 rounded-full"
                    style={{ color: CONFIDENCE_STYLE[estResult.confidence].color, background: CONFIDENCE_STYLE[estResult.confidence].bg }}
                  >
                    {CONFIDENCE_STYLE[estResult.confidence].label}
                  </span>
                  <span
                    className="text-[9px] font-bold px-2 py-0.5 rounded-full"
                    style={{
                      color: (SOURCE_STYLE[estResult.sourceType || 'ai_estimate']).color,
                      background: (SOURCE_STYLE[estResult.sourceType || 'ai_estimate']).bg,
                    }}
                  >
                    {(SOURCE_STYLE[estResult.sourceType || 'ai_estimate']).label}
                  </span>
                </div>
              </div>

              {estResult.sourceLabel && (
                <div className="text-[10px] text-zinc-500 -mt-2 ll-clamp2">
                  {estResult.sourceLabel}
                  {estResult.sourceUrl && (
                    <a
                      href={estResult.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-400 ml-1.5 underline"
                    >
                      情報元を見る
                    </a>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between -mt-2">
                <span className="text-[9px] text-zinc-600 font-mono">
                  {estFromCache ? '保存済み推定を使用中' : ''}
                </span>
                <button
                  type="button"
                  onClick={() => handleEstimate(true)}
                  disabled={estLoading}
                  className="text-[10px] text-zinc-500 hover:text-lime-400 font-bold flex items-center gap-1 disabled:opacity-40 transition-colors"
                >
                  <RefreshCw size={11} /> 再推定する
                </button>
              </div>

              {/* 量の選択チップ */}
              <div>
                <div className="text-[10px] font-bold text-zinc-500 mb-1.5">量をえらぶ</div>
                <div className="flex gap-1.5 flex-wrap">
                  {estResult.servingOptions.map(o => {
                    const isActive = estMultiplier === o.multiplier;
                    return (
                      <button
                        key={o.label}
                        type="button"
                        onClick={() => setEstMultiplier(o.multiplier)}
                        className="text-[11px] font-bold px-3 py-1.5 rounded-full transition-all"
                        style={{
                          background: isActive ? 'rgba(163,230,53,0.12)' : 'rgba(39,39,42,0.6)',
                          color: isActive ? '#a3e635' : '#71717a',
                          border: `1px solid ${isActive ? 'rgba(163,230,53,0.35)' : '#3f3f46'}`,
                        }}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 選択量に応じた目安値 */}
              <div className="flex justify-between items-center rounded-xl bg-zinc-800/60 border border-zinc-800 px-4 py-3">
                <div className="text-center">
                  <div className="ll-num text-lg text-white leading-none">{Math.round(estResult.calories * estMultiplier)}</div>
                  <div className="ll-label text-zinc-600 text-[8px] mt-0.5">KCAL</div>
                </div>
                <div className="w-px h-8 bg-zinc-700/60" />
                <div className="text-center">
                  <div className="ll-num text-lg text-rose-400 leading-none">{Math.round(estResult.protein * estMultiplier)}</div>
                  <div className="ll-label text-zinc-600 text-[8px] mt-0.5">P(g)</div>
                </div>
                <div className="w-px h-8 bg-zinc-700/60" />
                <div className="text-center">
                  <div className="ll-num text-lg text-amber-400 leading-none">{Math.round(estResult.fat * estMultiplier)}</div>
                  <div className="ll-label text-zinc-600 text-[8px] mt-0.5">F(g)</div>
                </div>
                <div className="w-px h-8 bg-zinc-700/60" />
                <div className="text-center">
                  <div className="ll-num text-lg text-blue-400 leading-none">{Math.round(estResult.carbs * estMultiplier)}</div>
                  <div className="ll-label text-zinc-600 text-[8px] mt-0.5">C(g)</div>
                </div>
              </div>

              <p className="text-[10px] text-zinc-600 leading-relaxed">{estResult.note}</p>

              {/* 食事タイプ チップ */}
              <div className="flex gap-1.5 flex-wrap">
                {MEAL_TYPES.map(t => {
                  const style = MEAL_TYPE_STYLE[t];
                  const isActive = estMealType === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setEstMealType(isActive ? '' : t)}
                      className="text-[11px] font-bold px-3 py-1 rounded-full transition-all"
                      style={{
                        background: isActive ? style.chip : 'rgba(39,39,42,0.6)',
                        color: isActive ? style.label : '#71717a',
                        border: `1px solid ${isActive ? style.border + '44' : '#3f3f46'}`,
                      }}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>

              <div className="flex gap-2">
                <button type="button" onClick={handleEstimateRecord} className="flex-1 bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm shadow-md active:scale-95 transition-all">
                  この目安で記録
                </button>
                <button type="button" onClick={handleEstimateToManual} className="flex-1 bg-zinc-800 text-white py-2.5 rounded-xl font-bold text-sm active:scale-95 transition-all">
                  数値を手動調整
                </button>
              </div>
            </div>
          )}

          <button type="button" onClick={resetEstimate} className="w-full text-zinc-500 text-xs font-bold hover:text-white transition-colors">
            閉じる
          </button>
        </div>
      )}

      {isAdding && (
        <form onSubmit={handleManualAdd} className="ll-card ll-pop p-5 space-y-4 relative">
          {aiAnalyzing && (
            <div className="absolute inset-0 bg-black/80 rounded-2xl flex flex-col items-center justify-center space-y-3 z-10">
              <div className="w-10 h-10 border-4 border-lime-400 border-t-transparent rounded-full animate-spin" />
              <div className="flex items-center gap-1.5 text-lime-400 font-bold text-xs animate-pulse">
                <Sparkles size={14} /> <span>AI食事解析中...</span>
              </div>
            </div>
          )}

          {!isToday && (
            <p className="text-[10px] font-bold text-amber-400 -mb-1">{formatDateShort(selectedDate)}の記録として保存されます</p>
          )}

          {/* 食事タイプ チップ */}
          <div>
            <div className="text-[10px] font-bold text-zinc-500 mb-2">食事の種類（任意）</div>
            <div className="flex gap-1.5 flex-wrap">
              {MEAL_TYPES.map(t => {
                const style = MEAL_TYPE_STYLE[t];
                const isActive = mealType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setMealType(isActive ? '' : t)}
                    className="text-[11px] font-bold px-3 py-1 rounded-full transition-all"
                    style={{
                      background: isActive ? style.chip : 'rgba(39,39,42,0.6)',
                      color: isActive ? style.label : '#71717a',
                      border: `1px solid ${isActive ? style.border + '44' : '#3f3f46'}`,
                    }}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-zinc-400" htmlFor="meal-name-input">食事名 / メニュー</label>
              {isAiResult && (
                <span className="text-[9px] font-bold text-zinc-500 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 tracking-widest font-mono uppercase">AI推定</span>
              )}
            </div>
            {!isAiResult && mealName === '' && suggestions.length > 0 && (
              <div className="space-y-1">
                <p className="text-[9px] text-zinc-700 tracking-wider font-mono">最近の食品</p>
                <div className="flex gap-2 overflow-x-auto pb-0.5">
                  {suggestions.map(s => (
                    <button
                      type="button"
                      key={s.name}
                      onClick={() => {
                        setMealName(s.name);
                        setCalories(String(s.calories));
                        setProtein(String(s.protein));
                        setFat(String(s.fat));
                        setCarbs(String(s.carbs));
                      }}
                      className="shrink-0 text-[10px] text-zinc-400 bg-zinc-800 border border-zinc-700 rounded-full px-2.5 py-1 font-medium"
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <input
              id="meal-name-input"
              type="text"
              placeholder="例: チキン胸肉とブロッコリー"
              value={mealName}
              onChange={(e) => setMealName(e.target.value)}
              className="w-full bg-zinc-800 border-0 rounded-lg p-3 text-white placeholder:text-zinc-600 text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              required
            />
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-zinc-400" htmlFor="calories-input">KCAL</label>
              <input
                id="calories-input"
                type="number"
                placeholder="0"
                value={calories}
                onChange={(e) => setCalories(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-zinc-400 hover:text-lime-400" htmlFor="protein-input">P (g)</label>
              <input
                id="protein-input"
                type="number"
                placeholder="0"
                value={protein}
                onChange={(e) => setProtein(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-zinc-400 hover:text-orange-400" htmlFor="fat-input">F (g)</label>
              <input
                id="fat-input"
                type="number"
                placeholder="0"
                value={fat}
                onChange={(e) => setFat(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-zinc-400 hover:text-cyan-400" htmlFor="carbs-input">C (g)</label>
              <input
                id="carbs-input"
                type="number"
                placeholder="0"
                value={carbs}
                onChange={(e) => setCarbs(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
          </div>
          {isAiResult && (
            <p className="text-[10px] text-zinc-600 text-center -mt-1">量が違う場合は、保存前に調整できます</p>
          )}
          <div className="flex gap-2">
            <button type="submit" className="flex-1 bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm shadow-md">
              保存する
            </button>
            <button type="button" onClick={() => { setIsAdding(false); setIsAiResult(false); }} className="flex-1 bg-zinc-800 text-white py-2.5 rounded-xl font-bold text-sm">
              キャンセル
            </button>
          </div>
        </form>
      )}

      {feedbackMsg && (
        <div className="ll-pop ll-glow flex items-center gap-2.5 text-xs font-bold text-lime-400 bg-lime-400/10 border border-lime-400/25 rounded-2xl px-4 py-3">
          <span className="shrink-0 w-5 h-5 rounded-full bg-lime-400 text-black flex items-center justify-center text-[11px] font-black">✓</span>
          <span className="min-w-0 break-words">{feedbackMsg.replace(/^✓\s*/, '')}</span>
        </div>
      )}

      {dayMeals.length > 0 ? (
        <div className="space-y-2.5">
          {dayMeals.map((meal) => {
            const typeStyle = meal.mealType ? MEAL_TYPE_STYLE[meal.mealType] : null;
            const display = getMealDisplay(meal);
            const sourceStyle = display.sourceType ? SOURCE_STYLE[display.sourceType] : null;
            return (
              <div
                key={meal.id}
                role="button"
                tabIndex={0}
                onClick={() => openEdit(meal)}
                onKeyDown={(e) => { if (e.key === 'Enter') openEdit(meal); }}
                className="ll-card ll-pop max-w-full overflow-hidden p-3.5 flex items-start gap-2.5 cursor-pointer active:scale-[0.99] transition-transform"
                style={typeStyle ? { borderLeft: `3px solid ${typeStyle.border}` } : undefined}
              >
                <div className="min-w-0 max-w-full flex-1 overflow-hidden">
                  {(meal.mealType || display.servingLabel || sourceStyle) && (
                    <div className="flex max-w-full flex-wrap gap-1 mb-1.5">
                      {meal.mealType && typeStyle && (
                        <span
                          className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                          style={{ background: typeStyle.chip, color: typeStyle.label, border: `1px solid ${typeStyle.border}33` }}
                        >
                          {meal.mealType}
                        </span>
                      )}
                      {display.servingLabel && (
                        <span className="shrink-0 text-[9px] font-bold text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded-full border border-zinc-700">
                          {display.servingLabel}
                        </span>
                      )}
                      {sourceStyle && (
                        <span
                          className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                          style={{ color: sourceStyle.color, background: sourceStyle.bg, border: `1px solid ${sourceStyle.color}33` }}
                        >
                          {sourceStyle.label}
                        </span>
                      )}
                    </div>
                  )}
                  <h4 className="max-w-full font-bold text-white text-sm break-words line-clamp-2 ll-clamp2">{display.name}</h4>
                  <div className="flex max-w-full flex-wrap gap-x-2.5 gap-y-0.5 mt-1 text-[11px] font-mono text-zinc-600">
                    <span>P <strong className="text-rose-400">{meal.protein}g</strong></span>
                    <span>F <strong className="text-amber-400">{meal.fat}g</strong></span>
                    <span>C <strong className="text-blue-400">{meal.carbs}g</strong></span>
                  </div>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1.5">
                  <div className="text-right">
                    <div className="ll-num text-lg text-white leading-none">{meal.calories}</div>
                    <div className="ll-label text-zinc-600 text-[9px]">kcal</div>
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={`${display.name}を編集`}
                      onClick={(e) => { e.stopPropagation(); openEdit(meal); }}
                      className="w-8 h-8 shrink-0 rounded-lg text-zinc-500 hover:text-lime-400 hover:bg-zinc-800 transition-colors flex items-center justify-center"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      aria-label={`${display.name}を削除`}
                      onClick={(e) => { e.stopPropagation(); deleteMeal(meal.id); }}
                      className="w-8 h-8 shrink-0 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-zinc-800 transition-colors flex items-center justify-center"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center text-center space-y-5 px-8 pt-8 pb-6" style={{ minHeight: 'calc(100dvh - max(1.5rem, env(safe-area-inset-top)) - 80px - 220px)' }}>
          <div className="relative">
            <div className="absolute inset-0 rounded-full bg-lime-400/10 blur-xl" />
            <div className="relative w-16 h-16 ll-card rounded-full flex items-center justify-center text-lime-400/70">
              <Sparkles size={26} />
            </div>
          </div>
          <div>
            <p className="text-white font-bold">{isToday ? '今日はまだ記録がありません' : `${formatDateShort(selectedDate)}の記録はありません`}</p>
            <p className="text-zinc-500 text-sm mt-1.5 leading-relaxed">
              {isToday
                ? '料理名を入れるだけで、AIがPFCとカロリーの目安を出します。'
                : 'この日に食べたものを、あとからでも記録できます。'}
            </p>
          </div>
          <div className="flex flex-col items-center gap-2.5 w-full max-w-[240px]">
            <button
              type="button"
              onClick={() => { setIsAdding(false); setIsAiResult(false); setIsEstimating(true); }}
              className="ll-glow bg-lime-400 text-black w-full px-6 py-3 rounded-2xl font-black text-sm flex items-center justify-center gap-2 active:scale-95 transition-all"
            >
              <Sparkles size={16} /> 料理名から推定
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-indigo-400 w-full px-6 py-2.5 rounded-2xl font-bold text-xs flex items-center justify-center gap-1.5 active:scale-95 transition-all border"
              style={{ background: 'rgba(129,140,248,0.08)', borderColor: 'rgba(129,140,248,0.2)' }}
            >
              <Camera size={14} /> 写真から記録する
            </button>
          </div>
          <button
            type="button"
            onClick={() => { setIsAdding(true); setIsAiResult(false); }}
            className="text-zinc-500 text-xs font-bold hover:text-white transition-colors"
          >
            手動で入力する
          </button>
        </div>
      )}

      {/* 日付選択ボトムシート */}
      {isPickingDate && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center" onClick={() => setIsPickingDate(false)}>
          <div className="absolute inset-0 bg-black/70" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md ll-card ll-pop rounded-t-3xl rounded-b-none p-5"
            style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
          >
            <div className="flex items-center justify-between mb-4">
              <button
                type="button"
                onClick={() => shiftCalMonth(-1)}
                className="w-8 h-8 rounded-xl bg-zinc-800/80 border border-zinc-800 text-zinc-400 flex items-center justify-center active:scale-95 transition-all"
                aria-label="前の月"
              >
                <ChevronLeft size={15} />
              </button>
              <div className="text-sm font-black text-white font-mono">
                {`${calMonth.slice(0, 4)}年${parseInt(calMonth.slice(5), 10)}月`}
              </div>
              <button
                type="button"
                onClick={() => { if (calMonth < today.slice(0, 7)) shiftCalMonth(1); }}
                disabled={calMonth >= today.slice(0, 7)}
                className="w-8 h-8 rounded-xl bg-zinc-800/80 border border-zinc-800 text-zinc-400 flex items-center justify-center active:scale-95 transition-all disabled:opacity-30"
                aria-label="次の月"
              >
                <ChevronRight size={15} />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1 text-center">
              {['日', '月', '火', '水', '木', '金', '土'].map(d => (
                <div key={d} className="text-[9px] font-black text-zinc-600 font-mono py-1">{d}</div>
              ))}
              {calCells.map((dateStr, i) => {
                if (!dateStr) return <div key={`blank-${i}`} />;
                const isFuture = dateStr > today;
                const isSelected = dateStr === selectedDate;
                const isTodayCell = dateStr === today;
                const hasRecord = mealDates.has(dateStr);
                return (
                  <button
                    key={dateStr}
                    type="button"
                    disabled={isFuture}
                    onClick={() => { onSelectDate(dateStr); setIsPickingDate(false); }}
                    className="relative py-2 rounded-lg text-[12px] font-mono font-bold transition-all active:scale-95"
                    style={{
                      color: isFuture ? '#232326' : isSelected ? '#000' : '#a1a1aa',
                      background: isSelected ? '#a3e635' : 'transparent',
                      border: isTodayCell && !isSelected ? '1px solid rgba(163,230,53,0.4)' : '1px solid transparent',
                    }}
                  >
                    {parseInt(dateStr.slice(8), 10)}
                    {hasRecord && !isFuture && (
                      <span
                        className="absolute left-1/2 -translate-x-1/2 bottom-0.5 w-1 h-1 rounded-full"
                        style={{ background: isSelected ? '#000' : '#818cf8' }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2 mt-3 px-1">
              <span className="w-1 h-1 rounded-full bg-indigo-400 inline-block" />
              <span className="text-[9px] text-zinc-500">記録がある日</span>
              <span className="w-2.5 h-2.5 border rounded ml-2 inline-block" style={{ borderColor: 'rgba(163,230,53,0.4)' }} />
              <span className="text-[9px] text-zinc-500">今日</span>
            </div>

            <button
              type="button"
              onClick={() => { onSelectDate(today); setIsPickingDate(false); }}
              className="w-full bg-zinc-800 text-white py-2.5 rounded-xl font-bold text-sm mt-3 active:scale-95 transition-all"
            >
              今日へ戻る
            </button>
          </div>
        </div>
      )}

      {editingMeal && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center" onClick={closeEdit}>
          <div className="absolute inset-0 bg-black/70" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md ll-card ll-pop rounded-t-3xl rounded-b-none flex flex-col"
            style={{
              maxHeight: 'calc(100dvh - max(1rem, env(safe-area-inset-top)))',
              transform: keyboardInset > 0 ? `translateY(-${keyboardInset}px)` : undefined,
              transition: 'transform 0.15s ease-out',
            }}
          >
            {/* ヘッダー（固定） */}
            <div className="shrink-0 flex items-center justify-between p-5 pb-3 border-b border-zinc-800">
              <h3 className="font-black text-white text-sm uppercase tracking-wide">食事を編集</h3>
              <button type="button" onClick={closeEdit} className="text-zinc-500 hover:text-white transition-colors p-1">
                <X size={18} />
              </button>
            </div>

            {/* 本文（スクロール可能） */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4" style={{ WebkitOverflowScrolling: 'touch' }}>
              {/* 食事タイプ チップ */}
              <div>
                <div className="text-[10px] font-bold text-zinc-500 mb-2">食事の種類（任意）</div>
                <div className="flex gap-1.5 flex-wrap">
                  {MEAL_TYPES.map(t => {
                    const style = MEAL_TYPE_STYLE[t];
                    const isActive = editMealType === t;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setEditMealType(isActive ? '' : t)}
                        className="text-[11px] font-bold px-3 py-1 rounded-full transition-all"
                        style={{
                          background: isActive ? style.chip : 'rgba(39,39,42,0.6)',
                          color: isActive ? style.label : '#71717a',
                          border: `1px solid ${isActive ? style.border + '44' : '#3f3f46'}`,
                        }}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold text-zinc-400" htmlFor="edit-meal-name-input">食事名 / メニュー</label>
                <input
                  id="edit-meal-name-input"
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-zinc-800 border-0 rounded-lg p-3 text-white placeholder:text-zinc-600 text-sm focus:ring-1 focus:ring-lime-400 outline-none"
                />
              </div>

              <div className="grid grid-cols-4 gap-2">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-zinc-400" htmlFor="edit-calories-input">KCAL</label>
                  <input
                    id="edit-calories-input"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={editCalories}
                    onChange={(e) => setEditCalories(e.target.value)}
                    className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-zinc-400" htmlFor="edit-protein-input">P (g)</label>
                  <input
                    id="edit-protein-input"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={editProtein}
                    onChange={(e) => setEditProtein(e.target.value)}
                    className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-zinc-400" htmlFor="edit-fat-input">F (g)</label>
                  <input
                    id="edit-fat-input"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={editFat}
                    onChange={(e) => setEditFat(e.target.value)}
                    className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-zinc-400" htmlFor="edit-carbs-input">C (g)</label>
                  <input
                    id="edit-carbs-input"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={editCarbs}
                    onChange={(e) => setEditCarbs(e.target.value)}
                    className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
                  />
                </div>
              </div>

              {editError && (
                <p className="text-[11px] text-rose-400 font-bold">{editError}</p>
              )}
            </div>

            {/* フッター（固定・常に操作可能） */}
            <div
              className="shrink-0 flex gap-2 p-4 border-t border-zinc-800"
              style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
            >
              <button type="button" onClick={handleEditSave} className="flex-1 bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm shadow-md active:scale-95 transition-all">
                保存する
              </button>
              <button type="button" onClick={closeEdit} className="flex-1 bg-zinc-800 text-white py-2.5 rounded-xl font-bold text-sm active:scale-95 transition-all">
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
