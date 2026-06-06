import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Activity, Utensils, BarChart3, Settings, Dumbbell, Sparkles, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import { UserGoals, WeightRecord, Workout, Meal, ChatMessage, Tab } from './types';
import { SectionDashboard } from './components/SectionDashboard';
import { SectionWorkout } from './components/SectionWorkout';
import { SectionDiet } from './components/SectionDiet';
import { SectionAnalysis } from './components/SectionAnalysis';
import { SectionAITrainer } from './components/SectionAITrainer';
import { SectionSettings } from './components/SectionSettings';

const safeUUID = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
const DF_G: UserGoals = { calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 70 };

// 💡【新設】アプリの裏側で種目名から「部位」を瞬時にマッピングする賢い辞書
const EXERCISE_TO_CATEGORY: Record<string, string> = {
  'ベンチプレス': '胸', 'インクラインダンベルプレス': '胸', 'チェストプレスマシン': '胸', 'ペックフライ': '胸',
  'チンニング': '背中', 'ラットプルダウン': '背中', 'デッドリフト': '背中', 'シーテッドロー': '背中',
  'ショルダープレス': '肩', 'ミリタリープレス': '肩', 'サイドレイズ': '肩', 'リアレイズ': '肩',
  'アームカール': '腕', 'プッシュダウン': '腕', 'スカルクラッシャー': '腕',
  'スクワット': '脚', 'レッグプレス': '脚', 'レッグエクステンション': '脚'
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
  const [selDate, setSelDate] = useState<string | null>(null); // 過去のログを選択するための超重要スイッチ！
  const abortRef = useRef<AbortController | null>(null);

  // 📅 筋トレカレンダー用の年月ステート
  const [cYear, setCYear] = useState(new Date().getFullYear());
  const [cMonth, setCMonth] = useState(new Date().getMonth()); // 0-11

  // ユーザーが「履歴から消したい」と選んだ日付をがっちり記憶する秘密のブラックリスト
  const [hiddenDates, setHiddenDates] = useState<string[]>([]);

  // 💡【新設】現在選択されている部位フィルターのステート（デフォルトはすべて）
  const [selFilter, setSelFilter] = useState<string>('すべて');

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
      localStorage.setItem('chat_messages', JSON.stringify(chats));
      localStorage.setItem('hidden_workout_dates', JSON.stringify(hiddenDates));
    } catch (e) { console.warn(e); }
  }, [workouts, meals, weights, goals, remind, chats, loaded, hiddenDates]);

  // タブが切り替わったら、自動的に「中身が空っぽのログ」を消去して一覧を綺麗にするスマート設計！
  useEffect(() => {
    setWorkouts(p => p.filter(w => w.exercises.length > 0));
    setSelDate(null);
    setSelFilter('すべて'); // タブ切り替えでフィルターもリセット
  }, [tab]);

  // 過去のトレーニング記録を日付が新しい順（最新が一番上）に自動で並び替えるマシーン
  const sortedWorkouts = useMemo(() => {
    return [...workouts].sort((a, b) => b.date.localeCompare(a.date));
  }, [workouts]);

  // 💡【新設】選択された部位フィルターに応じて、タイムラインの表示をシュッと切り替える爆速フィルタリングロジック
  const filteredWorkouts = useMemo(() => {
    // まず「1種目以上あって非表示にされていないガチのログ」に絞る
    const basicList = sortedWorkouts.filter(w => w.exercises.length > 0 && !hiddenDates.includes(w.date));
    
    if (selFilter === 'すべて') return basicList;
    
    // 選択された部位の種目が1つでも含まれる日だけを抽出
    return basicList.filter(w => 
      w.exercises.some(e => EXERCISE_TO_CATEGORY[e.name] === selFilter)
    );
  }, [sortedWorkouts, hiddenDates, selFilter]);

  // 📅 選択された年月のカレンダーグリッド（日付配列）を爆速計算するロジック
  const calendarDays = useMemo(() => {
    const startDayOfWeek = new Date(cYear, cMonth, 1).getDay();
    const totalDays = new Date(cYear, cMonth + 1, 0).getDate();
    const days = [];
    for (let i = 0; i < startDayOfWeek; i++) days.push(null); // 前月の空白埋め
    for (let i = 1; i <= totalDays; i++) days.push(i); // 今月の日付
    return days;
  }, [cYear, cMonth]);

  const prevMonth = () => {
    if (cMonth === 0) {
      setCMonth(11);
      setCYear(cYear - 1);
    } else {
      setCMonth(cMonth - 1);
    }
  };

  const nextMonth = () => {
    if (cMonth === 11) {
      setCMonth(0);
      setCYear(cYear + 1);
    } else {
      setCMonth(cMonth + 1);
    }
  };

  // 詳細画面から一覧画面へ戻るときに、中身が空っぽのログを完全にシュリンクして消し去る関数
  const handleCloseWorkoutDetail = () => {
    setWorkouts(p => p.filter(w => w.exercises.length > 0));
    setSelDate(null);
  };

  const toggleNotify = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      alert('ホーム画面（アプリモード）から起動してください。');
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
        setRemind(false);
        alert('毎朝のリマインダー通知をオフにしました。');
      } else {
        const p = await Notification.requestPermission();
        if (p !== 'granted') {
          alert('通知を許可してください');
          return;
        }
        const keyRes = await fetch('/api/wp-public-key');
        const { publicKey } = await keyRes.json();
        const convertedKey = urlBase64ToUint8Array(publicKey);
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: convertedKey });
        setRemind(true);
        await fetch('/api/send-test-notification', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
        alert('毎朝のリマインダー通知をオンにしました！明日から朝7時に、体重が未入力の場合にお知らせします。🔥');
      }
    } catch (e) { alert('設定エラー: ' + String(e)); }
  };

  const handleSendMessage = async (text: string, images: string[]) => {
    if (!text.trim() && images.length === 0) return;
    const userMsg: ChatMessage = { id: safeUUID(), role: 'user', text, images, timestamp: new Date().toISOString() };
    setChats(prev => [...prev, userMsg]);
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch('/api/chat-trainer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ message: text, images, workouts: tWorkout ? [tWorkout] : [], meals: tMeals, userData: { weight: cWeight || 0, targetWeight: goals.targetWeight, calories: goals.calories, protein: goals.protein, fat: goals.fat, carbs: goals.carbs } }) });
      const data = await response.json();
      setChats(prev => [...prev, { id: safeUUID(), role: 'assistant', text: data?.text || 'エラーが発生しました。', exercises: Array.isArray(data?.exercises) ? data.exercises : [], timestamp: new Date().toISOString() }]);
    } catch (error: any) {
      if (error.name !== 'AbortError') alert('AIとの通信に失敗しました。');
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  const today = format(new Date(), 'yyyy-MM-dd');
  const tMeals = useMemo(() => meals.filter(m => m.date === today), [meals, today]);
  const tStats = useMemo(() => tMeals.reduce((acc, m) => ({ calories: acc.calories + (Number(m.calories) || 0), protein: acc.protein + (Number(m.protein) || 0), fat: acc.fat + (Number(m.fat) || 0), carbs: acc.carbs + (Number(m.carbs) || 0) }), { calories: 0, protein: 0, fat: 0, carbs: 0 }), [tMeals]);
  const tWorkout = useMemo(() => workouts.find(w => w.date === today), [workouts, today]);
  const cWeight = useMemo(() => weights.length ? weights[weights.length - 1].weight : null, [weights]);

  const addWorkout = () => {
    if (tWorkout) return alert("記録済です");
    setWorkouts([...workouts, { id: safeUUID(), date: today, exercises: [] }]);
    setTab('workout');
  };

  const addWeight = (w: number) => {
    const r = { id: safeUUID(), date: today, weight: w }, i = weights.findIndex(x => x.date === today);
    if (i > -1) {
      const u = [...weights];
      u[i] = r;
      setWeights(u);
    } else {
      setWeights([...weights, r]);
    }
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans selection:bg-lime-400 selection:text-black">
      <div className="max-w-md mx-auto min-h-screen flex flex-col relative px-5 pt-6 bg-[#0a0a0a]">
        <main className="flex-1">
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.2 }} >
              {tab === 'dashboard' && <SectionDashboard todayStats={tStats} goals={goals} weightHistory={weights} today={today} todayWorkout={tWorkout} todayMeals={tMeals} currentWeight={cWeight} addWeight={addWeight} setActiveTab={setTab} openWeightModal={() => setOpenW(true)} />}
              
              {/* 【超進化ログセクション】 */}
              {tab === 'workout' && (selDate === null ? (
                // 【モードA】過去の筋トレ履歴タイムライン一覧画面
                <div className="space-y-4 pb-24">
                  <div className="flex items-center gap-2 text-lime-400 font-black italic text-xl uppercase tracking-wider mb-2">
                    <Dumbbell size={24} /> <span>TRAINING LOGS</span>
                  </div>

                  {/* 📅 ラグジュアリー・ミニマルカレンダーコンポーネント */}
                  <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-4 space-y-3 shadow-[0_4px_20px_rgba(0,0,0,0.4)] animate-in fade-in slide-in-from-top-4 duration-200">
                    <div className="flex justify-between items-center px-1">
                      <div className="text-xs font-black text-white font-mono uppercase tracking-wider">
                        {cYear}年 {cMonth + 1}月 のスタンプ
                      </div>
                      <div className="flex gap-1.5">
                        <button onClick={prevMonth} className="w-7 h-7 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors text-xs font-black flex items-center justify-center active:scale-95" type="button">←</button>
                        <button onClick={nextMonth} className="w-7 h-7 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors text-xs font-black flex items-center justify-center active:scale-95" type="button">→</button>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-7 gap-1 text-center text-[9px] font-black text-zinc-500 uppercase tracking-widest pb-1 border-b border-zinc-800/40">
                      <div className="text-rose-500/80">日</div><div>月</div><div>火</div><div>水</div><div>木</div><div>金</div><div className="text-blue-500/80">土</div>
                    </div>
                    
                    <div className="grid grid-cols-7 gap-1">
                      {calendarDays.map((day, idx) => {
                        if (!day) return <div key={`empty-${idx}`} className="h-8" />;
                        
                        const dateStr = `${cYear}-${String(cMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                        const targetWorkout = workouts.find(w => w.date === dateStr);
                        const hasWorkout = targetWorkout && targetWorkout.exercises.length > 0;
                        const isToday = dateStr === today;
                        
                        return (
                          <button
                            key={`day-${day}`}
                            onClick={() => {
                              const hasData = workouts.some(w => w.date === dateStr);
                              if (!hasData) {
                                setWorkouts([...workouts, { id: safeUUID(), date: dateStr, exercises: [] }]);
                              }
                              setHiddenDates(p => p.filter(d => d !== dateStr));
                              setSelDate(dateStr);
                            }}
                            className={`h-8 rounded-xl flex flex-col items-center justify-center relative text-xs font-mono font-bold transition-all active:scale-90 ${
                              hasWorkout 
                                ? 'bg-lime-400 text-black font-black shadow-[0_0_15px_rgba(163,230,53,0.3)] border border-lime-400' 
                                : isToday
                                  ? 'border-2 border-lime-400 text-lime-400 font-black bg-lime-400/5 animate-pulse'
                                  : 'bg-zinc-950 border border-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-white'
                            }`}
                            type="button"
                          >
                            <span>{day}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <button onClick={() => { const hasToday = workouts.some(w => w.date === today); if (!hasToday) { setWorkouts([...workouts, { id: safeUUID(), date: today, exercises: [] }]); } setSelDate(today); }} className="w-full bg-lime-400 text-black p-4 rounded-2xl font-black text-sm uppercase italic tracking-wider flex items-center justify-center gap-2 active:scale-95 transition-all shadow-[0_0_20px_rgba(163,230,53,0.15)]" >
                    <Sparkles size={18} /> {workouts.some(w => w.date === today) ? "今日のトレーニングを表示・編集" : "今日のトレーニング記録を開始する"}
                  </button>
                  
                  {/* 💡【新設】横スクロールできる超スタイリッシュな部位フィルターチップ */}
                  <div className="pt-2">
                    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
                      {['すべて', '胸', '背中', '肩', '腕', '脚'].map(cat => (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => setSelFilter(cat)}
                          className={`px-4 py-2 rounded-xl text-xs font-black tracking-wider transition-all whitespace-nowrap active:scale-95 ${
                            selFilter === cat
                              ? 'bg-lime-400 text-black shadow-md shadow-lime-400/10'
                              : 'bg-zinc-900 border border-zinc-850 text-zinc-400 hover:text-white'
                          }`}
                        >
                          {cat} {selFilter === cat && '✓'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="text-xs font-bold text-zinc-500 uppercase tracking-wider pt-2 flex justify-between">
                    <span>筋トレ履歴 {selFilter !== 'すべて' && <span className="text-lime-400 font-mono">({selFilter}のみ)</span>}</span>
                    <span className="font-mono text-[10px] text-zinc-600">{filteredWorkouts.length}件</span>
                  </div>
                  
                  {/* 💡 改善：表示データを「filteredWorkouts」に差し替え！部位別のスマート絞り込み */}
                  {filteredWorkouts.length === 0 ? (
                    <div className="text-center py-12 bg-zinc-950 border border-zinc-900 rounded-3xl text-zinc-500 text-xs">
                      {selFilter === 'すべて' ? 'トレーニングの記録がまだありません。' : `${selFilter}のトレーニング記録はありません。`}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {filteredWorkouts.map(w => { 
                        const totalSets = w.exercises.reduce((sum, e) => sum + e.sets.length, 0); 
                        return (
                          <div key={w.id} onClick={() => setSelDate(w.date)} className="bg-zinc-950 border border-zinc-900 rounded-2xl p-4 flex items-center justify-between hover:border-zinc-700 active:bg-zinc-900/50 transition-all cursor-pointer group" > 
                            <div className="space-y-1 max-w-[65%]"> 
                              <div className="text-sm font-mono font-bold text-white flex items-center gap-2"> 
                                {w.date.replace(/-/g, '/')} 
                                {w.date === today && <span className="text-[10px] bg-lime-400 text-black px-1.5 py-0.5 rounded font-sans font-black">TODAY</span>} 
                              </div> 
                              <div className="text-xs text-zinc-400 truncate"> 
                                {w.exercises.map(e => e.name).join(', ')} 
                              </div> 
                            </div> 
                            <div className="flex items-center gap-3">
                              <div className="text-right"> 
                                <span className="text-[10px] font-mono font-bold text-lime-400 bg-lime-400/10 border border-lime-400/20 px-2 py-1 rounded-lg"> 
                                  {w.exercises.length}種目 / {totalSets}SET 
                                </span> 
                              </div> 
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirm(`${w.date.replace(/-/g, '/')} の履歴を一覧から非表示にしますか？\n（カレンダーや分析グラフの記録はそのまま残ります）`)) {
                                    setHiddenDates(p => [...p, w.date]);
                                  }
                                }}
                                className="p-2 text-zinc-600 hover:text-rose-500 hover:bg-rose-900 rounded-xl transition-colors"
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </div>
                        ); 
                      })}
                    </div>
                  )}
                </div>
              ) : (
                // 【モードB】選択した日付の筋トレ詳細・編集画面
                <div className="space-y-4">
                  <SectionWorkout 
                    todayWorkout={workouts.find(w => w.date === selDate)} 
                    today={selDate} 
                    setActiveTab={handleCloseWorkoutDetail} 
                    addWorkout={addWorkout} 
                    currentWeight={cWeight} 
                    addExercise={(wid, n) => setWorkouts(p => p.map(w => w.id !== wid ? w : { ...w, exercises: [...w.exercises, { id: safeUUID(), name: n, sets: [] }] }))} 
                    addSet={(wid, eid, w: any, r: any) => setWorkouts(p => p.map(x => x.id !== wid ? x : { ...x, exercises: x.exercises.map(e => e.id !== eid ? e : { ...e, sets: [...e.sets, { id: safeUUID(), weight: w, reps: r }] }) }))} 
                    deleteExercise={(wid, eid) => setWorkouts(p => p.map(w => w.id !== wid ? w : { ...w, exercises: w.exercises.filter(e => e.id !== eid) }))} 
                    deleteSet={(wid, eid, sid) => setWorkouts(p => p.map(w => w.id !== wid ? w : { ...w, exercises: w.exercises.map(e => e.id !== eid ? e : { ...e, sets: e.sets.filter(s => s.id !== sid) }) }))} 
                    updateSet={(wid, eid, sid, w: any, r: any) => setWorkouts(p => p.map(x => x.id !== wid ? x : { ...x, exercises: x.exercises.map(e => e.id !== eid ? e : { ...e, sets: e.sets.map(s => s.id !== sid ? s : { ...s, weight: w, reps: r }) }) }))} />
                </div>
              ))}
              
              {tab === 'diet' && <SectionDiet todayMeals={tMeals} addMeal={(m) => setMeals([...meals, { ...m, id: safeUUID(), date: today }])} deleteMeal={(id) => setMeals(p => p.filter(x => x.id !== id))} goals={goals} />}
              {tab === 'analysis' && <SectionAnalysis weightHistory={weights} meals={meals} workouts={workouts} addWeight={addWeight} today={today} openWeightModal={() => setOpenW(true)} />}
              {tab === 'aitrainer' && <SectionAITrainer chatMessages={chats} setChatMessages={setChats} currentWeight={cWeight} goals={goals} today={today} todayWorkout={tWorkout} setWorkouts={setWorkouts} setActiveTab={setTab} isSending={sending} handleSendMessage={handleSendMessage} handleCancelMessage={() => abortRef.current?.abort()} />}
              {tab === 'settings' && <SectionSettings goals={goals} setGoals={setGoals} remind={remind} toggleNotification={toggleNotify} />}
            </motion.div>
          </AnimatePresence>
        </main>
        
        <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-zinc-950/80 backdrop-blur-xl border-t border-zinc-900 px-6 py-4 flex items-center justify-between z-50">
          <button onClick={() => setTab('dashboard')} className={`flex flex-col items-center gap-1 ${tab === 'dashboard' ? 'text-lime-400' : 'text-zinc-600'}`}><Activity size={24} /><span className="text-[10px] font-bold">ホーム</span></button>
          <button onClick={() => setTab('workout')} className={`flex flex-col items-center gap-1 ${tab === 'workout' ? 'text-lime-400' : 'text-zinc-600'}`}><Dumbbell size={24} /><span className="text-[10px] font-bold">ログ</span></button>
          <button onClick={() => setTab('diet')} className={`flex flex-col items-center gap-1 ${tab === 'diet' ? 'text-lime-400' : 'text-zinc-600'}`}><Utensils size={24} /><span className="text-[10px] font-bold">食事</span></button>
          <button onClick={() => setTab('aitrainer')} className={`flex flex-col items-center gap-1 ${tab === 'aitrainer' ? 'text-lime-400' : 'text-zinc-600'}`}><Sparkles size={24} /><span className="text-[10px] font-bold">AI</span></button>
          <button onClick={() => setTab('analysis')} className={`flex flex-col items-center gap-1 ${tab === 'analysis' ? 'text-lime-400' : 'text-zinc-600'}`}><BarChart3 size={24} /><span className="text-[10px] font-bold">分析</span></button>
          <button onClick={() => setTab('settings')} className={`flex flex-col items-center gap-1 ${tab === 'settings' ? 'text-lime-400' : 'text-zinc-600'}`}><Settings size={24} /><span className="text-[10px] font-bold">設定</span></button>
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
                    <input type="number" step="0.1" required placeholder="0.0" value={wVal === '0' || wVal === '0.0' ? '' : wVal} onChange={(e) => setWVal(e.target.value)} className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-center text-3xl font-black text-lime-400 outline-none" autoFocus />
                    <span className="absolute right-4 bottom-4 text-xs font-mono text-zinc-500">KG</span>
                  </div>
                  <div className="flex gap-2">
                    <button type="submit" className="flex-1 bg-lime-400 text-black py-3 rounded-xl font-bold text-xs" > 記録する </button>
                    <button type="button" onClick={() => setOpenW(false)} className="flex-1 bg-zinc-900 text-zinc-450 hover:text-white border border-zinc-900 py-3 rounded-xl font-bold text-xs" > キャンセル </button>
                  </div>
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
