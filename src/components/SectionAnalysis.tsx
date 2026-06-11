import React, { useState, useMemo, useEffect } from 'react';
import { 
  TrendingUp, 
  Plus,
  PieChart,
  Dumbbell,
  Target
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
  const [selExercise, setSelExercise] = useState<string>('');

  // 💡【新設】RM換算表を閉じる・開くをコントロールするスイッチ（初期状態は閉じる）
  const [showRMTable, setShowRMTable] = useState<boolean>(false);

  // 過去のすべての筋トレデータから、登録されている「ユニークな種目名」を全自動でかき集めるマシーン
  const allExerciseNames = useMemo(() => {
    const names = new Set<string>();
    workouts.forEach(w => {
      w.exercises.forEach(e => {
        if (e.name) names.add(e.name);
      });
    });
    return Array.from(names).sort();
  }, [workouts]);

  // 種目リストが切り替わったら、自動的にRM表の開閉を一旦閉じる親切設計
  useEffect(() => {
    if (allExerciseNames.length > 0 && !selExercise) {
      setSelExercise(allExerciseNames[0]);
    }
    setShowRMTable(false);
  }, [allExerciseNames, selExercise]);

  // 選択された種目の「過去のMAX重量」の歴史を、日付の古い順からガチ集計するロジック
  const exerciseChartData = useMemo(() => {
    if (!selExercise) return [];
    const chronoWorkouts = [...workouts].sort((a, b) => a.date.localeCompare(b.date));
    const data: { date: string; '推定1RM': number }[] = [];
    
    chronoWorkouts.forEach(w => {
      const targetEx = w.exercises.find(e => e.name === selExercise);
      if (targetEx && targetEx.sets.length > 0) {
        const maxRM = Math.max(...targetEx.sets.map(s => {
          const wgt = Number(s.weight) || 0;
          const rps = Number(s.reps) || 0;
          if (rps === 0) return wgt;
          return wgt * (1 + rps / 30);
        }));
        
        data.push({
          date: w.date.substring(5).replace('-', '/'),
          '推定1RM': Math.round(maxRM * 10) / 10
        });
      }
    });
    return data;
  }, [workouts, selExercise]);

  // 選択された種目の「最新の推定1RM」を取得し、RM表を動的生成するためのベース値
  const latest1RM = useMemo(() => {
    if (exerciseChartData.length === 0) return 0;
    return exerciseChartData[exerciseChartData.length - 1]['推定1RM'];
  }, [exerciseChartData]);

  // 最新1RMから「何回なら何kg扱えるか」を科学的ベース（Epley逆算）で弾き出すテーブルデータ
  const rmTableRows = useMemo(() => {
    if (latest1RM === 0) return [];
    const repTargets = [1, 3, 5, 8, 10, 12];
    return repTargets.map(reps => {
      const targetWeight = latest1RM / (1 + reps / 30);
      return {
        reps,
        weight: Math.round(targetWeight * 2) / 2 // 0.5kg刻みに美しく丸める
      };
    });
  }, [latest1RM]);

  const getWeightDataForChart = () => {
    const sorted = [...weightHistory].sort((a, b) => a.date.localeCompare(b.date));
    if (weightPeriod === 'all') {
      return sorted.map(w => ( { date: w.date.substring(5).replace('-', '/' ), 体重: w.weight } ));
    }
    const count = weightPeriod === '7' ? 7 : 30;
    const daysToInclude = Array.from({ length: count }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - i);
      return d.toISOString().split('T')[0];
    }).reverse();

    return daysToInclude.map(date => {
      const found = sorted.find(w => w.date === date);
      return {
        date: date.substring(5).replace('-', '/'),
        体重: found ? found.weight : null
      };
    });
  };

  const getNutritionDataForChart = () => {
    let daysToInclude: string[] = [];
    if (dietPeriod === '7' || dietPeriod === '30') {
      const count = dietPeriod === '7' ? 7 : 30;
      daysToInclude = Array.from({ length: count }, (_, i) => {
        const d = new Date(); d.setDate(d.getDate() - i); return d.toISOString().split('T')[0];
      }).reverse();
    } else {
      const mealDates = meals.map(m => m.date); const weightDates = weightHistory.map(w => w.date); const workoutDates = workouts.map(wk => wk.date);
      const allDates = Array.from(new Set([...mealDates, ...weightDates, ...workoutDates, today])); allDates.sort(); daysToInclude = allDates;
    }
    return daysToInclude.map(date => {
      const dayMeals = meals.filter(m => m.date === date); const totalCal = dayMeals.reduce((acc, m) => acc + m.calories, 0);
      const p = dayMeals.reduce((acc, m) => acc + (m.protein || 0), 0); const f = dayMeals.reduce((acc, m) => acc + (m.fat || 0), 0); const c = dayMeals.reduce((acc, m) => acc + (m.carbs || 0), 0);
      const pKcal = p * 4; const fKcal = f * 9; const cKcal = c * 4; const calculatedPfcKcal = pKcal + fKcal + cKcal; const otherKcal = Math.max(0, totalCal - calculatedPfcKcal);
      return {
        date: date.substring(5).replace('-', '/'), 'タンパク質 (P) [kcal]': Math.round(pKcal), '脂質 (F) [kcal]': Math.round(fKcal), '炭水化物 (C) [kcal]': Math.round(cKcal), 'その他 [kcal]': Math.round(otherKcal), 合計カロリー: Math.round(totalCal)
      };
    });
  };

  const getAveragePFC = () => {
    let daysToInclude: string[] = [];
    if (dietPeriod === '7' || dietPeriod === '30') {
      const count = dietPeriod === '7' ? 7 : 30; daysToInclude = Array.from({ length: count }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return d.toISOString().split('T')[0]; }).reverse();
    } else {
      const mealDates = meals.map(m => m.date); const weightDates = weightHistory.map(w => w.date); const workoutDates = workouts.map(wk => wk.date); const allDates = Array.from(new Set([...mealDates, ...weightDates, ...workoutDates, today])); allDates.sort(); daysToInclude = allDates;
    }
    let totalP = 0; let totalF = 0; let totalC = 0; let totalCal = 0; let daysRecordedCount = 0;
    daysToInclude.forEach(date => {
      const dayMeals = meals.filter(m => m.date === date);
      if (dayMeals.length > 0) {
        totalP += dayMeals.reduce((acc, m) => acc + (m.protein || 0), 0); totalF += dayMeals.reduce((acc, m) => acc + (m.fat || 0), 0); totalC += dayMeals.reduce((acc, m) => acc + (m.carbs || 0), 0); totalCal += dayMeals.reduce((acc, m) => acc + m.calories, 0); daysRecordedCount++;
      }
    });
    const activeDays = daysRecordedCount || 1; const avgP = totalP / activeDays; const avgF = totalF / activeDays; const avgC = totalC / activeDays; const avgCal = totalCal / activeDays;
    const pKcal = avgP * 4; const fKcal = avgF * 9; const cKcal = avgC * 4; const sumPfcKcal = pKcal + fKcal + cKcal;
    let pPct = 0; let fPct = 0; let cPct = 0;
    if (sumPfcKcal > 0) { pPct = (pKcal / sumPfcKcal) * 100; fPct = (fKcal / sumPfcKcal) * 100; cPct = (cKcal / sumPfcKcal) * 100; }
    return { avgProtein: avgP, avgFat: avgF, avgCarbs: avgC, avgCalories: avgCal, pPct, fPct, cPct, pKcal, fKcal, cKcal, activeDays };
  };

  const avgPfc = getAveragePFC();
  const periods: { value: Period; label: string }[] = [{ value: '7', label: '7日間' }, { value: '30', label: '30日間' }, { value: 'all', label: '全期間' }];

  return (
    <div className="space-y-6 pb-24">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold text-white">ANALYTICS</h2>
        <button type="button" onClick={openWeightModal} className="bg-lime-400 text-black px-4 py-2 rounded-full font-bold text-xs flex items-center gap-1 shadow-lg shadow-lime-400/20 active:scale-95 transition-transform" ><Plus size={16} /> 体重を記録 </button>
      </div>

      {/* 📊 種目別【推定1RM】推移グラフ ＆ 動的RM表ボード */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl space-y-6">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-lime-400/10 rounded-xl text-lime-400"><Dumbbell size={20} /></div>
            <div>
              <span className="text-[10px] font-black tracking-widest text-lime-400 uppercase font-mono">1RM ESTIMATOR</span>
              <h3 className="font-bold text-white text-base">推定1RMの推移（筋力成長）</h3>
            </div>
          </div>
          
          {allExerciseNames.length > 0 && (
            <div className="w-full sm:w-auto">
              <select value={selExercise} onChange={(e) => setSelExercise(e.target.value)} className="w-full sm:w-auto bg-zinc-950 border border-zinc-850 text-white text-xs font-black rounded-xl px-4 py-2.5 outline-none focus:border-lime-400 transition-colors cursor-pointer appearance-none pr-8 relative bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23a1a1aa%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E')] bg-[length:10px_auto] bg-[right:14px_center] bg-no-repeat" >
                {allExerciseNames.map(name => (<option key={name} value={name} className="bg-zinc-950 text-white font-sans">{name}</option>))}
              </select>
            </div>
          )}
        </div>

        <div className="h-[180px] w-full">
          {allExerciseNames.length === 0 ? (
            <div className="h-full flex items-center justify-center text-zinc-600 text-xs italic bg-zinc-950/30 border border-dashed border-zinc-850 rounded-2xl p-4 text-center">ログタブから筋トレを1セット以上記録すると、<br/>ここに科学的な1RM成長グラフが自動生成されます！🔥</div>
          ) : exerciseChartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-zinc-650 text-xs italic">選択された種目の重量データがまだありません</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={exerciseChartData}>
                <defs>
                  <linearGradient id="colorExercise" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#a3e635" stopOpacity={0.25}/><stop offset="95%" stopColor="#a3e635" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" stroke="#52525b" fontSize={10} tickLine={false} />
                <YAxis stroke="#52525b" fontSize={10} tickLine={false} domain={[(dataMin) => Math.max(0, Math.floor(dataMin - 5)), (dataMax) => Math.ceil(dataMax + 5) ]} />
                <Tooltip contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '12px' }} labelStyle={{ color: '#a1a1aa', fontWeight: 'bold', fontSize: '10px' }} itemStyle={{ color: '#ffffff', fontWeight: 'black' }} formatter={(value) => [`${value} kg`]} />
                <Area type="monotone" dataKey="推定1RM" stroke="#a3e635" strokeWidth={2.5} fillOpacity={1} fill="url(#colorExercise)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* 💡【超絶大改修】ボタンを押したら出現する親切説明付きアコーディオンUI */}
        {latest1RM > 0 && (
          <div className="space-y-2 pt-2">
            <button 
              type="button" 
              onClick={() => setShowRMTable(!showRMTable)}
              className={`w-full p-3.5 rounded-2xl flex items-center justify-between transition-all font-black text-xs uppercase tracking-wider font-mono border ${
                showRMTable 
                  ? 'bg-lime-400 text-black border-lime-400 shadow-[0_0_20px_rgba(163,230,53,0.25)]' 
                  : 'bg-zinc-950 border-zinc-850 text-zinc-300 hover:text-white hover:border-zinc-700'
              }`}
            >
              <div className="flex items-center gap-2">
                <Target size={15} />
                <span>RM換算表（重量設定のカンペ）を{showRMTable ? '閉じる' : '表示する'}</span>
              </div>
              <span className="font-sans text-[10px] font-bold">{showRMTable ? '▲' : '▼'}</span>
            </button>

            {showRMTable && (
              <div className="bg-zinc-950/80 border border-zinc-850 rounded-2xl p-4 space-y-4 animate-in fade-in zoom-in-95 duration-150 shadow-inner">
                {/* 💡【UX特化】一発で何かが分かる説明書のカード */}
                <div className="bg-zinc-900 border border-zinc-800 p-3.5 rounded-xl text-[11px] text-zinc-400 leading-relaxed">
                  <span className="font-black text-lime-400 block mb-1 text-[10px] tracking-widest uppercase font-mono">WHAT IS RM TABLE?</span>
                  あなたの過去最高1RM（1回限界の重さ＝{latest1RM}kg）をベースに、<strong>「何kgなら何回狙えるか」</strong>を科学的に逆算した早見表です。今日のジムで「10回×3セットで追い込もう」と思ったら、表の「10 REPS」の重量に設定すれば、完璧な強度で限界突破（オーバーロード）を狙えます！🔥
                </div>
                
                {/* 換算表の数字グリッド */}
                <div className="grid grid-cols-3 gap-2">
                  {rmTableRows.map(row => (
                    <div key={row.reps} className="bg-zinc-900/60 border border-zinc-800/40 p-2.5 rounded-xl text-center flex flex-col justify-between">
                      <div className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">{row.reps} REPS</div>
                      <div className="text-sm font-black text-white font-mono mt-0.5">{row.weight}<span className="text-[9px] text-zinc-500 font-medium ml-0.5">KG</span></div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Weight Chart */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
          <div><span className="text-[10px] font-black tracking-widest text-lime-400 uppercase">WEIGHT MONITOR</span><h3 className="font-bold text-white">体重推移</h3></div>
          <div className="flex items-center justify-between sm:justify-end gap-3">
            <div className="flex bg-zinc-950 p-1 border border-zinc-800 rounded-xl">
              {periods.map((p) => (<button key={p.value} type="button" onClick={() => setWeightPeriod(p.value)} className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${weightPeriod === p.value ? 'bg-lime-400 text-black' : 'text-zinc-400 hover:text-white' }`} > {p.label} </button> ))}
            </div>
            <TrendingUp className="text-lime-400 hidden sm:block" size={20} />
          </div>
        </div>
        <div className="h-[200px] w-full">
          {weightHistory.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={getWeightDataForChart()}>
                <defs>
                  <linearGradient id="colorWeight" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#d9ff00" stopOpacity={0.2}/><stop offset="95%" stopColor="#d9ff00" stopOpacity={0}/></linearGradient>
                </defs>
                <XAxis dataKey="date" stroke="#52525b" fontSize={10} tickLine={false} />
                <YAxis stroke="#52525b" fontSize={10} domain={([dataMin, dataMax]: [number, number]): [number, number] => {if (dataMin === dataMax || (dataMax - dataMin) < 4) {const center = (dataMin + dataMax) / 2; return [Math.floor(center - 5), Math.ceil(center + 5)]; } return [Math.floor(dataMin - 1), Math.ceil(dataMax + 1)]; }} tickLine={false} />
                <Tooltip contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '12px' }} labelStyle={{ color: '#a1a1aa', fontWeight: 'bold', fontSize: '10px' }} itemStyle={{ color: '#ffffff', fontWeight: 'black' }} />
                <Area type="monotone" dataKey="体重" stroke="#d9ff00" strokeWidth={2} fillOpacity={1} fill="url(#colorWeight)" connectNulls={true} dot={{ fill: '#d9ff00', r: 3.5, strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (<div className="h-full flex items-center justify-center text-zinc-650 text-xs italic"> 体重データが存在しません </div> )}
        </div>
      </div>

      {/* Calories Stacked Chart */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
          <div><span className="text-[10px] font-black tracking-widest text-indigo-400 uppercase">CALORIC & MACROS</span><h3 className="font-bold text-white">カロリー摂取量と内訳 (PFC)</h3></div>
          <div className="flex items-center justify-between sm:justify-end gap-3">
            <div className="flex bg-zinc-950 p-1 border border-zinc-800 rounded-xl">
              {periods.map((p) => (<button key={p.value} type="button" onClick={() => setDietPeriod(p.value)} className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${dietPeriod === p.value ? 'bg-indigo-500 text-white' : 'text-zinc-400 hover:text-white' }`} > {p.label} </button> ))}
            </div>
            <TrendingUp className="text-indigo-400 hidden sm:block" size={20} />
          </div>
        </div>
        <div className="h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={getNutritionDataForChart()}>
              <XAxis dataKey="date" stroke="#52525b" fontSize={10} tickLine={false} />
              <YAxis stroke="#52525b" fontSize={10} tickLine={false} />
              <Tooltip contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '12px' }} labelStyle={{ color: '#a1a1aa', fontWeight: 'bold', fontSize: '11px' }} itemStyle={{ fontSize: '11px' }} formatter={(value) => [ ` ${ value } kcal` ]} />
              <Legend verticalAlign="top" height={36} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '10px', color: '#a1a1aa' }} />
              <Bar dataKey="タンパク質 (P) [kcal]" stackId="a" fill="#f43f5e" />
              <Bar dataKey="脂質 (F) [kcal]" stackId="a" fill="#eab308" />
              <Bar dataKey="炭水化物 (C) [kcal]" stackId="a" fill="#3b82f6" />
              <Bar dataKey="その他 [kcal]" stackId="a" fill="#71717a" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* PFC Average Balance Board */}
        <div className="border-t border-zinc-800/80 pt-6">
          <div className="flex items-center gap-2 mb-4"><PieChart className="text-lime-400" size={18} /><h4 className="text-sm font-bold text-white">平均PFCバランス ({periods.find(p => p.value === dietPeriod)?.label})</h4></div>
          {avgPfc.avgCalories > 0 ? (
            <div className="space-y-6">
              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-2"><span>摂取エネルギーの構成比 (PFCカロリー比)</span><span className="font-bold text-white font-mono">{Math.round(avgPfc.avgCalories)} kcal (平均)</span></div>
                <div className="w-full h-4 bg-zinc-950 rounded-full overflow-hidden flex border border-zinc-800">
                  <div className="h-full bg-rose-500 transition-all" style={{ width: `${avgPfc.pPct}%` }} title={`Protein: ${avgPfc.pPct.toFixed(1)}%`} /><div className="h-full bg-amber-500 transition-all" style={{ width: `${avgPfc.fPct}%` }} title={`Fat: ${avgPfc.fPct.toFixed(1)}%`} /><div className="h-full bg-blue-500 transition-all" style={{ width: `${avgPfc.cPct}%` }} title={`Carbs: ${avgPfc.cPct.toFixed(1)}%`} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-zinc-950/60 border border-zinc-800 p-3 rounded-2xl flex flex-col justify-between">
                  <div><div className="flex items-center gap-1.5 justify-start"><span className="w-2 h-2 rounded-full bg-rose-500" /><span className="text-[10px] text-zinc-400 font-bold">タンパク質 (P)</span></div><div className="text-sm font-black text-white mt-1 font-mono">{avgPfc.avgProtein.toFixed(1)}<span className="text-[10px] text-zinc-400 font-medium ml-0.5">g</span></div></div>
                  <div className="mt-2 pt-1 border-t border-zinc-900 flex justify-between items-baseline"><span className="text-[9px] text-zinc-500">比率</span><span className="text-xs font-bold text-rose-400 font-mono">{avgPfc.pPct.toFixed(0)}%</span></div>
                </div>
                <div className="bg-zinc-950/60 border border-zinc-800 p-3 rounded-2xl flex flex-col justify-between">
                  <div><div className="flex items-center gap-1.5 justify-start"><span className="w-2 h-2 rounded-full bg-amber-500" /><span className="text-[10px] text-zinc-400 font-bold">脂質 (F)</span></div><div className="text-sm font-black text-white mt-1 font-mono">{avgPfc.avgFat.toFixed(1)}<span className="text-[10px] text-zinc-400 font-medium ml-0.5">g</span></div></div>
                  <div className="mt-2 pt-1 border-t border-zinc-900 flex justify-between items-baseline"><span className="text-[9px] text-zinc-500">比率</span><span className="text-xs font-bold text-amber-400 font-mono">{avgPfc.fPct.toFixed(0)}%</span></div>
                </div>
                <div className="bg-zinc-950/60 border border-zinc-800 p-3 rounded-2xl flex flex-col justify-between">
                  <div><div className="flex items-center gap-1.5 justify-start"><span className="w-2 h-2 rounded-full bg-blue-500" /><span className="text-[10px] text-zinc-400 font-bold">炭水化物 (C)</span></div><div className="text-sm font-black text-white mt-1 font-mono">{avgPfc.avgCarbs.toFixed(1)}<span className="text-[10px] text-zinc-400 font-medium ml-0.5">g</span></div></div>
                  <div className="mt-2 pt-1 border-t border-zinc-900 flex justify-between items-baseline"><span className="text-[9px] text-zinc-500">比率</span><span className="text-xs font-bold text-blue-400 font-mono">{avgPfc.cPct.toFixed(0)}%</span></div>
                </div>
              </div>
              <div className="bg-zinc-950 border border-zinc-850 p-4 rounded-2xl text-[11px] text-zinc-400 space-y-1">
                <p className="font-bold text-zinc-300">💡 期間平均アドバイス</p>
                <p>{avgPfc.pPct < 15 ? (<span>筋肉の合成を最大限サポートするため、タンパク質（P）比率をもう少し高める（目標：15%〜25%）ことをお勧めします。鶏胸肉、卵、プロテインの摂取が効果的です。</span> ) : avgPfc.pPct > 30 ? (<span>高タンパク質をしっかりと維持できています！余剰なタンパク質化はエネルギーとして代謝されますが、内臓疲労を避けるために適切な水分補給を怠らないでください。</span> ) : (<span>非常に素晴らしい PFC 比率です！タンパク質が理想的なエネルギー比（15%〜28%）をキープできております。この調子で自重・ウェイトトレーニングに励みましょう。</span> )}</p>
              </div>
            </div>
          ) : (<div className="py-8 bg-zinc-950 border border-zinc-850 text-center text-xs text-zinc-600 rounded-2xl italic">食事データを記録すると、この期間の平均 PFC カロリー比率が算出されます。</div> )}
        </div>
      </div>
    </div>
  );
}
