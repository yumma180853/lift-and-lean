import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Activity, Utensils, BarChart3, Settings, Dumbbell, Sparkles, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import { UserGoals, WeightRecord, Workout, Meal, ChatMessage, Tab, StreakData } from './types';
import { SectionDashboard } from './components/SectionDashboard';
import { SectionWorkout } from './components/SectionWorkout';
import { SectionDiet } from './components/SectionDiet';
import { SectionAnalysis } from './components/SectionAnalysis';
import { SectionAITrainer } from './components/SectionAITrainer';
import { SectionSettings } from './components/SectionSettings';

const safeUUID = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
const DF_G: UserGoals = { calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 70 };

// --- Streak helpers ---
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}
function computeStreak(meals: Meal[], today: string, prevFreeze: string[], prevLongest: number): StreakData {
  const mealDates = new Set(meals.map(m => m.date));
  const todayMon = weekMonday(today);
  const newFreeze = [...prevFreeze];
  const todayHasMeal = mealDates.has(today);
  let streak = 0;
  let usedNewFreeze = false;
  let cursor = todayHasMeal ? today : addDays(today, -1);
  for (let i = 0; i < 400; i++) {
    if (mealDates.has(cursor)) {
      streak++;
      cursor = addDays(cursor, -1);
    } else if (newFreeze.includes(cursor)) {
      // previously frozen day — counts toward streak continuity
      streak++;
      cursor = addDays(cursor, -1);
    } else {
      // gap — try to apply new freeze (1-day gap, weekly quota not exhausted)
      const freezesThisWeek = newFreeze.filter(d => weekMonday(d) === todayMon).length;
      const next = addDays(cursor, -1);
      if (!usedNewFreeze && freezesThisWeek < 1 && streak > 0 && mealDates.has(next)) {
        usedNewFreeze = true;
        newFreeze.push(cursor);
        streak++;
        cursor = next;
      } else {
        break;
      }
    }
  }
  let status: StreakData['status'] = 'new';
  if (streak > 0) {
    if (todayHasMeal) status = usedNewFreeze ? 'freeze_used' : 'active';
    else status = 'ongoing';
  }
  return {
    currentStreak: streak,
    lastRecordedDate: todayHasMeal ? today : (streak > 0 ? addDays(today, -1) : ''),
    freezeUsedDates: newFreeze,
    longestStreak: Math.max(prevLongest, streak),
    status,
  };
}
// --- End Streak helpers ---

