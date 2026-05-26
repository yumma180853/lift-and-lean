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

// 🚨【真っ白クラッシュ完全防衛盾】スマホ自爆を完璧に防ぐ安全IDジェネレーター
const safeUUID = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
};

const DEFAULT_GOALS: UserGoals = { calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 70 };

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [weightHistory, setWeightHistory] = useState<WeightRecord[]>([]);
  const [goals, setGoals] = useState<UserGoals>(DEFAULT_GOALS);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isWeightModalOpen, setIsWeightModalOpen] = useState(false);
  const [modalWeight, setModalWeight] = useState('');
  const [isSendingChat, setIsSendingChat] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const w = localStorage.getItem('workouts');
      const m = localStorage.getItem('meals');
      const wg = localStorage.getItem('weight_history');
      const g = localStorage.getItem('user_goals');
      const c = localStorage.getItem('chat_messages');
      if (w) setWorkouts(JSON.parse(w));
      if (m) setMeals(JSON.parse(m));
      if (wg) setWeightHistory(JSON.parse(wg));
      if (g) setGoals({ ...DEFAULT_GOALS, ...JSON.parse(g) });
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
    localStorage.setItem('chat_messages', JSON.stringify(chatMessages));
  }, [workouts, meals, weightHistory, goals, chatMessages, isLoaded]);

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
        body: JSON.stringify({
          message: text,
          images,
          workouts: todayWorkout ? [todayWorkout] : [],
          meals: todayMeals,
          userData: { weight: currentWeight || 0, targetWeight: goals.targetWeight, calories: goals.calories, protein: goals.protein, fat: goals.fat, carbs: goals.carbs }
        })
      });
      const data = await response.json();
      setChatMessages(prev => [...prev, {
        id: safeUUID(),
        role: 'assistant',
        text: data?.text || 'お返事の作成中にエラーが発生しました。',
        exercises: Array.isArray(data?.exercises) ? data.exercises : [],
        timestamp: new Date().toISOString()
      }]);
    } catch (error: any) {
      if (error.name !== 'AbortError') alert('AIとの通信に失敗しました。');
    } finally { setIsSendingChat(false); abortControllerRef.current = null; }
  };

  const today = format(new Date(), 'yyyy-MM-dd');
  const todayMeals = useMemo(() => meals.filter(m => m.date === today), [meals, today]);
  const todayStats = useMemo(() => todayMeals.reduce((acc, m) => ({
    calories: acc.calories + (Number(m.calories) || 0),
    protein: acc.protein + (Number(m.protein) || 0),
    fat: acc.fat + (Number(m.fat) || 0),
    carbs: acc.carbs + (Number(m.carbs) || 0)
  }), { calories: 0, protein: 0, fat: 0, carbs: 0 }), [todayMeals]);
  const todayWorkout = useMemo(() => workouts.find(w => w.date === today), [workouts, today]);
  const currentWeight = useMemo(() => weightHistory.length ? weightHistory[weightHistory.length - 1].weight : null, [weightHistory]);

  const addWorkout = () => {
    if (todayWorkout) return alert("記録済です");
    setWorkouts([...workouts, { id: safeUUID(), date: today, exercises: [] }]);
    setActiveTab('workout');
  };
  const addExercise = (wid: string, name: string) => setWorkouts(prev => prev.map(w => w.id !== wid ? w : { ...w, exercises: [...w.exercises, { id: safeUUID(), name, sets: [] }] }));
  const addSet = (wid: string, eid: string, weight: number, reps: number) => setWorkouts(prev => prev.map(w => w.id !== wid ? w : { ...w, exercises: w.exercises.map(e => e.id !== eid ? e : { ...e, sets: [...e.sets, { id: safeUUID(), weight, reps }] }) }));
  const deleteExercise = (wid: string, exerciseId: string) => setWorkouts(prev => prev.map(w => w.id !== wid ? w : { ...w, exercises: w.exercises.filter(e => e.id !== exerciseId) }));
  const deleteSet = (workoutId: string, exerciseId: string, setId: string) => setWorkouts(prev => prev.map(w => w.id !== workoutId ? w : { ...w, exercises: w.exercises.map(e => e.id !== exerciseId ? e : { ...e, sets: e.sets.filter(s => s.id !== setId) }) }));
  const updateSet = (wid: string, eid: string, sid: string, weight: number, reps: number) => setWorkouts(prev => prev.map(w => w.id !== wid ? w : { ...w, exercises: w.exercises.map(e => e.id !== eid ? e : { ...e, sets: e.sets.map(s => s.id !== sid ? s : { ...s, weight, reps }) }) }));
  const addMeal = (meal: Omit<Meal, 'id' | 'date'>) => setMeals([...meals, { ...meal, id: safeUUID(), date: today }]);
  const addWeight = (w: number) => {
    const r = { id: safeUUID(), date: today, weight: w };
    const i = weightHistory.findIndex(x => x.date === today);
    if (i > -1) { const u = [...weightHistory]; u[i] = r; setWeightHistory(u); } else { setWeightHistory([...weightHistory, r]); }
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans selection:bg-lime-400 selection:text-black">
      <div className="max-w-md mx-auto min-h-screen flex flex-col relative px-5 pt-6 bg-[#0a0a0a]">
        <main className="flex-1">
          <AnimatePresence mode="wait">
            <motion.div key={activeTab} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.2 }} >
              {activeTab === 'dashboard' && <SectionDashboard todayStats={todayStats} goals={goals} weightHistory={weightHistory} today={today} todayWorkout={todayWorkout} todayMeals={todayMeals} currentWeight={currentWeight} addWeight={addWeight} setActiveTab={setActiveTab} openWeightModal={() => setIsWeightModalOpen(true)} />}
              {activeTab ===
