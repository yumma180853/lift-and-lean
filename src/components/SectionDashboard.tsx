import React, { useMemo } from 'react';
import { 
  Dumbbell, 
  Utensils, 
  TrendingUp, 
  Flame, 
  AlertTriangle, 
  BatteryCharging, 
  Zap, 
  Activity 
} from 'lucide-react';
import { Workout, Meal, UserGoals, WeightRecord, StreakData } from '../types';

type PFCStatus =
  | 'no_record' | 'p_low' | 'p_low_cal_low' | 'f_high_p_low'
  | 'f_high' | 'cal_over' | 'cal_low' | 'good' | 'balanced';

function evaluatePFC(
  stats: { protein: number; fat: number; calories: number },
  goals: { protein: number; fat: number; calories: number },
  hasMeals: boolean
): PFCStatus {
  if (!hasMeals) return 'no_record';
  const p   = goals.protein  > 0 ? stats.protein  / goals.protein  : null;
  const f   = goals.fat      > 0 ? stats.fat       / goals.fat      : null;
  const cal = goals.calories > 0 ? stats.calories  / goals.calories : null;
  if (p !== null && p < 0.7 && cal !== null && cal < 0.6) return 'p_low_cal_low';
  if (p !== null && p < 0.7 && f !== null && f > 1.2)    return 'f_high_p_low';
  if (p !== null && p < 0.7)                              return 'p_low';
  if (f !== null && f > 1.2)                              return 'f_high';
  if (cal !== null && cal > 1.2)                          return 'cal_over';
  if (cal !== null && cal < 0.6)                          return 'cal_low';
  if (p !== null && p >= 0.85)                            return 'good';
  return 'balanced';
}

function getPFCFeedback(
  status: PFCStatus,
  protein: number,
  goalProtein: number
): string {
  const remaining = Math.max(0, Math.round(goalProtein - protein));
  const pRate = goalProtein > 0 ? protein / goalProtein : 0;
  switch (status) {
    case 'no_record':     return '今日はまだ記録がないよ。1食でも入れてみて。';
    case 'p_low':
      return pRate >= 0.5
        ? `Pあと${remaining}g。次は鶏むねやプロテインで届かせよう。`
        : `Pあと${remaining}g。プロテイン1杯で届くよ。`;
    case 'p_low_cal_low':
      return pRate >= 0.5
        ? `Pあと${remaining}g。次は鶏むねやプロテインで届かせよう。`
        : '食事量もPも少なめ。次は鶏むねやサラダチキンを1品足してみて。';
    case 'f_high_p_low':  return '脂質が多めでPはまだ少ない。次はサラダチキンや豆腐が合いそう。';
    case 'f_high':        return '脂質はやや多め。次は低脂質なタンパク質に寄せよう。';
    case 'cal_over':      return '今日はしっかり食べた日。明日から戻せばOK。';
    case 'cal_low':       return '今日は少なめ。意図的ならOK、無理な制限は避けよう。';
    case 'good':          return 'Pしっかり取れてる。この調子。';
    case 'balanced':      return 'カロリーは良い感じ。PFCもかなり整ってる。';
  }
}

export interface SectionDashboardProps {
  todayStats: { calories: number; protein: number; fat: number; carbs: number };
  goals: UserGoals;
  weightHistory: WeightRecord[];
  today: string;
  todayWorkout: Workout | undefined;
  todayMeals: Meal[];
  currentWeight: number | null;
  addWeight: (weight: number) => void;
  setActiveTab: (tab: any) => void;
  openWeightModal: () => void;
  workouts: Workout[];
  meals: Meal[];
  streakData: StreakData;
}