const EXERCISE_TO_CATEGORY: Record<string, string> = {
  'ベンチプレス': '胸', 'インクラインダンベルプレス': '胸', 'チェストプレスマシン': '胸', 'ペックフライ': '胸',
  'チンニング': '背中', 'ラットプルダウン': '背中', 'デッドリフト': '背中', 'シーテッドロー': '背中',
  'ショルダープレス': '肩', 'ミリタリープレス': '肩', 'サイドレイズ': '肩', 'リアレイズ': '肩',
  'アームカール': '腕', 'プッシュダウン': '腕', 'スカルクラッシャー': '腕',
  'スクワット': '脚', 'レッグプレス': '脚', 'レッグエクステンション': '脚',
  'クランチ': '腹筋', 'レッグレイズ': '腹筋', 'プランク': '腹筋', 'アブローラー': '腹筋', 'ケーブルクランチ': '腹筋'
};

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [weights, setWeights] = useState<WeightRecord[]>([]);
  const [goals, setGoals] = useState<UserGoals>(DF_G);
  const [remind, setRemind] = useState(false);
  const [chats, setChats] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openW, setOpenW] = useState(false);
  const [wVal, setWVal] = useState('');
  const [sending, setSending] = useState(false);
  const [selDate, setSelDate] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [cYear, setCYear] = useState(new Date().getFullYear());
  const [cMonth, setCMonth] = useState(new Date().getMonth());
  const [hiddenDates, setHiddenDates] = useState<string[]>([]);
  const [selFilter, setSelFilter] = useState<string>('すべて');
  const [customCats, setCustomCats] = useState<Record<string, string>>({});
  const [freezeUsedDates, setFreezeUsedDates] = useState<string[]>([]);
  const [longestStreak, setLongestStreak] = useState<number>(0);

  useEffect(() => {
    try {
      const w = localStorage.getItem('workouts'), m = localStorage.getItem('meals'), wg = localStorage.getItem('weight_history'), g = localStorage.getItem('user_goals'), r = localStorage.getItem('reminders_enabled'), c = localStorage.getItem('chat_messages');
      if (w) setWorkouts(JSON.parse(w));
      if (m) setMeals(JSON.parse(m));
      if (wg) setWeights(JSON.parse(wg));
      if (g) setGoals({ ...DF_G, ...JSON.parse(g) });
      if (r) setRemind(JSON.parse(r));
      if (c) setChats(JSON.parse(c));

      const hd = localStorage.getItem('hidden_workout_dates');
      if (hd) setHiddenDates(JSON.parse(hd));

      const cc = localStorage.getItem('custom_exercise_categories');
      if (cc) setCustomCats(JSON.parse(cc));

      const fd = localStorage.getItem('freeze_used_dates');
      if (fd) setFreezeUsedDates(JSON.parse(fd));
      const ls = localStorage.getItem('longest_streak');
      if (ls) setLongestStreak(JSON.parse(ls));
    } catch (e) { console.error(e); }
    setLoaded(true);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(e => console.error(e));
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem('workouts', JSON.stringify(workouts));
      localStorage.setItem('meals', JSON.stringify(meals));
      localStorage.setItem('weight_history', JSON.stringify(weights));
      localStorage.setItem('user_goals', JSON.stringify(goals));
      localStorage.setItem('reminders_enabled', JSON.stringify(remind));
      // チャット画像（Base64）はlocalStorage容量を圧迫するため保存しない
      const chatsForStorage = chats.map(({ images: _images, ...rest }) => rest);
      localStorage.setItem('chat_messages', JSON.stringify(chatsForStorage));
      localStorage.setItem('hidden_workout_dates', JSON.stringify(hiddenDates));
      localStorage.setItem('custom_exercise_categories', JSON.stringify(customCats));
      localStorage.setItem('freeze_used_dates', JSON.stringify(freezeUsedDates));
      localStorage.setItem('longest_streak', JSON.stringify(longestStreak));
    } catch (e) { console.warn(e); }
  }, [workouts, meals, weights, goals, remind, chats, loaded, hiddenDates, customCats, freezeUsedDates, longestStreak]);

  useEffect(() => {
    setWorkouts(p => p.filter(w => w.exercises.length > 0));
    setSelDate(null);
    setSelFilter('すべて');
  }, [tab]);

  const sortedWorkouts = useMemo(() => {
    return [...workouts].sort((a, b) => b.date.localeCompare(a.date));
  }, [workouts]);

  const allExerciseCategories = useMemo(() => {
    return { ...EXERCISE_TO_CATEGORY, ...customCats };
  }, [customCats]);

  const filteredWorkouts = useMemo(() => {
    const basicList = sortedWorkouts.filter(w => w.exercises.length > 0 && !hiddenDates.includes(w.date));
    if (selFilter === 'すべて') return basicList;
    return basicList.filter(w => 
      w.exercises.some(e => allExerciseCategories[e.name] === selFilter)
    );
  }, [sortedWorkouts, hiddenDates, selFilter, allExerciseCategories]);

  const calendarDays = useMemo(() => {
    const startDayOfWeek = new Date(cYear, cMonth, 1).getDay();
    const totalDays = new Date(cYear, cMonth + 1, 0).getDate();
    const days = [];
    for (let i = 0; i < startDayOfWeek; i++) days.push(null);
    for (let i = 1; i <= totalDays; i++) days.push(i);
    return days;
  }, [cYear, cMonth]);

  const prevMonth = () => {
    if (cMonth === 0) { setCMonth(11); setCYear(cYear - 1); } else { setCMonth(cMonth - 1); }
  };
  const nextMonth = () => {
    if (cMonth === 11) { setCMonth(0); setCYear(cYear + 1); } else { setCMonth(cMonth + 1); }
  };

  const handleCloseWorkoutDetail = () => {
    setWorkouts(p => p.filter(w => w.exercises.length > 0));
    setSelDate(null);
  };

  const toggleNotify = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      alert('プッシュ通知はPWAモード（ホーム画面に追加）でのみ利用できます。');
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      if (remind) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch('/api/send-test-notification', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub, action: 'unsubscribe' }) });
          await sub.unsubscribe();
        }
        await fetch('/api/delete-subscription', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        setRemind(false);
        alert('リマインダー通知をオフにしました。');
      } else {
        const p = await Notification.requestPermission();
        if (p === 'denied') { alert('通知がブロックされています。iOSの「設定」→「通知」からアプリの通知を許可してください。'); return; }
        if (p !== 'granted') { alert('通知の許可が必要です。'); return; }
        const keyRes = await fetch('/api/wp-public-key');
        if (!keyRes.ok) { alert('通知サーバーへの接続に失敗しました。時間をおいて再度お試しください。'); return; }
        const { publicKey } = await keyRes.json();
        if (!publicKey || typeof publicKey !== 'string') { alert('通知キーの取得に失敗しました。'); return; }
        const convertedKey = urlBase64ToUint8Array(publicKey);
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: convertedKey });
        setRemind(true);
        await fetch('/api/save-subscription', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
        await fetch('/api/send-test-notification', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
        alert('リマインダー通知をオンにしました！毎朝7時にお知らせします。');
      }
    } catch (e) {
      console.error('通知設定エラー:', e);
      alert('通知の設定に失敗しました。時間をおいて再度お試しください。');
    }
  };

  const handleSendMessage = async (text: string, images: string[]) => {
    if (!text.trim() && images.length === 0) return;
    const userMsg: ChatMessage = { id: safeUUID(), role: 'user', text, images, timestamp: new Date().toISOString() }; setChats(prev => [...prev, userMsg]); setSending(true);
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const history = chats.slice(-10).map(m => ({
        role: m.role,
        text: (m.images && m.images.length > 0)
          ? `[画像を送信]${m.text ? ' ' + m.text : ''}`
          : m.text,
      }));
      const response = await fetch('/api/chat-trainer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ message: text, images, history, workouts: tWorkout ? [tWorkout] : [], meals: tMeals, userData: { weight: cWeight || 0, targetWeight: goals.targetWeight, calories: goals.calories, protein: goals.protein, fat: goals.fat, carbs: goals.carbs, trainerStyle: goals.trainerStyle || 'buddy' } }) });
      const data = await response.json(); setChats(prev => [...prev, { id: safeUUID(), role: 'assistant', text: data?.text || 'エラーが発生しました。', exercises: Array.isArray(data?.exercises) ? data.exercises : [], timestamp: new Date().toISOString() }]);
    } catch (error: any) { if (error.name !== 'AbortError') alert('AIとの通信に失敗しました。'); } finally { setSending(false); abortRef.current = null; }
  };

  const today = format(new Date(), 'yyyy-MM-dd');
  const tMeals = useMemo(() => meals.filter(m => m.date === today), [meals, today]);

  const streakData = useMemo(
    () => computeStreak(meals, today, freezeUsedDates, longestStreak),
    [meals, today, freezeUsedDates, longestStreak]
  );
  useEffect(() => {
    if (!loaded) return;
    if (streakData.freezeUsedDates.length !== freezeUsedDates.length) {
      setFreezeUsedDates(streakData.freezeUsedDates);
    }
    if (streakData.currentStreak > longestStreak) {
      setLongestStreak(streakData.currentStreak);
    }
  }, [streakData.currentStreak, streakData.freezeUsedDates.length, loaded]);
  const tStats = useMemo(() => tMeals.reduce((acc, m) => ({ calories: acc.calories + (Number(m.calories) || 0), protein: acc.protein + (Number(m.protein) || 0), fat: acc.fat + (Number(m.fat) || 0), carbs: acc.carbs + (Number(m.carbs) || 0) }), { calories: 0, protein: 0, fat: 0, carbs: 0 }), [tMeals]);
  const tWorkout = useMemo(() => workouts.find(w => w.date === today), [workouts, today]);
  const cWeight = useMemo(() => weights.length ? weights[weights.length - 1].weight : null, [weights]);

  const addWorkout = () => {
    if (tWorkout) return alert("記録済です"); setWorkouts([...workouts, { id: safeUUID(), date: today, exercises: [] }]); setTab('workout');
  };
  const addWeight = (w: number) => {
    const r = { id: safeUUID(), date: today, weight: w }, i = weights.findIndex(x => x.date === today);
    if (i > -1) { const u = [...weights]; u[i] = r; setWeights(u); } else { setWeights([...weights, r]); }
    fetch('/api/save-weight-date', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: today }) }).catch(() => {});
  };

  return (
    <div className="min-h-dvh bg-black text-zinc-100 font-sans selection:bg-lime-400 selection:text-black">
      <div className="max-w-md mx-auto min-h-dvh flex flex-col relative px-5 bg-[#0a0a0a]" style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))' }}>
        <main className="flex-1">
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.2 }} >
              {/* 💡 改善：SectionDashboard に workouts と meals を丸ごと引き渡し、タイムラグ計算を可能にする！ */}
              {tab === 'dashboard' && <SectionDashboard todayStats={tStats} goals={goals} weightHistory={weights} today={today} todayWorkout={tWorkout} todayMeals={tMeals} currentWeight={cWeight} addWeight={addWeight} setActiveTab={setTab} openWeightModal={() => setOpenW(true)} workouts={workouts} meals={meals} streakData={streakData} />}
              {tab === 'workout' && (selDate === null ? (
                <div className="space-y-4 pb-24">
                  <div className="flex items-center gap-2 text-lime-400 font-black italic text-xl uppercase tracking-wider mb-2"><Dumbbell size={24} /> <span>TRAINING LOGS</span></div>
                  <div className="ll-card p-4 space-y-3">
                    <div className="flex justify-between items-center px-1">
                      <div className="text-xs font-black text-white font-mono uppercase tracking-wider">{cYear}年 {cMonth + 1}月 のスタンプ</div>
                      <div className="flex gap-1.5">
                        <button onClick={prevMonth} className="w-7 h-7 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors text-xs font-black flex items-center justify-center active:scale-95" type="button">←</button>
                        <button onClick={nextMonth} className="w-7 h-7 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors text-xs font-black flex items-center justify-center active:scale-95" type="button">→</button>
                      </div>
                    </div>
                    <div className="grid grid-cols-7 gap-1 text-center text-[9px] font-black text-zinc-500 uppercase tracking-widest pb-1 border-b border-zinc-800/40"><div className="text-rose-500/80">日</div><div>月</div><div>火</div><div>水</div><div>木</div><div>金</div><div className="text-blue-500/80">土</div></div>
                    <div className="grid grid-cols-7 gap-1">
                      {calendarDays.map((day, idx) => {
                        if (!day) return <div key={`empty-${idx}`} className="h-8" />;
                        const dateStr = `${cYear}-${String(cMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                        const targetWorkout = workouts.find(w => w.date === dateStr); const hasWorkout = targetWorkout && targetWorkout.exercises.length > 0; const isToday = dateStr === today;
                        return (
                          <button key={`day-${day}`} onClick={() => { const hasData = workouts.some(w => w.date === dateStr); if (!hasData) { setWorkouts([...workouts, { id: safeUUID(), date: dateStr, exercises: [] }]); } setHiddenDates(p => p.filter(d => d !== dateStr)); setSelDate(dateStr); }} className={`h-8 rounded-xl flex flex-col items-center justify-center relative text-xs font-mono font-bold transition-all active:scale-90 ${hasWorkout ? 'bg-lime-400 text-black font-black shadow-[0_0_15px_rgba(163,230,53,0.3)] border border-lime-400' : isToday ? 'border-2 border-lime-400 text-lime-400 font-black bg-lime-400/5 animate-pulse' : 'bg-zinc-950 border border-zinc-900 text-zinc-450 hover:border-zinc-700 hover:text-white'}`} type="button"><span>{day}</span></button>
                        );
                      })}
                    </div>
                  </div>
                  <button onClick={() => { const hasToday = workouts.some(w => w.date === today); if (!hasToday) { setWorkouts([...workouts, { id: safeUUID(), date: today, exercises: [] }]); } setSelDate(today); }} className="w-full bg-lime-400 text-black p-4 rounded-2xl font-black text-sm uppercase italic tracking-wider flex items-center justify-center gap-2 active:scale-95 transition-all shadow-[0_0_20px_rgba(163,230,53,0.15)]" ><Sparkles size={18} /> {workouts.some(w => w.date === today) ? "今日のトレーニングを表示・編集" : "今日のトレーニング記録を開始する"}</button>
                  <div className="pt-2">
                    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
                      {['すべて', '胸', '背中', '肩', '腕', '脚', '腹筋'].map(cat => (
                        <button key={cat} type="button" onClick={() => setSelFilter(cat)} className={`px-4 py-2 rounded-xl text-xs font-black tracking-wider transition-all whitespace-nowrap active:scale-95 ${selFilter === cat ? 'bg-lime-400 text-black shadow-md shadow-lime-400/10' : 'bg-zinc-900 border border-zinc-850 text-zinc-400 hover:text-white'}`} >{cat} {selFilter === cat && '✓'}</button>
                      ))}
                    </div>
                  </div>
                  <div className="text-xs font-bold text-zinc-500 uppercase tracking-wider pt-2 flex justify-between"><span>筋トレ履歴 {selFilter !== 'すべて' && <span className="text-lime-400 font-mono">({selFilter}のみ)</span>}</span><span className="font-mono text-[10px] text-zinc-600">{filteredWorkouts.length}件</span></div>
                  {filteredWorkouts.length === 0 ? (<div className="text-center py-12 bg-zinc-950 border border-zinc-900 rounded-3xl text-zinc-500 text-xs">{selFilter === 'すべて' ? 'トレーニングの記録がまだありません。' : `${selFilter}のトレーニング記録はありません。`}</div>) : (
                    <div className="space-y-3">
                      {filteredWorkouts.map(w => {
                        const totalSets = w.exercises.reduce((sum, e) => sum + e.sets.length, 0);
                        return (
                          <div key={w.id} onClick={() => setSelDate(w.date)} className="ll-card p-4 flex items-center justify-between hover:border-zinc-700 active:bg-zinc-900/50 transition-all cursor-pointer group" >
                            <div className="space-y-1 max-w-[65%]"><div className="text-sm font-mono font-bold text-white flex items-center gap-2">{w.date.replace(/-/g, '/')} {w.date === today && <span className="inline-flex items-center leading-none whitespace-nowrap text-[10px] bg-lime-400 text-black px-1.5 py-0.5 rounded font-sans font-black">TODAY</span>}</div><div className="text-xs text-zinc-400 truncate">{w.exercises.map(e => e.name).join(', ')}</div></div>
                            <div className="flex items-center gap-3 shrink-0"><div className="text-right"><span className="inline-flex items-center leading-none whitespace-nowrap text-[10px] font-mono font-bold text-lime-400 bg-lime-400/10 border border-lime-400/20 px-2 py-1 rounded-lg">{w.exercises.length}種目 / {totalSets}SET</span></div><button type="button" onClick={(e) => { e.stopPropagation(); if (confirm(`${w.date.replace(/-/g, '/')} の履歴を一覧から非表示にしますか？\n（カレンダーや分析グラフの記録はそのまま残ります）`)) { setHiddenDates(p => [...p, w.date]); } }} className="p-2 text-zinc-600 hover:text-rose-500 hover:bg-rose-900 rounded-xl transition-colors" ><Trash2 size={15} /></button></div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <SectionWorkout
                    todayWorkout={workouts.find(w => w.date === selDate)} workouts={workouts} today={selDate} setActiveTab={handleCloseWorkoutDetail} addWorkout={addWorkout} currentWeight={cWeight}
                    addExercise={(wid, n, cat) => {
                      if (cat) { setCustomCats(p => ({ ...p, [n]: cat })); }
                      setWorkouts(p => p.map(w => w.id !== wid ? w : { ...w, exercises: [...w.exercises, { id: safeUUID(), name: n, sets: [] }] }));
                    }} 
                    addSet={(wid, eid, w: any, r: any) => setWorkouts(p => p.map(x => x.id !== wid ? x : { ...x, exercises: x.exercises.map(e => e.id !== eid ? e : { ...e, sets: [...e.sets, { id: safeUUID(), weight: w, reps: r }] }) }))} deleteExercise={(wid, eid) => setWorkouts(p => p.map(w => w.id !== wid ? w : { ...w, exercises: w.exercises.filter(e => e.id !== eid) }))} deleteSet={(wid, eid, sid) => setWorkouts(p => p.map(w => w.id !== wid ? w : { ...w, exercises: w.exercises.map(e => e.id !== eid ? e : { ...e, sets: e.sets.filter(s => s.id !== sid) }) }))} updateSet={(wid, eid, sid, w: any, r: any) => setWorkouts(p => p.map(x => x.id !== wid ? x : { ...x, exercises: x.exercises.map(e => e.id !== eid ? e : { ...e, sets: e.sets.map(s => s.id !== sid ? s : { ...s, weight: w, reps: r }) }) }))} />
                </div>
              ))}
              {tab === 'diet' && <SectionDiet todayMeals={tMeals} allMeals={meals} addMeal={(m) => setMeals([...meals, { ...m, id: safeUUID(), date: today }])} updateMeal={(id, patch) => setMeals(p => p.map(x => x.id === id ? { ...x, ...patch } : x))} deleteMeal={(id) => setMeals(p => p.filter(x => x.id !== id))} goals={goals} />}
              {tab === 'analysis' && <SectionAnalysis weightHistory={weights} meals={meals} workouts={workouts} addWeight={addWeight} today={today} openWeightModal={() => setOpenW(true)} goals={goals} />}
              {tab === 'aitrainer' && <SectionAITrainer chatMessages={chats} setChatMessages={setChats} currentWeight={cWeight} goals={goals} today={today} todayWorkout={tWorkout} setWorkouts={setWorkouts} setActiveTab={setTab} isSending={sending} handleSendMessage={handleSendMessage} handleCancelMessage={() => abortRef.current?.abort()} />}
              {tab === 'settings' && <SectionSettings goals={goals} setGoals={setGoals} remind={remind} toggleNotification={toggleNotify} />}
            </motion.div>
          </AnimatePresence>
        </main>
        <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-zinc-950/90 backdrop-blur-xl border-t border-zinc-800 px-3 py-2 flex items-center justify-between z-50" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
          {([
            { id: 'dashboard',  Icon: Activity,  label: 'ホーム' },
            { id: 'workout',    Icon: Dumbbell,  label: 'ログ' },
            { id: 'diet',       Icon: Utensils,  label: '食事' },
            { id: 'aitrainer',  Icon: Sparkles,  label: 'AI' },
            { id: 'analysis',   Icon: BarChart3, label: '分析' },
            { id: 'settings',   Icon: Settings,  label: '設定' },
          ] as const).map(({ id, Icon, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex flex-col items-center gap-0.5 rounded-xl px-2.5 py-1.5 transition-all active:scale-95 ${
                tab === id
                  ? 'text-lime-400 bg-lime-400/10 border border-lime-400/20'
                  : 'text-zinc-600 border border-transparent'
              }`}
            >
              <Icon size={22} />
              <span className="text-[9px] font-bold">{label}</span>
            </button>
          ))}
        </nav>
      </div>
      <AnimatePresence>
        {openW && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div onClick={() => setOpenW(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.95, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 20 }} className="relative w-full max-w-sm bg-zinc-950 border border-zinc-900 rounded-3xl p-6 z-10" >
              <div className="text-center space-y-4">
                <div className="mx-auto w-12 h-12 bg-lime-400/10 rounded-full flex items-center justify-center text-lime-400"><Activity size={24} /></div>
                <div><h2 className="text-lg font-bold text-white uppercase italic">MEASURE WEIGHT</h2><p className="text-xs text-zinc-500 mt-1">本日の体重(kg)を測定して記録</p></div>
                <form onSubmit={(e) => { e.preventDefault(); const w = parseFloat(wVal); if (w && !isNaN(w)) { addWeight(w); setOpenW(false); setWVal(''); } }} className="space-y-4 pt-2">
                  <div className="relative">
                    <input type="number" step="0.1" required placeholder="0.0" value={wVal === '0' || wVal === '0.0' ? '' : wVal} onChange={(e) => setWVal(e.target.value)} className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-center text-3xl font-black text-lime-400 outline-none" autoFocus /><span className="absolute right-4 bottom-4 text-xs font-mono text-zinc-500">KG</span>
                  </div>
                  <div className="flex gap-2"><button type="submit" className="flex-1 bg-lime-400 text-black py-3 rounded-xl font-bold text-xs" > 記録する </button><button type="button" onClick={() => setOpenW(false)} className="flex-1 bg-zinc-900 text-zinc-450 hover:text-white border border-zinc-900 py-3 rounded-xl font-bold text-xs" > キャンセル </button></div>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <style>{`body { font-family: 'Inter', system-ui, sans-serif; } ::-webkit-scrollbar { display: none; } input[type='number']::-webkit-inner-spin-button, input[type='number']::-webkit-outer-spin-button {-webkit-appearance: none; margin: 0; }`}</style>
    </div>
  );
}
