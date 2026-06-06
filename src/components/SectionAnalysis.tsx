import React, { useState } from 'react';
import { 
  TrendingUp, 
  Plus,
  Flame,
  Zap,
  Coffee,
  PieChart
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  AreaChart,
  Area,
  XAxis, 
  YAxis, 
  Tooltip, 
  BarChart, 
  Bar,
  Legend
} from 'recharts';
import { WeightRecord, Meal, Workout } from '../types';

export interface SectionAnalysisProps {
  weightHistory: WeightRecord[];
  meals: Meal[];
  workouts: Workout[];
  addWeight: (weight: number) => void;
  today: string;
  openWeightModal: () => void;
}

type Period = '7' | '30' | 'all';

export function SectionAnalysis({ 
  weightHistory, 
  meals, 
  workouts, 
  addWeight, 
  today,
  openWeightModal
}: SectionAnalysisProps) {
  const [weightPeriod, setWeightPeriod] = useState<Period>('7');
  const [dietPeriod, setDietPeriod] = useState<Period>('7');

  const getWeightDataForChart = () => {
    const sorted = [...weightHistory].sort((a, b) => a.date.localeCompare(b.date));
    const sliced = weightPeriod === '7' 
      ? sorted.slice(-7) 
      : weightPeriod === '30' 
        ? sorted.slice(-30) 
        : sorted;

    return sliced.map(w => ({
      date: w.date.substring(5), // Get MM-DD
      体重: w.weight
    }));
  };

  const getNutritionDataForChart = () => {
    let daysToInclude: string[] = [];

    if (dietPeriod === '7' || dietPeriod === '30') {
      const count = dietPeriod === '7' ? 7 : 30;
      daysToInclude = Array.from({ length: count }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - i);
        return d.toISOString().split('T')[0];
      }).reverse();
    } else {
      const mealDates = meals.map(m => m.date);
      const weightDates = weightHistory.map(w => w.date);
      const workoutDates = workouts.map(wk => wk.date);
      const allDates = Array.from(new Set([...mealDates, ...weightDates, ...workoutDates, today]));
      allDates.sort();
      daysToInclude = allDates;
    }

    return daysToInclude.map(date => {
      const dayMeals = meals.filter(m => m.date === date);
      const totalCal = dayMeals.reduce((acc, m) => acc + m.calories, 0);
      
      const p = dayMeals.reduce((acc, m) => acc + (m.protein || 0), 0);
      const f = dayMeals.reduce((acc, m) => acc + (m.fat || 0), 0);
      const c = dayMeals.reduce((acc, m) => acc + (m.carbs || 0), 0);

      const pKcal = p * 4;
      const fKcal = f * 9;
      const cKcal = c * 4;
      
      const calculatedPfcKcal = pKcal + fKcal + cKcal;
      const otherKcal = Math.max(0, totalCal - calculatedPfcKcal);

      // 💡 改善：すべてのカロリーデータを Math.round で整数化！これで99999999バグを完全抹殺
      // 💡 改善：キー名自体に [kcal] を明記して、グラフの意味を分かりやすくチューニング
      return {
        date: date.substring(5), // Get MM-DD
        'タンパク質 (P) [kcal]': Math.round(pKcal),
        '脂質 (F) [kcal]': Math.round(fKcal),
        '炭水化物 (C) [kcal]': Math.round(cKcal),
        'その他 [kcal]': Math.round(otherKcal),
        合計カロリー: Math.round(totalCal)
      };
    });
  };

  const getAveragePFC = () => {
    let daysToInclude: string[] = [];

    if (dietPeriod === '7' || dietPeriod === '30') {
      const count = dietPeriod === '7' ? 7 : 30;
      daysToInclude = Array.from({ length: count }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - i);
        return d.toISOString().split('T')[0];
      }).reverse();
    } else {
      const mealDates = meals.map(m => m.date);
      const weightDates = weightHistory.map(w => w.date);
      const workoutDates = workouts.map(wk => wk.date);
      const allDates = Array.from(new Set([...mealDates, ...weightDates, ...workoutDates, today]));
      allDates.sort();
      daysToInclude = allDates;
    }

    let totalP = 0;
    let totalF = 0;
    let totalC = 0;
    let totalCal = 0;
    let daysRecordedCount = 0;

    daysToInclude.forEach(date => {
      const dayMeals = meals.filter(m => m.date === date);
      if (dayMeals.length > 0) {
        totalP += dayMeals.reduce((acc, m) => acc + (m.protein || 0), 0);
        totalF += dayMeals.reduce((acc, m) => acc + (m.fat || 0), 0);
        totalC += dayMeals.reduce((acc, m) => acc + (m.carbs || 0), 0);
        totalCal += dayMeals.reduce((acc, m) => acc + m.calories, 0);
        daysRecordedCount++;
      }
    });

    const activeDays = daysRecordedCount || 1;
    const avgP = totalP / activeDays;
    const avgF = totalF / activeDays;
    const avgC = totalC / activeDays;
    const avgCal = totalCal / activeDays;

    const pKcal = avgP * 4;
    const fKcal = avgF * 9;
    const cKcal = avgC * 4;
    const sumPfcKcal = pKcal + fKcal + cKcal;

    let pPct = 0;
    let fPct = 0;
    let cPct = 0;

    if (sumPfcKcal > 0) {
      pPct = (pKcal / sumPfcKcal) * 100;
      fPct = (fKcal / sumPfcKcal) * 100;
      cPct = (cKcal / sumPfcKcal) * 100;
    }

    return {
      avgProtein: avgP,
      avgFat: avgF,
      avgCarbs: avgC,
      avgCalories: avgCal,
      pPct,
      fPct,
      cPct,
      pKcal,
      fKcal,
      cKcal,
      activeDays
    };
  };

  const avgPfc = getAveragePFC();

  const periods: { value: Period; label: string }[] = [
    { value: '7', label: '7日間' },
    { value: '30', label: '30日間' },
    { value: 'all', label: '全期間' }
  ];

  return (
    <div className="space-y-6 pb-24">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold text-white">ANALYTICS</h2>
        <button 
          type="button"
          onClick={openWeightModal}
          className="bg-lime-400 text-black px-4 py-2 rounded-full font-bold text-xs flex items-center gap-1 shadow-lg shadow-lime-400/20 active:scale-95 transition-transform"
        >
          <Plus size={16} /> 体重を記録
        </button>
      </div>

      {/* Weight Chart */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
          <div>
            <span className="text-[10px] font-black tracking-widest text-lime-400 uppercase">WEIGHT MONITOR</span>
            <h3 className="font-bold text-white">体重推移</h3>
          </div>
          <div className="flex items-center justify-between sm:justify-end gap-3">
            <div className="flex bg-zinc-950 p-1 border border-zinc-800 rounded-xl">
              {periods.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setWeightPeriod(p.value)}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                    weightPeriod === p.value
                      ? 'bg-lime-400 text-black'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <TrendingUp className="text-lime-400 hidden sm:block" size={20} />
          </div>
        </div>
        <div className="h-[200px] w-full">
          {weightHistory.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={getWeightDataForChart()}>
                <defs>
                  <linearGradient id="colorWeight" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#d9ff00" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#d9ff00" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" stroke="#52525b" fontSize={10} tickLine={false} />
                <YAxis 
                  stroke="#52525b" 
                  fontSize={10} 
                  domain={([dataMin, dataMax]) => {
                    if (dataMin === undefined || dataMax === undefined) return ['auto', 'auto'];
                    if (dataMin === dataMax || (dataMax - dataMin) < 4) {
                      const center = (dataMin + dataMax) / 2;
                      return [Math.floor(center - 5), Math.ceil(center + 5)];
                    }
                    return [Math.floor(dataMin - 1), Math.ceil(dataMax + 1)];
                  }} 
                  tickLine={false} 
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '12px' }}
                  labelStyle={{ color: '#a1a1aa', fontWeight: 'bold', fontSize: '10px' }}
                  itemStyle={{ color: '#ffffff', fontWeight: 'black' }}
                />
                <Area type="monotone" dataKey="体重" stroke="#d9ff00" strokeWidth={2} fillOpacity={1} fill="url(#colorWeight)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-zinc-650 text-xs italic">
              体重データが存在しません
            </div>
          )}
        </div>
      </div>

      {/* Calories Stacked Chart */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
          <div>
            <span className="text-[10px] font-black tracking-widest text-indigo-400 uppercase">CALORIC & MACROS</span>
            <h3 className="font-bold text-white">カロリー摂取量と内訳 (PFC)</h3>
          </div>
          <div className="flex items-center justify-between sm:justify-end gap-3">
            <div className="flex bg-zinc-950 p-1 border border-zinc-800 rounded-xl">
              {periods.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setDietPeriod(p.value)}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                    dietPeriod === p.value
                      ? 'bg-indigo-500 text-white'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <TrendingUp className="text-indigo-400 hidden sm:block" size={20} />
          </div>
        </div>

        <div className="h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={getNutritionDataForChart()}>
              <XAxis dataKey="date" stroke="#52525b" fontSize={10} tickLine={false} />
              <YAxis stroke="#52525b" fontSize={10} tickLine={false} />
              {/* 💡 改善：formatter を追加して、数値の横に「 kcal」という単位を強制的に自動表示！ */}
              <Tooltip 
                contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '12px' }}
                labelStyle={{ color: '#a1a1aa', fontWeight: 'bold', fontSize: '11px' }}
                itemStyle={{ fontSize: '11px' }}
                formatter={(value) => [`${value} kcal`]}
              />
              <Legend verticalAlign="top" height={36} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '10px', color: '#a1a1aa' }} />
              {/* 💡 改善：データバインド先を新しく設定した [kcal] 付きのキー名に修正 */}
              <Bar dataKey="タンパク質 (P) [kcal]" stackId="a" fill="#f43f5e" />
              <Bar dataKey="脂質 (F) [kcal]" stackId="a" fill="#eab308" />
              <Bar dataKey="炭水化物 (C) [kcal]" stackId="a" fill="#3b82f6" />
              <Bar dataKey="その他 [kcal]" stackId="a" fill="#71717a" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* PFC Average Balance Board */}
        <div className="border-t border-zinc-800/80 pt-6">
          <div className="flex items-center gap-2 mb-4">
            <PieChart className="text-lime-400" size={18} />
            <h4 className="text-sm font-bold text-white">平均PFCバランス ({periods.find(p => p.value === dietPeriod)?.label})</h4>
          </div>

          {avgPfc.avgCalories > 0 ? (
            <div className="space-y-6">
              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-2">
                  <span>摂取エネルギーの構成比 (PFCカロリー比)</span>
                  <span className="font-bold text-white font-mono">{Math.round(avgPfc.avgCalories)} kcal (平均)</span>
                </div>
                <div className="w-full h-4 bg-zinc-950 rounded-full overflow-hidden flex border border-zinc-800">
                  <div 
                    className="h-full bg-rose-500 transition-all" 
                    style={{ width: `${avgPfc.pPct}%` }}
                    title={`Protein: ${avgPfc.pPct.toFixed(1)}%`}
                  />
                  <div 
                    className="h-full bg-amber-500 transition-all" 
                    style={{ width: `${avgPfc.fPct}%` }}
                    title={`Fat: ${avgPfc.fPct.toFixed(1)}%`}
                  />
                  <div 
                    className="h-full bg-blue-500 transition-all" 
                    style={{ width: `${avgPfc.cPct}%` }}
                    title={`Carbs: ${avgPfc.cPct.toFixed(1)}%`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                {/* Protein */}
                <div className="bg-zinc-950/60 border border-zinc-800 p-3 rounded-2xl flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 justify-start">
                      <span className="w-2 h-2 rounded-full bg-rose-500" />
                      <span className="text-[10px] text-zinc-400 font-bold">タンパク質 (P)</span>
                    </div>
                    <div className="text-sm font-black text-white mt-1 font-mono">
                      {avgPfc.avgProtein.toFixed(1)}<span className="text-[10px] text-zinc-400 font-medium ml-0.5">g</span>
                    </div>
                  </div>
                  <div className="mt-2 pt-1 border-t border-zinc-900 flex justify-between items-baseline">
                    <span className="text-[9px] text-zinc-500">比率</span>
                    <span className="text-xs font-bold text-rose-400 font-mono">{avgPfc.pPct.toFixed(0)}%</span>
                  </div>
                </div>

                {/* Fat */}
                <div className="bg-zinc-950/60 border border-zinc-800 p-3 rounded-2xl flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 justify-start">
                      <span className="w-2 h-2 rounded-full bg-amber-500" />
                      <span className="text-[10px] text-zinc-400 font-bold">脂質 (F)</span>
                    </div>
                    <div className="text-sm font-black text-white mt-1 font-mono">
                      {avgPfc.avgFat.toFixed(1)}<span className="text-[10px] text-zinc-400 font-medium ml-0.5">g</span>
                    </div>
                  </div>
                  <div className="mt-2 pt-1 border-t border-zinc-900 flex justify-between items-baseline">
                    <span className="text-[9px] text-zinc-500">比率</span>
                    <span className="text-xs font-bold text-amber-400 font-mono">{avgPfc.fPct.toFixed(0)}%</span>
                  </div>
                </div>

                {/* Carbs */}
                <div className="bg-zinc-950/60 border border-zinc-800 p-3 rounded-2xl flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 justify-start">
                      <span className="w-2 h-2 rounded-full bg-blue-500" />
                      <span className="text-[10px] text-zinc-400 font-bold">炭水化物 (C)</span>
                    </div>
                    <div className="text-sm font-black text-white mt-1 font-mono">
                      {avgPfc.avgCarbs.toFixed(1)}<span className="text-[10px] text-zinc-400 font-medium ml-0.5">g</span>
                    </div>
                  </div>
                  <div className="mt-2 pt-1 border-t border-zinc-900 flex justify-between items-baseline">
                    <span className="text-[9px] text-zinc-500">比率</span>
                    <span className="text-xs font-bold text-blue-400 font-mono">{avgPfc.cPct.toFixed(0)}%</span>
                  </div>
                </div>
              </div>

              <div className="bg-zinc-950 border border-zinc-850 p-4 rounded-2xl text-[11px] text-zinc-400 space-y-1">
                <p className="font-bold text-zinc-300">💡 期間平均アドバイス</p>
                <p>
                  {avgPfc.pPct < 15 ? (
                    <span>筋肉の合成を最大限サポートするため、タンパク質（P）比率をもう少し高める（目標：15%〜25%）ことをお勧めします。鶏胸肉、卵、プロテインの摂取が効果的です。</span>
                  ) : avgPfc.pPct > 30 ? (
                    <span>高タンパク質をしっかりと維持できています！余剰なタンパク質はエネルギーとして代謝されますが、内臓疲労を避けるために適切な水分補給を怠らないでください。</span>
                  ) : (
                    <span>非常に素晴らしい PFC 比率です！タンパク質が理想的なエネルギー比（15%〜28%）をキープできております。この調子で自重・ウェイトトレーニングに励みましょう。</span>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <div className="py-8 bg-zinc-950 border border-zinc-850 text-center text-xs text-zinc-600 rounded-2xl italic">
              食事データを記録すると、この期間の平均 PFC カロリー比率が算出されます。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
