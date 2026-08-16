import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Activity, Utensils, BarChart3, Settings, Dumbbell, Sparkles, Trash2, Mic } from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import { Meal, ChatMessage, Tab, StreakData } from './types';
import { SectionDashboard } from './components/SectionDashboard';
import { SectionWorkout } from './components/SectionWorkout';
import { SectionDiet } from './components/SectionDiet';
import { SectionAnalysis } from './components/SectionAnalysis';
import { SectionAITrainer } from './components/SectionAITrainer';
import { SectionSettings } from './components/SectionSettings';
import { SyncStatus } from './components/SyncStatus';
import { VoiceCommand } from './components/VoiceCommand';
import { useAppData } from './data/useAppData';

const safeUUID = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

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
  const [dietEditOpen, setDietEditOpen] = useState(false);
  // 話して記録する入口。どの画面からでも1タップで開ける
  const [voiceOpen, setVoiceOpen] = useState(false);
  // 食事ログで表示中の日付。タブを離れたら今日に戻し「昨日のつもりで今日に記録」の事故を防ぐ
  const [dietDate, setDietDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  useEffect(() => {
    if (tab !== 'diet') setDietDate(format(new Date(), 'yyyy-MM-dd'));
  }, [tab]);
  // 永続データの保存先はここが決める（ログイン＋メール確認済みならクラウドが正本）
  const store = useAppData();
  const { meals, workouts, weights, goals, hiddenWorkoutDates: hiddenDates, customExerciseCategories: customCats,
    freezeUsedDates, longestStreak } = store.data;

  const [remind, setRemind] = useState(false);
  const [chats, setChats] = useState<ChatMessage[]>([]);
  const [openW, setOpenW] = useState(false);
  const [wVal, setWVal] = useState('');
  const [sending, setSending] = useState(false);
  const [selDate, setSelDate] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [cYear, setCYear] = useState(new Date().getFullYear());
  const [cMonth, setCMonth] = useState(new Date().getMonth());
  const [selFilter, setSelFilter] = useState<string>('すべて');
  // 筋トレ画面で開いているだけの日（まだ種目が無い）。保存対象ではない
  const [draftWorkoutDates, setDraftWorkoutDates] = useState<string[]>([]);

  // 端末に紐づくものだけ（通知設定・AIチャット）はこれまでどおりこの端末に置く。
  // 記録データの保存先は useAppData が決める
  useEffect(() => {
    try {
      const r = localStorage.getItem('reminders_enabled');
      const c = localStorage.getItem('chat_messages');
      if (r) setRemind(JSON.parse(r));
      if (c) setChats(JSON.parse(c));
    } catch (e) { console.error(e); }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(e => console.error(e));
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('reminders_enabled', JSON.stringify(remind));
      // チャット画像（Base64）はlocalStorage容量を圧迫するため保存しない
      const chatsForStorage = chats.map(({ images: _images, ...rest }) => rest);
      localStorage.setItem('chat_messages', JSON.stringify(chatsForStorage));
    } catch (e) { console.warn(e); }
  }, [remind, chats]);

  useEffect(() => {
    setDraftWorkoutDates([]);
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
    setDraftWorkoutDates([]);
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
  // 食事ログの選択日でフィルタ。dateを持たない古いデータは今日扱い（後方互換）
  const dietMeals = useMemo(() => meals.filter(m => (m.date || today) === dietDate), [meals, today, dietDate]);

  const streakData = useMemo(
    () => computeStreak(meals, today, freezeUsedDates, longestStreak),
    [meals, today, freezeUsedDates, longestStreak]
  );
  useEffect(() => {
    if (store.state !== 'ready') return;
    const patch: { freezeUsedDates?: string[]; longestStreak?: number } = {};
    if (streakData.freezeUsedDates.length !== freezeUsedDates.length) patch.freezeUsedDates = streakData.freezeUsedDates;
    if (streakData.currentStreak > longestStreak) patch.longestStreak = streakData.currentStreak;
    if (Object.keys(patch).length > 0) void store.actions.saveProfile(patch);
  }, [streakData.currentStreak, streakData.freezeUsedDates.length, store.state]);
  const tStats = useMemo(() => tMeals.reduce((acc, m) => ({ calories: acc.calories + (Number(m.calories) || 0), protein: acc.protein + (Number(m.protein) || 0), fat: acc.fat + (Number(m.fat) || 0), carbs: acc.carbs + (Number(m.carbs) || 0) }), { calories: 0, protein: 0, fat: 0, carbs: 0 }), [tMeals]);
  const tWorkout = useMemo(() => workouts.find(w => w.date === today), [workouts, today]);
  const cWeight = useMemo(() => weights.length ? weights[weights.length - 1].weight : null, [weights]);

  // 「記録開始」は画面を開くだけ。種目を足した時点で保存される
  const addWorkout = () => {
    if (tWorkout) return alert("記録済です");
    openWorkoutDay(today);
    setTab('workout');
  };
  const openWorkoutDay = (date: string) => {
    setDraftWorkoutDates(p => p.includes(date) ? p : [...p, date]);
    setSelDate(date);
  };
  const addWeight = (w: number) => {
    void store.actions.saveWeight(today, w);
    // 朝の通知が「今日はもう記録済み」を判断するための日付だけ送る（数値は送らない）
    fetch('/api/save-weight-date', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: today }) }).catch(() => {});
  };

  /** 選択中の日の筋トレ。まだ種目が無い日は保存せず、同じ形の器だけ用意する */
  const selectedWorkout = useMemo(() => {
    if (!selDate) return undefined;
    return workouts.find(w => w.date === selDate) ?? { id: `draft:${selDate}`, date: selDate, exercises: [] };
  }, [workouts, selDate]);

  // クラウドが正本なのに読み込めず、控えも無い状態。
  // ここで空っぽの画面を出すと「記録が消えた」ように見えるので、画面ごと差し替える
  if (store.state === 'error') {
    return (
      <div className="min-h-dvh bg-black text-zinc-100 font-sans flex items-center justify-center px-6">
        <div className="w-full max-w-sm ll-card p-6 space-y-4 text-center">
          <div className="text-lime-400 font-black italic text-lg uppercase tracking-wider">LIFT &amp; LEAN</div>
          <p className="text-sm font-bold text-white">データを読み込めませんでした</p>
          <p className="text-xs text-zinc-500 leading-relaxed">
            {store.loadError ?? '通信に失敗しました。'}<br />
            <span className="text-zinc-400">記録が消えたわけではありません。</span>
            電波の良い場所で、もう一度お試しください。
          </p>
          <button
            type="button"
            onClick={() => void store.reload()}
            className="w-full bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm active:scale-95 transition-all"
          >
            もう一度読み込む
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-black text-zinc-100 font-sans selection:bg-lime-400 selection:text-black">
      <div className="max-w-md mx-auto min-h-dvh flex flex-col relative px-5 bg-[#0a0a0a]" style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))' }}>
        {store.state === 'loading' && store.mode === 'cloud' && (
          <div className="fixed inset-x-0 top-0 z-[60] bg-zinc-900/95 border-b border-zinc-800 px-5 py-2 text-center text-[11px] font-bold text-zinc-400">
            クラウドから読み込んでいます…
          </div>
        )}
        {store.state === 'ready' && store.stale && (
          <div className="fixed inset-x-0 top-0 z-[60] bg-amber-500/15 border-b border-amber-500/30 px-5 py-2 text-center text-[11px] font-bold text-amber-300">
            最新のデータを取得できていません（表示は前回の内容）
            <button type="button" onClick={() => void store.reload()} className="ml-2 underline">再試行</button>
          </div>
        )}
        <SyncStatus
          pendingCount={store.pendingCount}
          failedCount={store.failedCount}
          syncing={store.syncing}
          saveError={store.saveError}
          onRetry={store.retryFailed}
          onDismissFailed={store.dismissFailed}
          onClearError={store.clearSaveError}
        />

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
                          <button key={`day-${day}`} onClick={() => { if (hiddenDates.includes(dateStr)) { void store.actions.saveProfile({ hiddenWorkoutDates: hiddenDates.filter(d => d !== dateStr) }); } openWorkoutDay(dateStr); }} className={`h-8 rounded-xl flex flex-col items-center justify-center relative text-xs font-mono font-bold transition-all active:scale-90 ${hasWorkout ? 'bg-lime-400 text-black font-black shadow-[0_0_15px_rgba(163,230,53,0.3)] border border-lime-400' : isToday ? 'border-2 border-lime-400 text-lime-400 font-black bg-lime-400/5 animate-pulse' : 'bg-zinc-950 border border-zinc-900 text-zinc-450 hover:border-zinc-700 hover:text-white'}`} type="button"><span>{day}</span></button>
                        );
                      })}
                    </div>
                  </div>
                  <button onClick={() => openWorkoutDay(today)} className="w-full bg-lime-400 text-black p-4 rounded-2xl font-black text-sm uppercase italic tracking-wider flex items-center justify-center gap-2 active:scale-95 transition-all shadow-[0_0_20px_rgba(163,230,53,0.15)]" ><Sparkles size={18} /> {workouts.some(w => w.date === today) ? "今日のトレーニングを表示・編集" : "今日のトレーニング記録を開始する"}</button>
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
                            <div className="flex items-center gap-3 shrink-0"><div className="text-right"><span className="inline-flex items-center leading-none whitespace-nowrap text-[10px] font-mono font-bold text-lime-400 bg-lime-400/10 border border-lime-400/20 px-2 py-1 rounded-lg">{w.exercises.length}種目 / {totalSets}SET</span></div><button type="button" onClick={(e) => { e.stopPropagation(); if (confirm(`${w.date.replace(/-/g, '/')} の履歴を一覧から非表示にしますか？\n（カレンダーや分析グラフの記録はそのまま残ります）`)) { void store.actions.saveProfile({ hiddenWorkoutDates: [...hiddenDates, w.date] }); } }} className="p-2 text-zinc-600 hover:text-rose-500 hover:bg-rose-900 rounded-xl transition-colors" ><Trash2 size={15} /></button></div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <SectionWorkout
                    todayWorkout={selectedWorkout} workouts={workouts} today={selDate} setActiveTab={handleCloseWorkoutDetail} addWorkout={addWorkout} currentWeight={cWeight}
                    addExercise={(_wid, n, cat) => { void store.actions.addExercise(selDate, n, cat); }}
                    addSet={(_wid, eid, w: any, r: any) => { void store.actions.addSet(eid, w, r); }}
                    deleteExercise={(_wid, eid) => { void store.actions.deleteExercise(eid); }}
                    deleteSet={(_wid, _eid, sid) => { void store.actions.deleteSet(sid); }}
                    updateSet={(_wid, _eid, sid, w: any, r: any) => { void store.actions.updateSet(sid, w, r); }} />
                </div>
              ))}
              {tab === 'diet' && <SectionDiet dayMeals={dietMeals} allMeals={meals} selectedDate={dietDate} today={today} onSelectDate={setDietDate} addMeal={(m) => { void store.actions.addMeal(dietDate, m); }} updateMeal={(id, patch) => { void store.actions.updateMeal(id, patch); }} deleteMeal={(id) => { void store.actions.deleteMeal(id); }} goals={goals} onEditingChange={setDietEditOpen} />}
              {tab === 'analysis' && <SectionAnalysis weightHistory={weights} meals={meals} workouts={workouts} addWeight={addWeight} today={today} openWeightModal={() => setOpenW(true)} goals={goals} />}
              {tab === 'aitrainer' && <SectionAITrainer chatMessages={chats} setChatMessages={setChats} currentWeight={cWeight} goals={goals} today={today} todayWorkout={tWorkout} setActiveTab={setTab} isSending={sending} handleSendMessage={handleSendMessage} handleCancelMessage={() => abortRef.current?.abort()} />}
              {tab === 'settings' && <SectionSettings goals={goals} setGoals={(g) => { void store.actions.saveGoals(g); }} remind={remind} toggleNotification={toggleNotify} account={store.account} dataMode={store.mode} onAccountChanged={store.refreshAccount} />}
            </motion.div>
          </AnimatePresence>
        </main>
        {/* 話して記録：どの画面からでも1タップ */}
        {!dietEditOpen && !voiceOpen && (
          <button
            type="button"
            onClick={() => setVoiceOpen(true)}
            aria-label="話して記録"
            className="fixed z-[58] right-5 bottom-24 w-14 h-14 rounded-full bg-lime-400 text-black flex items-center justify-center shadow-[0_6px_24px_rgba(163,230,53,0.35)] active:scale-90 transition-all"
          >
            <Mic size={24} />
          </button>
        )}

        <nav className={`fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-zinc-950/90 backdrop-blur-xl border-t border-zinc-800 px-3 py-2 flex items-center justify-between z-50 ${dietEditOpen ? 'hidden' : ''}`} style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
          {([
            { id: 'dashboard',  Icon: Activity,  label: 'ホーム' },
            { id: 'workout',    Icon: Dumbbell,  label: 'トレーニング' },
            { id: 'diet',       Icon: Utensils,  label: '食事' },
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
      <VoiceCommand
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onRecorded={() => { void store.reload(); }}
      />

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
