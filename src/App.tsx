import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Activity, Utensils, BarChart3, Settings, Dumbbell, Sparkles } from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import { UserGoals, WeightRecord, Workout, Meal, ChatMessage, Tab } from './types';
import { SectionDashboard } from './components/SectionDashboard';
import { SectionWorkout } from './components/SectionWorkout';
import { SectionDiet } from './components/SectionDiet';
import { SectionAnalysis } from './components/SectionAnalysis';
import { SectionAITrainer } from './components/SectionAITrainer';
import { SectionSettings } from './components/SectionSettings';

// 🚨【真っ白クラッシュ完全防衛盾】スマホ自爆を完全に防ぐ安全ID生成
const safeUUID = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
};

const DEFAULT_GOALS: UserGoals = { calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 70 };

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [weights, setWeights] = useState<WeightRecord[]>([]);
  const [goals, setGoals] = useState<UserGoals>(DEFAULT_GOALS);
  const [chats, setChats] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openW, setOpenW] = useState(false);
  const [wVal, setWVal] = useState('');
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const w = localStorage.getItem('workouts');
      const m = localStorage.getItem('meals');
      const wg = localStorage.getItem('weight_history');
      const g = localStorage.getItem('user_goals');
      const c = localStorage.getItem('chat_messages');
      if (w) setWorkouts(JSON.parse(w));
      if (m) setMeals(JSON.parse(m));
      if (wg) setWeights(JSON.parse(wg)); // 🚨私の自爆バグを完璧に修正！
      if (g) setGoals({ ...DEFAULT_GOALS, ...JSON.parse(g) });
      if (c) setChats(JSON.parse(c));
    } catch (e) { console.error(e); }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('workouts', JSON.stringify(workouts));
    localStorage.setItem('meals', JSON.stringify(meals));
    localStorage.setItem('weight_history', JSON.stringify(weights));
    localStorage.setItem('user_goals', JSON.stringify(goals));
    localStorage.setItem('chat_messages', JSON.stringify(chats));
  }, [workouts, meals, weights, goals, chats, loaded]);

  const today = format(new Date(), 'yyyy-MM-dd');
  const tMeals = useMemo(() => meals.filter(m => m.date === today), [meals, today]);
  const tStats = useMemo(() => tMeals.reduce((acc, m) => ({
    calories: acc.calories + (Number(m.calories) || 0),
    protein: acc.protein + (Number(m.protein) || 0),
    fat: acc.fat + (Number(m.fat) || 0),
    carbs: acc.carbs + (Number(m.carbs) || 0)
  }), { calories: 0, protein: 0, fat: 0, carbs: 0 }), [tMeals]);
  const tWorkout = useMemo(() => workouts.find(w => w.date === today), [workouts, today]);
  const cWeight = useMemo(() => weights.length ? weights[weights.length - 1].weight : null, [weights]);

  const handleSendMessage = async (text: string, images: string[]) => {
    if (!text.trim() && images.length === 0) return;
    const userMsg: ChatMessage = { id: safeUUID(), role: 'user', text, images, timestamp: new Date().toISOString() };
    setChats(prev => [...prev, userMsg]);
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch('/api/chat-trainer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          images,
          workouts: tWorkout ? [tWorkout] : [],
          meals: tMeals,
          userData: { weight: cWeight || 0, targetWeight: goals.targetWeight, calories: goals.calories, protein: goals.protein, fat: goals.fat, carbs: goals.carbs }
        })
      });
      const data = await response.json();
      setChats(prev => [...prev, {
        id: safeUUID(),
        role: 'assistant',
        text: data?.text || 'エラーが発生しました。',
        exercises: Array.isArray(data?.exercises) ? data.exercises : [],
        timestamp: new Date().toISOString()
      }]);
    } catch (error: any) {
      if (error.name !== 'AbortError') alert('AIとの通信に失敗しました。');
    } finally { // 🚨タイポを完璧に修正！
      setSending(false);
      abortRef.current = null;
    }
  };

  const addWeight = (w: number) => {
    const r = { id: safeUUID(), date: today, weight: w };
    const i = weights.findIndex(x => x.date === today);
    if (i > -1) { const u = [...weights]; u[i] = r; setWeights(u); } else { setWeights([...weights, r]); }
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans selection:bg-lime-400 selection:text-black">
      <div className="max-w-md mx-auto min-h-screen flex flex-col relative px-5 pt-6 bg-[#0a0a0a]">
        <main className="flex-1">
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.2 }} >
              {tab === 'dashboard' && <SectionDashboard todayStats={tStats} goals={goals} weightHistory={weights} today={today} todayWorkout={tWorkout} todayMeals={tMeals} currentWeight={cWeight} addWeight={addWeight} setActiveTab={setTab} openWeightModal={() => setOpenW(true)} />}
              {tab === 'workout' && <SectionWorkout todayWorkout={tWorkout} today={today} setActiveTab={setTab} addWorkout={() => { if (tWorkout) return alert("記録済です"); setWorkouts([...workouts, { id: safeUUID(), date: today, exercises: [] }]); }} addExercise={(wid, n) => setWorkouts(p => p.map(x => x.id !== wid ? x : { ...x, exercises: [...x.exercises, { id: safeUUID(), name: n, sets: [] }] }))} addSet={(wid, eid, w, r) => setWorkouts(p => p.map(x => x.id !== wid ? x : { ...x, exercises: x.exercises.map(e => e.id !== eid ? e : { ...e, sets: [...e.sets, { id: safeUUID(), weight: w, reps: r }] }) }))} deleteExercise={(wid, eid) => setWorkouts(p => p.map(x => x.id !== wid ? x : { ...x, exercises: x.exercises.filter(e => e.id !== eid) }))} deleteSet={(wid, eid, sid) => setWorkouts(p => p.map(x => x.id !== wid ? x : { ...x, exercises: x.exercises.map(e => e.id !== eid ? e : { ...e, sets: e.sets.filter(s => s.id !== sid) }) }))} updateSet={(wid, eid, sid, w, r) => setWorkouts(p => p.map(x => x.id !== wid ? x : { ...x, exercises: x.exercises.map(e => e.id !== eid ? e : { ...e, sets: e.sets.map(s => s.id !== sid ? s : { ...s, weight: w, reps: r }) }) }))} />}
              {tab === 'diet' && <SectionDiet todayMeals={tMeals} addMeal={(m) => setMeals([...meals, { ...m, id: safeUUID(), date: today }])} deleteMeal={(id) => setMeals(p => p.filter(x => x.id !== id))} goals={goals} />}
              {tab === 'analysis' && <SectionAnalysis weightHistory={weights} meals={meals} workouts={workouts} addWeight={addWeight} today={today} openWeightModal={() => setOpenW(true)} />}
              {tab === 'aitrainer' && <SectionAITrainer chatMessages={chats} setChatMessages={setChats} currentWeight={cWeight} goals={goals} today={today} todayWorkout={tWorkout} setWorkouts={setWorkouts} setActiveTab={setTab} isSending={sending} handleSendMessage={handleSendMessage} handleCancelMessage={() => abortRef.current?.abort()} />}
              {tab === 'settings' && <SectionSettings goals={goals} setGoals={setGoals} requestNotificationPermission={async () => {}} />}
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
                    <input type="number" step="0.1" required placeholder="0.0" value={wVal} onChange={(e) => setWVal(e.target.value)} className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-center text-3xl font-black text-lime-400 outline-none" autoFocus />
                    <span className="absolute right-4 bottom-4 text-xs font-mono text-zinc-500">KG</span>
                  </div>
                  <div className="flex gap-2">
                    <button type="submit" className="flex-1 bg-lime-400 text-black py-3 rounded-xl font-bold text-xs" > 記録する </button>
                    <button type="button" onClick={() => setOpenW(false)} className="flex-1 bg-zinc-900 text-zinc-400 py-3 rounded-xl font-bold text-xs" > キャンセル </button>
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