const detectCategory = (name: string): string => {
  const n = name.toLowerCase();
  if (n.includes('クランチ') || n.includes('レッグレイズ') || n.includes('プランク') || n.includes('アブローラー') || n.includes('腹筋') || n.includes('シットアップ')) return '腹筋';
  if (n.includes('ベンチ') || n.includes('プレス') && (n.includes('チェスト') || n.includes('ダンベル') || n.includes('インクライン')) || n.includes('フライ') || n.includes('胸') || n.includes('ペック')) return '胸';
  if (n.includes('チンニング') || n.includes('懸垂') || n.includes('ラット') || n.includes('プル') || n.includes('ロー') || n.includes('デッドリフト') || n.includes('背中')) return '背中';
  if (n.includes('ショルダー') || n.includes('レイズ') || n.includes('ミリタリー' ) || n.includes('肩')) return '肩';
  if (n.includes('カール') || n.includes('プッシュダウン') || n.includes('スカル') || n.includes('腕') || n.includes('バイセプス') || n.includes('トライセプス')) return '腕';
  if (n.includes('スクワット') || n.includes('レッグ') || n.includes('プレス') && n.includes('レッグ') || n.includes('脚') || n.includes('ふくらはぎ')) return '脚';
  return 'ignore';
};

export function SectionDashboard({
  todayStats,
  goals,
  weightHistory,
  today,
  todayWorkout,
  todayMeals,
  currentWeight,
  setActiveTab,
  openWeightModal,
  workouts,
  meals,
  streakData,
}: SectionDashboardProps) {

  // 昨日と今日の連動から筋肉の状況を直感的なワードで算出
  const muscleStatuses = useMemo(() => {
    const trainedTodayCategories = new Set<string>();
    if (todayWorkout) {
      todayWorkout.exercises.forEach(ex => {
        if (ex.sets.length > 0) trainedTodayCategories.add(detectCategory(ex.name));
      });
    }

    const getYesterdayDateStr = (todayStr: string) => {
      const d = new Date(todayStr);
      d.setDate(d.getDate() - 1);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const yesterdayStr = getYesterdayDateStr(today);

    const yesterdayWorkout = workouts.find(w => w.date === yesterdayStr);
    const trainedYesterdayCategories = new Set<string>();
    if (yesterdayWorkout) {
      yesterdayWorkout.exercises.forEach(ex => {
        if (ex.sets.length > 0) trainedYesterdayCategories.add(detectCategory(ex.name));
      });
    }

    const yesterdayMeals = meals.filter(m => m.date === yesterdayStr);
    const yesterdayProtein = yesterdayMeals.reduce((sum, m) => sum + (m.protein || 0), 0);
    const isYesterdayProteinFull = yesterdayProtein >= goals.protein;

    const pRatioToday = goals.protein > 0 ? todayStats.protein / goals.protein : 0;
    const isProteinFullToday = pRatioToday >= 1.0;
    // 💡 UX改善：摂り始めたことを認める閾値（30%）
    const isProteinStarted = pRatioToday >= 0.3; 

    const categories = ['胸', '背中', '肩', '腕', '脚'];
    
    return categories.map(cat => {
      const isTrainedToday = trainedTodayCategories.has(cat);
      const isTrainedYesterday = trainedYesterdayCategories.has(cat);
      
      let statusText = '通常'; 
      let statusColor = 'zinc';
      let isHighlight = false;

      if (isTrainedToday) {
        isHighlight = true;
        // 💡 UX改善：0%〜29%（赤）、30%〜99%（オレンジ）、100%〜（ライム）のグラデーション判定！
        if (isProteinFullToday) {
          statusText = '超回復中';
          statusColor = 'lime';
        } else if (isProteinStarted) {
          statusText = '修復中';
          statusColor = 'amber'; // オレンジ（アンバー）
        } else {
          statusText = '要プロテイン';
          statusColor = 'rose'; // 赤（ローズ）
        }
      } else if (isTrainedYesterday) {
        isHighlight = true;
        if (isYesterdayProteinFull) {
          statusText = '修復完了';
          statusColor = 'emerald';
        } else {
          // 💡 昨日のペナルティも、今日のプロテイン状況に応じてグラデーション！
          if (isProteinFullToday) {
            statusText = '超回復中';
            statusColor = 'lime';
          } else if (isProteinStarted) {
            statusText = '修復中';
            statusColor = 'amber'; // オレンジ（アンバー）
          } else {
            statusText = '要プロテイン';
            statusColor = 'rose'; // 赤（ローズ）
          }
        }
      } else if (isProteinFullToday) {
        statusText = '栄養満タン';
        statusColor = 'emerald';
      }

      return {
        name: cat,
        isTrained: isHighlight,
        statusText,
        statusColor,
        progress: Math.min(100, Math.round(pRatioToday * 100))
      };
    });
  }, [todayWorkout, workouts, meals, todayStats.protein, goals.protein, today]);

  const calProgress = goals.calories > 0 ? (todayStats.calories / goals.calories) * 100 : 0;
  const pProgress = goals.protein > 0 ? (todayStats.protein / goals.protein) * 100 : 0;
  const fProgress = goals.fat > 0 ? (todayStats.fat / goals.fat) * 100 : 0;
  const cProgress = goals.carbs > 0 ? (todayStats.carbs / goals.carbs) * 100 : 0;

  const pfcStatus = evaluatePFC(todayStats, goals, todayMeals.length > 0);
  const pfcFeedback = getPFCFeedback(pfcStatus, todayStats.protein, goals.protein);

  return (
    <div className="space-y-5 pb-24">
      {/* HEADER WELCOME */}
      <div className="flex justify-between items-center bg-zinc-900/40 border border-zinc-900 p-4 rounded-3xl">
        <div>
          <span className="text-[10px] font-black tracking-widest text-zinc-500 uppercase font-mono">WELCOME BACK</span>
          <h1 className="text-lg font-black text-white italic uppercase tracking-wide">
            LIFT & LEAN
          </h1>
        </div>
        <button type="button" onClick={openWeightModal} className="bg-zinc-950 border border-zinc-850 hover:border-zinc-700 p-3 rounded-2xl text-center active:scale-95 transition-all" >
          <span className="text-[9px] font-black tracking-widest text-zinc-500 block uppercase font-mono">WEIGHT</span>
          <span className="text-sm font-mono font-black text-lime-400">{currentWeight ? `${currentWeight}kg` : '未測定'}</span>
        </button>
      </div>

      {/* STREAK */}
      {streakData.currentStreak >= 1 && (
        <div className="bg-zinc-900/40 border border-zinc-800/60 px-4 py-2.5 rounded-2xl flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm">📅</span>
            <span className="text-xs text-zinc-400">食事記録</span>
            <span className="text-sm font-black font-mono text-white">{streakData.currentStreak}日</span>
            <span className="text-xs text-zinc-400">継続中</span>
            {streakData.status === 'freeze_used' && (
              <span className="text-[10px] text-zinc-600">（1日お休みあり）</span>
            )}
          </div>
          {streakData.longestStreak >= 3 && streakData.longestStreak > streakData.currentStreak && (
            <span className="text-[10px] font-mono text-zinc-600">最長 {streakData.longestStreak}日</span>
          )}
        </div>
      )}
      {streakData.currentStreak === 0 && streakData.status === 'new' && (
        <div className="text-xs text-zinc-600 px-1">今日から記録を始めよう</div>
      )}

      {/* 1️⃣ TODAY'S ENERGY ACCUMULATOR */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5 shadow-xl space-y-5">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-indigo-400/10 rounded-lg text-indigo-400"><Utensils size={18} /></div>
            <div>
              <span className="text-[9px] font-black tracking-widest text-indigo-400 uppercase font-mono">NUTRITION SUMMARY</span>
              <h3 className="font-bold text-white text-sm">今日の栄養摂取状況</h3>
            </div>
          </div>
          <button type="button" onClick={() => setActiveTab('diet')} className="text-[10px] font-black text-indigo-400 hover:text-white transition-colors uppercase font-mono tracking-wider bg-indigo-400/5 border border-indigo-400/10 px-2.5 py-1 rounded-xl" > 食事ログへ </button>
        </div>

        <div className="bg-zinc-950 p-4 border border-zinc-900 rounded-2xl flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-[10px] font-black text-zinc-500 font-mono tracking-widest uppercase block">ENERGY CONSUMED</span>
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-black font-mono text-white tracking-tight">{Math.round(todayStats.calories)}</span>
              <span className="text-xs font-bold text-zinc-500 font-mono">/ {goals.calories} KCAL</span>
            </div>
          </div>
          <div className="w-12 h-12 rounded-full border-4 border-zinc-900 flex items-center justify-center relative overflow-hidden">
            <div className="absolute inset-0 bg-indigo-500/10" />
            <div className="absolute bottom-0 left-0 right-0 bg-indigo-500 transition-all duration-300" style={{ height: `${Math.min(100, calProgress)}%` }} />
            <span className="text-[10px] font-black text-white z-10 font-mono">{Math.round(calProgress)}%</span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="bg-zinc-950 p-3 border border-zinc-900 rounded-2xl space-y-2">
            <div className="flex justify-between text-[10px] font-black text-rose-400 font-mono tracking-wider"><span>P (プロテイン)</span><span>{Math.round(pProgress)}%</span></div>
            <div className="text-base font-black font-mono text-white">{Math.round(todayStats.protein)}<span className="text-[10px] text-zinc-500 font-normal ml-0.5">g</span><span className="text-[9px] text-zinc-600 block">/ {goals.protein}g</span></div>
            <div className="w-full h-1 bg-zinc-900 rounded-full overflow-hidden"><div className="h-full bg-rose-500 transition-all" style={{ width: `${pProgress}%` }} /></div>
          </div>
          <div className="bg-zinc-950 p-3 border border-zinc-900 rounded-2xl space-y-2">
            <div className="flex justify-between text-[10px] font-black text-amber-400 font-mono tracking-wider"><span>F (脂質)</span><span>{Math.round(fProgress)}%</span></div>
            <div className="text-base font-black font-mono text-white">{Math.round(todayStats.fat)}<span className="text-[10px] text-zinc-500 font-normal ml-0.5">g</span><span className="text-[9px] text-zinc-600 block">/ {goals.fat}g</span></div>
            <div className="w-full h-1 bg-zinc-900 rounded-full overflow-hidden"><div className="h-full bg-amber-500 transition-all" style={{ width: `${fProgress}%` }} /></div>
          </div>
          <div className="bg-zinc-950 p-3 border border-zinc-900 rounded-2xl space-y-2">
            <div className="flex justify-between text-[10px] font-black text-blue-400 font-mono tracking-wider"><span>C (炭水化物)</span><span>{Math.round(cProgress)}%</span></div>
            <div className="text-base font-black font-mono text-white">{Math.round(todayStats.carbs)}<span className="text-[10px] text-zinc-500 font-normal ml-0.5">g</span><span className="text-[9px] text-zinc-600 block">/ {goals.carbs}g</span></div>
            <div className="w-full h-1 bg-zinc-900 rounded-full overflow-hidden"><div className="h-full bg-blue-500 transition-all" style={{ width: `${cProgress}%` }} /></div>
          </div>
        </div>

        {/* タンパク質バー + PFCフィードバック */}
        {goals.protein > 0 && (
          <div className="space-y-2 pt-1">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-black text-zinc-500 tracking-widest uppercase font-mono">今日のタンパク質</span>
              <span className={`text-[10px] font-mono font-bold ${pProgress >= 70 ? 'text-lime-400' : 'text-zinc-400'}`}>
                {Math.round(todayStats.protein)}g <span className="text-zinc-600">/ {goals.protein}g</span>
              </span>
            </div>
            <div className="w-full h-2 rounded-full overflow-hidden" style={{ backgroundColor: '#3A3A46' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(100, pProgress)}%`,
                  background: 'linear-gradient(to right, #FF2D75, #FF4D8D, #FF6FA8)',
                  boxShadow: '0 0 8px rgba(255, 77, 141, 0.13)',
                }}
              />
            </div>
            <p className="text-xs text-zinc-400 pt-0.5">{pfcFeedback}</p>
          </div>
        )}
      </div>

      {/* 2️⃣ WORKOUT QUICK SUMMARY */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5 shadow-xl flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-lime-400/10 rounded-2xl text-lime-400"><Dumbbell size={22} /></div>
          <div>
            <span className="text-[9px] font-black tracking-widest text-lime-400 uppercase font-mono block">TRAINING TODAY</span>
            <h4 className="font-bold text-white text-sm">{todayWorkout ? `${todayWorkout.exercises.length} 種目のログが記録中` : '今日のトレーニングは未記録'}</h4>
          </div>
        </div>
        <button type="button" onClick={() => setActiveTab('workout')} className="shrink-0 whitespace-nowrap bg-zinc-950 border border-zinc-850 hover:border-zinc-700 text-white font-black px-4 py-3 rounded-xl text-xs uppercase italic tracking-wider leading-none active:scale-95 transition-all" >
          {todayWorkout ? '開く' : '記録開始'}
        </button>
      </div>

      {/* 3️⃣ 5連ミニメーター (💡 UX改善：グラデーション対応版) */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-4 shadow-xl space-y-3">
        <div className="flex items-center gap-1.5">
          <div className="p-1 bg-lime-400/10 rounded-md text-lime-400"><Activity size={14} /></div>
          <span className="text-[10px] font-black tracking-widest text-zinc-400 uppercase font-mono">MUSCLE STATUS</span>
        </div>

        <div className="grid grid-cols-5 gap-1.5">
          {muscleStatuses.map(status => (
            <div 
              key={status.name} 
              className={`bg-zinc-950/80 border rounded-xl p-2 text-center flex flex-col items-center justify-between min-h-[75px] relative overflow-hidden transition-all ${
                status.isTrained 
                  ? status.statusColor === 'rose' 
                    ? 'border-rose-500/40 bg-rose-500/5 shadow-[0_0_15px_rgba(239,68,68,0.1)]' 
                    : status.statusColor === 'amber' // 💡 改善：修復中（オレンジ）のスタイルを追加
                      ? 'border-amber-500/40 bg-amber-500/5 shadow-[0_0_15px_rgba(245,158,11,0.1)]'
                      : 'border-lime-400/40 bg-lime-400/5 shadow-[0_0_15px_rgba(163,230,53,0.1)]'
                  : 'border-zinc-900/60'
              }`}
            >
              <span className={`text-xs font-black font-mono tracking-tight ${status.isTrained ? 'text-white' : 'text-zinc-600'}`}>
                {status.name}
              </span>
              
              <div className="w-full h-1 bg-zinc-900 rounded-full overflow-hidden my-1.5">
                <div 
                  className={`h-full rounded-full transition-all duration-500 ${
                    status.statusColor === 'rose' ? 'bg-rose-500' :
                    status.statusColor === 'amber' ? 'bg-amber-500' : // 💡 改善：バーの色をオレンジに
                    status.statusColor === 'lime' ? 'bg-lime-400 animate-pulse' :
                    status.statusColor === 'emerald' ? 'bg-emerald-500' : 'bg-zinc-800'
                  }`}
                  style={{ width: `${status.progress}%` }}
                />
              </div>
              
              <span className={`text-[9px] font-extrabold tracking-tighter block w-full text-center truncate ${
                status.statusColor === 'rose' ? 'text-rose-400' :
                status.statusColor === 'amber' ? 'text-amber-400' : // 💡 改善：文字の色をオレンジに
                status.statusColor === 'lime' ? 'text-lime-400 font-black' :
                status.statusColor === 'emerald' ? 'text-emerald-400' : 'text-zinc-650'
              }`}>
                {status.statusText}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
