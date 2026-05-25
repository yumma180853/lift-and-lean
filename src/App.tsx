/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  Activity, 
  Utensils, 
  BarChart3, 
  Settings, 
  Dumbbell,
  Sparkles
} from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { 
  UserGoals, 
  WeightRecord, 
  Workout, 
  Meal, 
  ChatMessage, 
  Tab 
} from './types';

import { SectionDashboard } from './components/SectionDashboard';
import { SectionWorkout } from './components/SectionWorkout';
import { SectionDiet } from './components/SectionDiet';
import { SectionAnalysis } from './components/SectionAnalysis';
import { SectionAITrainer } from './components/SectionAITrainer';
import { SectionSettings } from './components/SectionSettings';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 🚨【超重要・真っ白クラッシュ完全防衛盾】
// 一部のスマホやブラウザ環境で「crypto.randomUUID」が使えずに画面が真っ白に自爆するのを200%完璧に防ぐ安全なIDジェネレーター
const safeUUID = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 万が一スマホ側が対応していない場合の無敵の身代わりID生成
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
};

// --- Default State ---

const DEFAULT_GOALS: UserGoals = {
  calories: 2200,
  protein: 150,
  fat: 60,
  carbs: 250,
  targetWeight: 70
};

// --- App Component ---

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [weightHistory, setWeightHistory] = useState<WeightRecord[]>([]);
  const [goals, setGoals] = useState<UserGoals>(DEFAULT_GOALS);
  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  // Custom Interactive Weight input modals
  const [isWeightModalOpen, setIsWeightModalOpen] = useState(false);
  const [modalWeight, setModalWeight] = useState('');

  // Global Chat Controller & sending states
  const [isSendingChat, setIsSendingChat] = useState(false);
  const abortControllerRef = React.useRef<AbortController | null>(null);

  // Persistence with extreme defense against undefined/malformed parameters
  useEffect(() => {
    try {
      const savedWorkouts = localStorage.getItem('workouts');
      const savedMeals = localStorage.getItem('meals');
      const savedWeight = localStorage.getItem('weight_history');
      const savedGoals = localStorage.getItem('user_goals');
      const savedReminders = localStorage.getItem('reminders_enabled');
      const savedChat = localStorage.getItem('chat_messages');

      if (savedWorkouts) {
        const parsed = JSON.parse(savedWorkouts);
        if (Array.isArray(parsed)) setWorkouts(parsed);
      }
      if (savedMeals) {
        const parsed = JSON.parse(savedMeals);
        if (Array.isArray(parsed)) setMeals(parsed);
      }
      if (savedWeight) {
        const parsed = JSON.parse(savedWeight);
        if (Array.isArray(parsed)) setWeightHistory(parsed);
      }
      if (savedGoals) {
        const parsed = JSON.parse(savedGoals);
        setGoals({ ...DEFAULT_GOALS, ...parsed });
      }
      if (savedReminders) setRemindersEnabled(JSON.parse(savedReminders));
      if (savedChat) {
        const parsed = JSON.parse(savedChat);
        if (Array.isArray(parsed)) setChatMessages(parsed);
      }
    } catch (e) {
      console.error("Localstorage parsing error", e);
    }
    
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

  // Clean request cancellation on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Notification Logic
  useEffect(() => {
    if (remindersEnabled && isLoaded) {
      const today = format(new Date(), 'yyyy-MM-dd');
      const hasWeightToday = weightHistory.some(w => w.date === today);
      
      if (!hasWeightToday && Notification.permission === 'granted') {
        const hour = new Date().getHours();
        if (hour >= 6 && hour <= 11) {
          new Notification('LIFT & LEAN', {
            body: 'おはようございます！今日の体重を記録しましょう。',
            icon: '/favicon.ico'
          });
        }
      }
    }
  }, [remindersEnabled, weightHistory, isLoaded]);

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) {
      alert('このブラウザは通知に対応していません。');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setRemindersEnabled(true);
    } else {
      alert('通知設定を許可してください。');
    }
  };

  // Chat-trainer sender flow with AbortController
  const handleSendMessage = async (text: string, images: string[]) => {
    if (!text.trim() && images.length === 0) return;

    const userMsg: ChatMessage = {
      id: safeUUID(), // 🚨安全なIDに差し替え
      role: 'user',
      text,
      images,
      timestamp: new Date().toISOString()
    };

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
          message: userMsg.text,
          images: userMsg.images,
          workouts: todayWorkout ? [todayWorkout] : [],
          meals: todayMeals,
          userData: {
            weight: currentWeight || 0,
            targetWeight: goals.targetWeight,
            calories: goals.calories,
            protein: goals.protein,
            fat: goals.fat,
            carbs: goals.carbs
          }
        }),
      });

      const data = await response.json();
      
      const assistantMsg: ChatMessage = {
        id: safeUUID(), // 🚨安全なIDに差し替え
        role: 'assistant',
        text: data?.text || 'お返事の作成中にエラーが発生しました。',
        exercises: Array.isArray(data?.exercises) ? data.exercises : [],
        timestamp: new Date().toISOString()
      };

      setChatMessages(prev => [...prev, assistantMsg]);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        const cancelMsg: ChatMessage = {
          id: safeUUID(), // 🚨安全なIDに差し替え
          role: 'assistant',
          text: '回答の生成が中断されました。',
          timestamp: new Date().toISOString()
        };
        setChatMessages(prev => [...prev, cancelMsg]);
      } else {
        console.error(error);
        alert('AIとの通信に失敗しました。');
      }
    } finally {
      setIsSendingChat(false);
      abortControllerRef.current = null;
    }
  };

  const handleCancelMessage = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  // --- Computed Stats ---

  const today = format(new Date(), 'yyyy-MM-dd');
  
  const todayMeals = useMemo(() => 
    meals.filter(m => m.date === today),
  [meals, today]);

  const todayStats = useMemo(() => {
    return todayMeals.reduce((acc, meal) => ({
      calories: acc.calories + (Number(meal.calories) || 0),
      protein: acc.protein + (Number(meal.protein) || 0),
      fat: acc.fat + (Number(meal.fat) || 0),
      carbs: acc.carbs + (Number(meal.carbs) || 0),
    }), { calories: 0, protein: 0, fat: 0, carbs: 0 });
  }, [todayMeals]);

  const todayWorkout = useMemo(() => 
    workouts.find(w => w.date === today),
  [workouts, today]);

  const currentWeight = useMemo(() => {
    if (weightHistory.length === 0) return null;
    return weightHistory[weightHistory.length - 1].weight;
  }, [weightHistory]);

  // --- Actions ---

  const addWorkout = () => {
    const newWorkout: Workout = {
      id: safeUUID(), // 🚨安全なIDに差し替え
      date: today,
      exercises: []
    };
    if (todayWorkout) {
      alert("今日のトレーニングは既に記録されています。既存のものに追加してください。");
      return;
    }
    setWorkouts([...workouts, newWorkout]);
    setActiveTab('workout');
  };

  const addExercise = (workoutId: string, name: string) => {
    setWorkouts(prev => prev.map(w => {
      if (w.id !== workoutId) return w;
      return {
        ...w,
        exercises: [...w.exercises, { id: safeUUID(), name, sets: [] }] // 🚨安全なIDに差し替え
      };
    }));
  };

  const addSet = (workoutId: string, exerciseId: string, weight: number, reps: number) => {
    setWorkouts(prev => prev.map(w => {
      if (w.id !== workoutId) return w;
      return {
        ...w,
        exercises: w.exercises.map(e => {
          if (e.id !== exerciseId) return e;
          return {
            ...e,
            sets: [...e.sets, { id: safeUUID(), weight, reps }] // 🚨安全なIDに差し替え
          };
        })
      };
    }));
  };

  const deleteExercise = (workoutId: string, exerciseId: string) => {
    setWorkouts(prev => prev.map(w => {
      if (w.id !== workoutId) return w;
      return {
        ...w,
        exercises: w.exercises.filter(e => e.id !== exerciseId)
      };
    }));
  };

  const deleteSet = (workoutId: string, exerciseId: string, setId: string) => {
    setWorkouts(prev => prev.map(w => {
      if (w.id !== workoutId) return w;
      return {
        ...w,
        exercises: w.exercises.map(e => {
          if (e.id !== exerciseId) return e;
          return {
            ...e,
            sets: e.sets.filter(s => s.id !== setId)
          };
        })
      };
    }));
  };

  const updateSet = (workoutId: string, exerciseId: string, setId: string, weight: number, reps: number) => {
    setWorkouts(prev => prev.map(w => {
      if (w.id !== workoutId) return w;
      return {
        ...w,
        exercises: w.exercises.map(e => {
          if (e.id !== exerciseId) return e;
          return {
            ...e,
            sets: e.sets.map(s => {
              if (s.id !== setId) return s;
              return { ...s, weight, reps };
            })
          };
        })
      };
    }));
  };

  const addMeal = (meal: Omit<Meal, 'id' | 'date'>) => {
    const newMeal: Meal = {
      ...meal,
      id: safeUUID(), // 🚨安全なIDに差し替え
      date: today,
    };
    setMeals([...meals, newMeal]);
  };

  const addWeight = (weight: number) => {
    const newRecord: WeightRecord = {
      id: safeUUID(), // 🚨安全なIDに差し替え
      date: today,
      weight
    };
    const existingIndex = weightHistory.findIndex(w => w.date === today);
    if (existingIndex > -1) {
      const updated = [...weightHistory];
      updated[existingIndex] = newRecord;
      setWeightHistory(updated);
    } else {
      setWeightHistory([...weightHistory, newRecord]);
    }
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans selection:bg-lime-400 selection:text-black">
      <div className="max-w-md mx-auto min-h-screen flex flex-col relative px-5 pt-6 bg-[#0a0a0a]">
        
        <main className="flex-1">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === 'dashboard' && (
                <SectionDashboard 
                  todayStats={todayStats}
                  goals={goals}
                  weightHistory={weightHistory}
                  today={today}
                  todayWorkout={todayWorkout}
                  todayMeals={todayMeals}
                  currentWeight={currentWeight}
                  addWeight={addWeight}
                  setActiveTab={setActiveTab}
                  openWeightModal={() => setIsWeightModalOpen(true)}
                />
              )}
              {activeTab === 'workout' && (
                <SectionWorkout 
                  todayWorkout={todayWorkout}
                  addWorkout={addWorkout}
                  addExercise={addExercise}
                  addSet={addSet}
                  today={today}
                  deleteExercise={deleteExercise}
                  deleteSet={deleteSet}
                  updateSet={updateSet}
                  setActiveTab={setActiveTab}
                />
              )}
              {activeTab === 'diet' && (
                <SectionDiet 
                  todayMeals={todayMeals}
                  addMeal={addMeal}
                  deleteMeal={(id) => setMeals(prev => prev.filter(m => m.id !== id))}
                  goals={goals}
                />
              )}
              {activeTab === 'analysis' && (
                <SectionAnalysis 
                  weightHistory={weightHistory}
                  meals={meals}
                  workouts={workouts}
                  addWeight={addWeight}
                  today={today}
                  openWeightModal={() => setIsWeightModalOpen(true)}
                />
              )}
              {activeTab === 'aitrainer' && (
                <SectionAITrainer 
                  chatMessages={chatMessages}
                  setChatMessages={setChatMessages}
                  currentWeight={currentWeight}
                  goals={goals}
                  today={today}
                  todayWorkout={todayWorkout}
                  setWorkouts={setWorkouts}
                  setActiveTab={setActiveTab}
                  isSending={isSendingChat}
                  handleSendMessage={handleSendMessage}
                  handleCancelMessage={handleCancelMessage}
                />
              )}
              {activeTab === 'settings' && (
                <SectionSettings 
                  goals={goals}
                  setGoals={setGoals}
                  requestNotificationPermission={requestNotificationPermission}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </main>

        <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-zinc-950/80 backdrop-blur-xl border-t border-zinc-900 px-6 py-4 flex items-center justify-between z-50">
          <NavItem active={activeTab === 'dashboard'} icon={<Activity />} label="ホーム" onClick={() => setActiveTab('dashboard')} />
          <NavItem active={activeTab === 'workout'} icon={<Dumbbell />} label="ログ" onClick={() => setActiveTab('workout')} />
          <NavItem active={activeTab === 'diet'} icon={<Utensils />} label="食事" onClick={() => setActiveTab('diet')} />
          <NavItem active={activeTab === 'aitrainer'} icon={<Sparkles />} label="AI" onClick={() => setActiveTab('aitrainer')} />
          <NavItem active={activeTab === 'analysis'} icon={<BarChart3 />} label="分析" onClick={() => setActiveTab('analysis')} />
          <NavItem active={activeTab === 'settings'} icon={<Settings />} label="設定" onClick={() => setActiveTab('settings')} />
        </nav>
      </div>

      <AnimatePresence>
        {isWeightModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              onClick={() => setIsWeightModalOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              transition={{ type: 'spring', duration: 0.4 }}
              className="relative w-full max-w-sm bg-zinc-950 border border-zinc-900 rounded-3xl p-6 shadow-2xl z-10"
            >
              <div className="text-center space-y-4">
                <div className="mx-auto w-12 h-12 bg-lime-400/10 rounded-full flex items-center justify-center text-lime-400">
                  <Activity size={24} />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white uppercase italic tracking-wider">MEASURE WEIGHT</h2>
                  <p className="text-xs text-zinc-500 mt-1">本日の体重(kg)を測定して記録</p>
                </div>
                
                <form onSubmit={(e) => {
                  e.preventDefault();
                  const w = parseFloat(modalWeight);
                  if (w && !isNaN(w)) {
                    addWeight(w);
                    setIsWeightModalOpen(false);
                    setModalWeight('');
                  }
                }} className="space-y-4 pt-2">
                  <div className="relative">
                    <input 
                      type="number" 
                      step="0.1"
                      required
                      placeholder="0.0" 
                      value={modalWeight}
                      onChange={(e) => setModalWeight(e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-center text-3xl font-black text-lime-400 placeholder:text-zinc-800 outline-none focus:ring-1 focus:ring-lime-400"
                      autoFocus
                    />
                    <span className="absolute right-4 bottom-4 text-xs font-black text-zinc-500 font-mono">KG</span>
                  </div>
                  
                  <div className="flex gap-2">
                    <button 
                      type="submit"
                      className="flex-1 bg-lime-400 text-black py-3 rounded-xl font-bold text-xs shadow-lg shadow-lime-400/10 active:scale-95 transition-all text-center uppercase"
                    >
                      記録する
                    </button>
                    <button 
                      type="button"
                      onClick={() => setIsWeightModalOpen(false)}
                      className="flex-1 bg-zinc-900 text-zinc-450 hover:text-white border border-zinc-900 py-3 rounded-xl font-bold text-xs active:scale-95 transition-all text-center uppercase"
                    >
                      キャンセル
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style>{`
        body { font-family: 'Inter', system-ui, sans-serif; }
        ::-webkit-scrollbar { display: none; }
        input[type='number']::-webkit-inner-spin-button, 
        input[type='number']::-webkit-outer-spin-button { 
          -webkit-appearance: none; 
          margin: 0; 
        }
      `}</style>
    </div>
  );
}

function NavItem({ active, icon, label, onClick }: { active: boolean, icon: React.ReactNode, label: string, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 transition-all duration-300",
        active ? "text-lime-400 scale-110" : "text-zinc-600 hover:text-zinc-400"
      )}
    >
      <div className={cn(
        "p-1 rounded-lg transition-colors",
        active && "bg-lime-400/10 shadow-[0_0_15px_rgba(217,255,0,0.1)]"
      )}>
        {React.cloneElement(icon as React.ReactElement, { size: 24, strokeWidth: active ? 2.5 : 2 })}
      </div>
      <span className="text-[10px] font-bold uppercase tracking-tight">{label}</span>
    </
