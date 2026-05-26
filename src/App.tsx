import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Activity, Utensils, BarChart3, Settings, Dumbbell, Sparkles } from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { UserGoals, WeightRecord, Workout, Meal, ChatMessage, Tab } from './types';
import { SectionDashboard } from './components/SectionDashboard';
import { SectionWorkout } from './components/SectionWorkout';
import { SectionDiet } from './components/SectionDiet';
import { SectionAnalysis } from './components/SectionAnalysis';
import { SectionAITrainer } from './components/SectionAITrainer';
import { SectionSettings } from './components/SectionSettings';

function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

// 🚨【真っ白クラッシュ完全防衛盾】スマホ自爆を完全に防ぐ安全ID生成
const safeUUID = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
};

const DEFAULT_GOALS: UserGoals = { calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 70 };

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [weightHistory, setWeightHistory] = useState<WeightRecord[]>([]);
  const [goals, setGoals] = useState<UserGoals>(DEFAULT_GOALS);
  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isWeightModalOpen, setIsWeightModalOpen] = useState(false);
  const [modalWeight, setModalWeight] = useState('');
  const [isSendingChat, setIsSendingChat] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const w = localStorage.getItem('workouts'), m = localStorage.getItem('meals'), wg = localStorage.getItem('weight_history'), g = localStorage.getItem('user_goals'), r = localStorage.getItem('reminders_enabled'), c = localStorage.getItem('chat_messages');
      if (w) setWorkouts(JSON.parse(w));
      if (m) setMeals(JSON.parse(m));
      if (wg) setWeightHistory(JSON.parse(wg));
      if (g) setGoals({ ...DEFAULT_GOALS, ...JSON.parse(g) });
      if (r) setRemindersEnabled(JSON.parse(r));
      if (c) setChatMessages(JSON.parse(c));
    } catch (e) { console.error(e); }
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    localStorage.setItem('workouts', JSON.stringify(workouts));
    localStorage.setItem('meals', JSON.stringify(meals));
    localStorage.setItem('weight_history', JSON.stringify(weightHistory));
    localStorage.setItem('user_goals', JSON.stringify(goals));
    localStorage.setItem('reminders_enabled', JSON.stringify(remindersEnabled));
    localStorage.setItem('chat_messages', JSON.stringify(chatMessages));
  }, [workouts, meals, weightHistory, goals, remindersEnabled, chatMessages, isLoaded]);

  const handleSendMessage = async (text: string, images: string[]) => {
    if (!text.trim() && images.length === 0) return;
    const userMsg: ChatMessage = { id: safeUUID(), role: 'user', text, images, timestamp: new Date().toISOString() };
    setChatMessages(prev => [...prev, userMsg]);
    setIsSendingChat(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const response = await fetch('/api/chat-trainer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ message: text, images, workouts: todayWorkout ? [todayWorkout] : [], meals: todayMeals, userData: { weight: currentWeight || 0, targetWeight: goals.targetWeight, calories: goals.calories, protein: goals.protein, fat: goals.fat, carbs: goals.carbs } })
      });
      const data = await response.json();
      setChatMessages(prev => [...prev, { id: safeUUID(), role: 'assistant', text: data?.text || 'エラーが発生しました。', exercises: Array.isArray(data?.exercises) ? data.exercises : [], timestamp: new Date().toISOString() }]);
    } catch (error: any) {
      if (error.name !== 'AbortError') alert('AIとの通信に失敗しました。');
    } finally { setIsSendingChat(false); abortControllerRef.current = null; }
  };

  const today = format(new Date(), 'yyyy-MM-dd');
  const todayMeals = useMemo(() => meals.filter(m => m.date === today), [meals, today]);
  const todayStats = useMemo(() => todayMeals.reduce((acc, m) => ({ calories: acc.calories + (Number(m.calories) || 0), protein: acc.protein + (Number(m.protein) || 0), fat: acc.fat + (Number(m.fat) || 0), carbs: acc.carbs + (Number(m.carbs) || 0) }), { calories: 0, protein: 0, fat: 0, carbs: 0 }), [todayMeals]);
  const todayWorkout = useMemo(() => workouts.find(w => w.date === today), [workouts, today]);
  const currentWeight = useMemo(() => weightHistory.length ? weightHistory[weightHistory.length - 1].weight : null, [weightHistory]);

  const addWorkout = () => {
    if (todayWorkout) return alert("記録済です");
    setWorkouts([...workouts, { id: safeUUID(), date: today, exercises: [] }]);
    setActiveTab('workout');
  };
  const addExercise = (wid: string, name: string) => setWorkouts(p => p.map(w => w.id !== wid ? w : { ...w, exercises: [...w.exercises, { id: safeUUID(), name, sets: [] }] }));
  const addSet = (wid: string, eid: string, w, r) => setWorkouts(p => p.map(x => x.id !== wid ? x : { ...x, exercises: x.exercises.map(e => e.id !== eid ? e : { ...e, sets: [...e.sets, { id: safeUUID(), weight: w, reps: r }] }) }));
  const deleteExercise = (wid: string, eid: string) => setWorkouts(p => p.map(w => w.id !== wid ? w : { ...w, exercises: w.exercises.filter(e => e.id !== eid) }));
  const deleteSet = (wid: string, eid: string, sid: string) => setWorkouts(p => p.map(w => w.id !== wid ? w : { ...w, exercises: w.exercises.map(e => e.id !== eid ? e : { ...e, sets: e.sets.filter(s => s.id !== sid) }) }));
  const updateSet = (wid: string, eid: string, sid: string, w, r) => setWorkouts(p => p.map(x => x.id !== wid ? x : { ...x, exercises: x.exercises.map(e => e.id !== eid ? e : { ...e, sets: e.sets.map(s => s.id !== sid ? s : { ...s, weight: w, reps: r }) }) }));
  const addMeal = (meal: Omit<Meal, 'id' | 'date'>) => setMeals([...meals, { ...meal, id: safeUUID(), date: today }]);
  const addWeight = (w: number) => { const r = { id: safeUUID(), date: today, weight: w }, i = weightHistory.findIndex(x => x.date === today); if (i > -1) { const u = [...weightHistory]; u[i] = r; setWeightHistory(u); } else { setWeightHistory([...weightHistory, r]); } };

  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans selection:bg-lime-400 selection:text-black">
      <div className="max-w-md mx-auto min-h-screen flex flex-col relative px-5 pt-6 bg-[#0a0a0a]">
        <main className="flex-1">
          <AnimatePresence mode="wait">
            <motion.div key={activeTab} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.2 }} >
              {activeTab === 'dashboard' && <SectionDashboard todayStats={todayStats} goals={goals} weightHistory={weightHistory} today={today} todayWorkout={todayWorkout} todayMeals={todayMeals} currentWeight={currentWeight} addWeight={addWeight} setActiveTab={setActiveTab} openWeightModal={() => setIsWeightModalOpen(true)} />}
              {activeTab === 'workout' && <SectionWorkout todayWorkout={todayWorkout} addWorkout={addWorkout} addExercise={addExercise} addSet={addSet} today={today} deleteExercise={deleteExercise} deleteSet={deleteSet} updateSet={updateSet} setActiveTab={setActiveTab} />}
              {activeTab === 'diet' && <SectionDiet todayMeals={todayMeals} addMeal={addMeal} deleteMeal={(id) => setMeals(prev => prev.filter(m => m.id !== id))} goals={goals} />}
              {activeTab === 'analysis' && <SectionAnalysis weightHistory={weightHistory} meals={meals} workouts={workouts} addWeight={addWeight} today={today} openWeightModal={() => setIsWeightModalOpen(true)} />}
              {activeTab === 'aitrainer' && <SectionAITrainer chatMessages={chatMessages} setChatMessages={setChatMessages} currentWeight={currentWeight} goals={goals} today={today} todayWorkout={todayWorkout} setWorkouts={setWorkouts} setActiveTab={setActiveTab} isSending={isSendingChat} handleSendMessage={handleSendMessage} handleCancelMessage={() => abortControllerRef.current?.abort()} />}
              {activeTab === 'settings' && <SectionSettings goals={goals} setGoals={setGoals} requestNotificationPermission={requestNotificationPermission} />}
            </motion.div>
          </AnimatePresence>
        </main>
        <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-zinc-950/80 backdrop-blur-xl border-t border-zinc-900 px-6 py-4 flex items-center justify-between z-50">
          <button onClick={() => setActiveTab('dashboard')} className={`flex flex-col items-center gap-1 ${activeTab === 'dashboard' ? 'text-lime-400' : 'text-zinc-600'}`}><Activity size={24} /><span className="text-[10px] font-bold">ホーム</span></button>
          <button onClick={() => setActiveTab('workout')} className={`flex flex-col items-center gap-1 ${activeTab === 'workout' ? 'text-lime-400' : 'text-zinc-600'}`}><Dumbbell size={24} /><span className="text-[10px] font-bold">ログ</span></button>
          <button onClick={() => setActiveTab('diet')} className={`flex flex-col items-center gap-1 ${activeTab === 'diet' ? 'text-lime-400' : 'text-zinc-600'}`}><Utensils size={24} /><span className="text-[10px] font-bold">食事</span></button>
          <button onClick={() => setActiveTab('aitrainer')} className={`flex flex-col items-center gap-1 ${activeTab === 'aitrainer' ? 'text-lime-400' : 'text-zinc-600'}`}><Sparkles size={24} /><span className="text-[10px] font-bold">AI</span></button>
          <button onClick={() => setActiveTab('analysis')} className={`flex flex-col items-center gap-1 ${activeTab === 'analysis' ? 'text-lime-400' : 'text-zinc-600'}`}><BarChart3 size={24} /><span className="text-[10px] font-bold">分析</span></button>
          <button onClick={() => setActiveTab('settings')} className={`flex flex-col items-center gap-1 ${activeTab === 'settings' ? 'text-lime-400' : 'text-zinc-600'}`}><Settings size={24} /><span className="text-[10px] font-bold">設定</span></button>
        </nav>
      </div>
      <AnimatePresence>
        {isWeightModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div onClick={() => setIsWeightModalOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.95, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 20 }} transition={{ type: 'spring', duration: 0.4 }} className="relative w-full max-w-sm bg-zinc-950 border border-zinc-900 rounded-3xl p-6 shadow-2xl z-10" >
              <div className="text-center space-y-4">
                <div className="mx-auto w-12 h-12 bg-lime-400/10 rounded-full flex items-center justify-center text-lime-400"><Activity size={24} /></div>
                <div><h2 className="text-lg font-bold text-white uppercase italic tracking-wider">MEASURE WEIGHT</h2><p className="text-xs text-zinc-500 mt-1">本日の体重(kg)を測定して記録</p></div>
                <form onSubmit={(e) => { e.preventDefault(); const w = parseFloat(modalWeight); if (w && !isNaN(w)) { addWeight(w); setIsWeightModalOpen(false); setModalWeight(''); } }} className="space-y-4 pt-2">
                  <div className="relative">
                    <input type="number" step="0.1" required placeholder="0.0" value={modalWeight} onChange={(e) => setModalWeight(e.target.value)} className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-center text-3xl font-black text-lime-400 placeholder:text-zinc-800 outline-none focus:ring-1 focus:ring-lime-400" autoFocus />
                    <span className="absolute right-4 bottom-4 text-xs font-black text-zinc-500 font-mono">KG</span>
                  </div>
                  <div className="flex gap-2">
                    <button type="submit" className="flex-1 bg-lime-400 text-black py-3 rounded-xl font-bold text-xs shadow-lg shadow-lime-400/10 active:scale-95 transition-all text-center uppercase" > 記録する </button>
                    <button type="button" onClick={() => setIsWeightModalOpen(false)} className="flex-1 bg-zinc-900 text-zinc-450 hover:text-white border border-zinc-900 py-3 rounded-xl font-bold text-xs active:scale-95 transition-all text-center uppercase" > キャンセル </button>
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
