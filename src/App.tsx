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
  Plus, 
  Trash2, 
  ChevronRight, 
  Weight,
  Flame,
  Dumbbell,
  Target,
  History,
  TrendingUp,
  Calendar,
  Camera,
  Loader2,
  Bell,
  BellRing,
  MessageSquare,
  Send,
  ImagePlus,
  Sparkles
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  BarChart, 
  Bar,
  Cell,
  PieChart,
  Pie
} from 'recharts';
import { format, subDays, isSameDay, parseISO } from 'date-fns';
import { ja } from 'date-fns/locale';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---

interface Set {
  id: string;
  reps: number;
  weight: number;
}

interface Exercise {
  id: string;
  name: string;
  sets: Set[];
}

interface Workout {
  id: string;
  date: string;
  exercises: Exercise[];
}

interface Meal {
  id: string;
  date: string;
  name: string;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

interface WeightRecord {
  id: string;
  date: string;
  weight: number;
}

interface UserGoals {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  targetWeight: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images?: string[];
  exercises?: { name: string; reps: number; sets: number }[];
  timestamp: string;
}

type Tab = 'dashboard' | 'workout' | 'diet' | 'analysis' | 'aitrainer' | 'settings';

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

  // Persistence
  useEffect(() => {
    const savedWorkouts = localStorage.getItem('workouts');
    const savedMeals = localStorage.getItem('meals');
    const savedWeight = localStorage.getItem('weight_history');
    const savedGoals = localStorage.getItem('user_goals');
    const savedReminders = localStorage.getItem('reminders_enabled');
    const savedChat = localStorage.getItem('chat_messages');

    if (savedWorkouts) setWorkouts(JSON.parse(savedWorkouts));
    if (savedMeals) setMeals(JSON.parse(savedMeals));
    if (savedWeight) setWeightHistory(JSON.parse(savedWeight));
    if (savedGoals) setGoals(JSON.parse(savedGoals));
    if (savedReminders) setRemindersEnabled(JSON.parse(savedReminders));
    if (savedChat) setChatMessages(JSON.parse(savedChat));
    
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

  // Notification Logic
  useEffect(() => {
    if (remindersEnabled && isLoaded) {
      const today = format(new Date(), 'yyyy-MM-dd');
      const hasWeightToday = weightHistory.some(w => w.date === today);
      
      if (!hasWeightToday && Notification.permission === 'granted') {
        const hour = new Date().getHours();
        // Morning reminder (6 AM - 11 AM)
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

  // --- Computed Stats ---

  const today = format(new Date(), 'yyyy-MM-dd');
  
  const todayMeals = useMemo(() => 
    meals.filter(m => m.date === today),
  [meals, today]);

  const todayStats = useMemo(() => {
    return todayMeals.reduce((acc, meal) => ({
      calories: acc.calories + meal.calories,
      protein: acc.protein + meal.protein,
      fat: acc.fat + meal.fat,
      carbs: acc.carbs + meal.carbs,
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
      id: crypto.randomUUID(),
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
        exercises: [...w.exercises, { id: crypto.randomUUID(), name, sets: [] }]
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
            sets: [...e.sets, { id: crypto.randomUUID(), weight, reps }]
          };
        })
      };
    }));
  };

  const addMeal = (meal: Omit<Meal, 'id' | 'date'>) => {
    const newMeal: Meal = {
      ...meal,
      id: crypto.randomUUID(),
      date: today,
    };
    setMeals([...meals, newMeal]);
  };

  const addWeight = (weight: number) => {
    const newRecord: WeightRecord = {
      id: crypto.randomUUID(),
      date: today,
      weight
    };
    // Update if exists for today or add new
    const existingIndex = weightHistory.findIndex(w => w.date === today);
    if (existingIndex > -1) {
      const updated = [...weightHistory];
      updated[existingIndex] = newRecord;
      setWeightHistory(updated);
    } else {
      setWeightHistory([...weightHistory, newRecord]);
    }
  };

  // --- Sub-components (Sections) ---

  const SectionDashboard = () => {
    const pfcData = [
      { name: 'タンパク質', value: todayStats.protein * 4, goal: goals.protein * 4, color: '#d9ff00' },
      { name: '脂質', value: todayStats.fat * 9, goal: goals.fat * 9, color: '#ff3d00' },
      { name: '炭水化物', value: todayStats.carbs * 4, goal: goals.carbs * 4, color: '#00e5ff' },
    ];

    const hasWeightToday = weightHistory.some(w => w.date === today);

    return (
      <div className="space-y-6 pb-20">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">HELLO CHAMPION</h1>
            <p className="text-gray-400 text-sm">{format(new Date(), 'MM月dd日 (E)', { locale: ja })}</p>
          </div>
          <div className="w-12 h-12 bg-lime-400 rounded-full flex items-center justify-center">
            <Activity className="text-black" size={24} />
          </div>
        </header>

        {/* Weight Reminder Alert */}
        {!hasWeightToday && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            className="bg-rose-500/10 border border-rose-500/50 rounded-2xl p-4 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-rose-500 text-white rounded-full flex items-center justify-center animate-bounce">
                <BellRing size={16} />
              </div>
              <div>
                <p className="text-white text-xs font-bold">体重が未入力です</p>
                <p className="text-rose-200 text-[10px]">毎朝の記録が目標達成の鍵です！</p>
              </div>
            </div>
            <button 
              onClick={() => {
                const w = prompt('現在の体重(kg)');
                if (w) addWeight(parseFloat(w));
              }}
              className="bg-rose-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold"
            >
              今すぐ入力
            </button>
          </motion.div>
        )}

        {/* Calories Card */}
        <div className="bg-zinc-900 rounded-3xl p-6 border border-zinc-800 shadow-xl relative overflow-hidden">
          <div className="relative z-10">
            <div className="flex justify-between items-start mb-4">
              <div>
                <span className="text-xs font-bold text-lime-400 uppercase tracking-widest">CALORIES</span>
                <div className="flex items-baseline gap-1">
                  <h2 className="text-4xl font-black text-white">{todayStats.calories}</h2>
                  <span className="text-gray-500 font-medium">/ {goals.calories} kcal</span>
                </div>
              </div>
              <Flame className="text-orange-500 animate-pulse" size={32} />
            </div>
            
            <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
              <motion.div 
                className="h-full bg-lime-400" 
                initial={{ width: 0 }}
                animate={{ width: `${Math.min((todayStats.calories / goals.calories) * 100, 100)}%` }}
                transition={{ duration: 1, ease: 'easeOut' }}
              />
            </div>
            
            <div className="mt-4 grid grid-cols-3 gap-4">
              {pfcData.map(item => (
                <div key={item.name}>
                  <div className="text-[10px] text-gray-400 uppercase font-bold mb-1">{item.name}</div>
                  <div className="h-1 w-full bg-zinc-800 rounded-full mb-1">
                    <div 
                      className="h-full rounded-full" 
                      style={{ 
                        backgroundColor: item.color, 
                        width: `${Math.min((item.value / item.goal) * 100, 100)}%` 
                      }} 
                    />
                  </div>
                  <div className="text-xs font-mono text-white">{(item.value / (item.name === '脂質' ? 9 : 4)).toFixed(0)}g</div>
                </div>
              ))}
            </div>
          </div>
          <div className="absolute top-[-20px] right-[-20px] opacity-10 blur-3xl w-40 h-40 bg-lime-400 rounded-full" />
        </div>

        {/* Action Grid */}
        <div className="grid grid-cols-2 gap-4">
          <div 
            onClick={() => setActiveTab('workout')}
            className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 flex flex-col gap-3 cursor-pointer hover:border-lime-400 transition-colors"
          >
            <div className="w-10 h-10 bg-indigo-500/20 text-indigo-400 rounded-xl flex items-center justify-center">
              <Dumbbell size={20} />
            </div>
            <div>
              <div className="text-sm font-bold text-white">トレーニング</div>
              <div className="text-xs text-gray-500">{todayWorkout ? `${todayWorkout.exercises.length} 種目` : '未実施'}</div>
            </div>
          </div>
          <div 
            onClick={() => setActiveTab('diet')}
            className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 flex flex-col gap-3 cursor-pointer hover:border-lime-400 transition-colors"
          >
            <div className="w-10 h-10 bg-orange-500/20 text-orange-400 rounded-xl flex items-center justify-center">
              <Utensils size={20} />
            </div>
            <div>
              <div className="text-sm font-bold text-white">食事記録</div>
              <div className="text-xs text-gray-500">{todayMeals.length} 回の食事</div>
            </div>
          </div>
        </div>

        {/* Current Weight */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-rose-500/20 text-rose-400 rounded-xl flex items-center justify-center">
              <Weight size={20} />
            </div>
            <div>
              <div className="text-sm font-bold text-white">現在の体重</div>
              <div className="text-xs text-gray-500">目標: {goals.targetWeight} kg</div>
            </div>
          </div>
          <div className="text-xl font-black text-white">{currentWeight ? `${currentWeight} kg` : '-- kg'}</div>
        </div>
      </div>
    );
  };

  const SectionWorkout = () => {
    const [isAdding, setIsAdding] = useState(false);
    const [tempExercise, setTempExercise] = useState('');

    const currentWorkout = todayWorkout;

    return (
      <div className="space-y-6 pb-24">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-bold text-white">TRAINING LOG</h2>
          {!currentWorkout && (
            <button 
              onClick={addWorkout}
              className="bg-lime-400 text-black px-4 py-2 rounded-full font-bold text-xs flex items-center gap-1 shadow-lg shadow-lime-400/20"
            >
              <Plus size={16} /> 記録を開始
            </button>
          )}
        </div>

        {currentWorkout ? (
          <div className="space-y-6">
            <div className="flex items-center gap-2 text-zinc-500 text-sm mb-4">
              <Calendar size={16} />
              <span>{format(parseISO(currentWorkout.date), 'yyyy年MM月dd日')}</span>
            </div>

            {currentWorkout.exercises.map((exercise) => (
              <div key={exercise.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
                <div className="p-4 bg-zinc-800/50 flex justify-between items-center">
                  <h3 className="font-bold text-white">{exercise.name}</h3>
                  <button 
                    onClick={() => {
                      const weightStr = prompt('重量 (kg)');
                      const repsStr = prompt('レップ数');
                      if (weightStr && repsStr) {
                        addSet(currentWorkout.id, exercise.id, parseFloat(weightStr), parseInt(repsStr));
                      }
                    }}
                    className="text-[10px] font-black uppercase text-lime-400 border border-lime-400/30 px-2 py-1 rounded"
                  >
                    セットを追加
                  </button>
                </div>
                <div className="p-4 space-y-2">
                  {exercise.sets.length > 0 ? (
                    <div className="grid grid-cols-4 text-[10px] font-bold text-zinc-500 uppercase pb-2 border-b border-zinc-800">
                      <div>SET</div>
                      <div>KG</div>
                      <div>REPS</div>
                      <div className="text-right">VOL</div>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-600 italic">セットを追加してください</p>
                  )}
                  {exercise.sets.map((set, idx) => (
                    <div key={set.id} className="grid grid-cols-4 text-xs py-1 border-b border-zinc-800/50 last:border-0 items-center">
                      <div className="text-white font-mono">{idx + 1}</div>
                      <div className="text-white font-mono">{set.weight}</div>
                      <div className="text-white font-mono">{set.reps}</div>
                      <div className="text-right text-lime-400 font-bold font-mono">{(set.weight * set.reps).toFixed(0)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {!isAdding ? (
              <button 
                onClick={() => setIsAdding(true)}
                className="w-full py-4 border-2 border-dashed border-zinc-800 rounded-2xl text-zinc-500 text-sm font-bold flex items-center justify-center gap-2 hover:bg-zinc-900 transition-colors"
              >
                <Plus size={18} /> 種目を追加
              </button>
            ) : (
              <div className="bg-zinc-900 p-4 rounded-2xl border border-lime-400/50 space-y-4">
                <input 
                  type="text" 
                  placeholder="種目名 (例: ベンチプレス)" 
                  value={tempExercise}
                  onChange={(e) => setTempExercise(e.target.value)}
                  className="w-full bg-zinc-800 border-0 rounded-lg p-3 text-white placeholder:text-zinc-600 focus:ring-1 focus:ring-lime-400 text-sm outline-none"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button 
                    onClick={() => {
                      if (tempExercise.trim()) {
                        addExercise(currentWorkout.id, tempExercise);
                        setTempExercise('');
                        setIsAdding(false);
                      }
                    }}
                    className="flex-1 bg-lime-400 text-black font-bold py-2 rounded-lg text-sm"
                  >
                    OK
                  </button>
                  <button 
                    onClick={() => setIsAdding(false)}
                    className="flex-1 bg-zinc-800 text-white font-bold py-2 rounded-lg text-sm"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="h-[40vh] flex flex-col items-center justify-center text-center space-y-4 p-8">
            <div className="w-16 h-16 bg-zinc-900 rounded-full flex items-center justify-center text-zinc-700">
              <Dumbbell size={32} />
            </div>
            <div>
              <p className="text-white font-bold">今日の記録はありません</p>
              <p className="text-zinc-500 text-sm mt-1">限界を突破しましょう。記録を開始して成果を可視化。改善への一歩を。</p>
            </div>
          </div>
        )}
      </div>
    );
  };

  const SectionDiet = () => {
    const [isAdding, setIsAdding] = useState(false);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [newMeal, setNewMeal] = useState({ name: '', calories: 0, protein: 0, fat: 0, carbs: 0 });
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const handleAdd = () => {
      if (newMeal.name.trim()) {
        addMeal(newMeal);
        setNewMeal({ name: '', calories: 0, protein: 0, fat: 0, carbs: 0 });
        setIsAdding(false);
      }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setIsAnalyzing(true);
      setIsAdding(true);

      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = reader.result as string;
        try {
          const response = await fetch('/api/analyze-meal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64 }),
          });
          const data = await response.json();
          if (data.error) throw new Error(data.error);
          
          setNewMeal({
            name: data.name,
            calories: data.calories,
            protein: data.protein,
            fat: data.fat,
            carbs: data.carbs
          });
        } catch (error) {
          console.error(error);
          alert('解析に失敗しました。');
        } finally {
          setIsAnalyzing(false);
        }
      };
      reader.readAsDataURL(file);
    };

    return (
      <div className="space-y-6 pb-24">
        <div className="flex justify-between items-center">
          <div className="flex flex-col">
            <h2 className="text-xl font-bold text-white uppercase tracking-tighter">DIET JOURNAL</h2>
            <p className="text-[10px] font-bold text-orange-500 uppercase">Fuel your power</p>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="bg-zinc-800 text-white px-4 py-2 rounded-full font-bold text-xs flex items-center gap-1 border border-zinc-700"
            >
              <Camera size={16} /> AI解析
            </button>
            <button 
              onClick={() => setIsAdding(true)}
              className="bg-orange-500 text-white px-4 py-2 rounded-full font-bold text-xs flex items-center gap-1 shadow-lg shadow-orange-500/20"
            >
              <Plus size={16} /> 手動入力
            </button>
          </div>
        </div>

        <input 
          type="file" 
          accept="image/*" 
          capture="environment"
          ref={fileInputRef} 
          className="hidden" 
          onChange={handleFileChange}
        />

        {isAdding && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-zinc-900 p-5 rounded-3xl border border-orange-500/50 space-y-4"
          >
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-sm font-bold text-white">
                {isAnalyzing ? 'AIが解析中...' : '食事の記録'}
              </h3>
              {isAnalyzing && <Loader2 className="animate-spin text-orange-500" size={18} />}
            </div>

            <div className="space-y-3">
              <input 
                type="text" placeholder="品名 (例: 鶏胸肉 150g)" 
                className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm outline-none focus:ring-1 focus:ring-orange-500 disabled:opacity-50"
                value={newMeal.name}
                onChange={e => setNewMeal({...newMeal, name: e.target.value})}
                disabled={isAnalyzing}
              />
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase pl-1">Calories (kcal)</label>
                  <input 
                    type="number" className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm outline-none disabled:opacity-50"
                    value={newMeal.calories || ''} onChange={e => setNewMeal({...newMeal, calories: Number(e.target.value)})}
                    disabled={isAnalyzing}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase pl-1">Protein (g)</label>
                  <input 
                    type="number" className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm outline-none disabled:opacity-50"
                    value={newMeal.protein || ''} onChange={e => setNewMeal({...newMeal, protein: Number(e.target.value)})}
                    disabled={isAnalyzing}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase pl-1">Fat (g)</label>
                  <input 
                    type="number" className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm outline-none disabled:opacity-50"
                    value={newMeal.fat || ''} onChange={e => setNewMeal({...newMeal, fat: Number(e.target.value)})}
                    disabled={isAnalyzing}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase pl-1">Carbs (g)</label>
                  <input 
                    type="number" className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm outline-none disabled:opacity-50"
                    value={newMeal.carbs || ''} onChange={e => setNewMeal({...newMeal, carbs: Number(e.target.value)})}
                    disabled={isAnalyzing}
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button 
                onClick={handleAdd} 
                className="flex-1 bg-orange-500 text-white font-bold py-3 rounded-xl text-sm disabled:opacity-50"
                disabled={isAnalyzing}
              >
                記録
              </button>
              <button 
                onClick={() => setIsAdding(false)} 
                className="flex-1 bg-zinc-800 text-white font-bold py-3 rounded-xl text-sm"
              >
                中止
              </button>
            </div>
          </motion.div>
        )}

        <div className="space-y-4">
          {todayMeals.map(meal => (
            <div key={meal.id} className="bg-zinc-900 border border-zinc-800 p-4 rounded-2xl flex justify-between items-center">
              <div className="space-y-1">
                <h4 className="font-bold text-white text-sm">{meal.name}</h4>
                <div className="flex gap-3 text-[10px] uppercase font-bold">
                  <span className="text-lime-400">P: {meal.protein}g</span>
                  <span className="text-orange-400">F: {meal.fat}g</span>
                  <span className="text-cyan-400">C: {meal.carbs}g</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-black text-white">{meal.calories}<span className="text-[10px] ml-1 text-zinc-500">KCAL</span></div>
                <button 
                  onClick={() => setMeals(meals.filter(m => m.id !== meal.id))}
                  className="text-zinc-600 hover:text-rose-500 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          {todayMeals.length === 0 && !isAdding && (
            <div className="text-center py-12 text-zinc-700 space-y-2">
              <Utensils className="mx-auto" size={32} />
              <p className="text-sm">本日の記録はありません。栄養管理は勝利への近道です。</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  const SectionAnalysis = () => {
    // Last 7 days data
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = format(subDays(new Date(), 6 - i), 'yyyy-MM-dd');
      const dailyMeals = meals.filter(m => m.date === date);
      const dayCalories = dailyMeals.reduce((sum, m) => sum + m.calories, 0);
      const dayWeight = weightHistory.find(w => w.date === date)?.weight || null;
      
      return {
        name: format(parseISO(date), 'MM/dd'),
        calories: dayCalories,
        weight: dayWeight,
      };
    });

    return (
      <div className="space-y-8 pb-24">
        <h2 className="text-xl font-bold text-white uppercase italic">PROGRESS INSIGHTS</h2>

        {/* Calorie Trend */}
        <div className="bg-zinc-900 border border-zinc-800 p-5 rounded-3xl space-y-4">
          <div className="flex items-center gap-2">
            <TrendingUp size={18} className="text-lime-400" />
            <h3 className="text-xs font-bold text-white uppercase">摂取カロリー推移 (過去7日間)</h3>
          </div>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={last7Days}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#333" />
                <XAxis dataKey="name" fontSize={10} axisLine={false} tickLine={false} tick={{ fill: '#666' }} />
                <YAxis fontSize={10} axisLine={false} tickLine={false} tick={{ fill: '#666' }} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#18181b', border: 'none', borderRadius: '12px', color: '#fff' }}
                  itemStyle={{ color: '#d9ff00' }}
                />
                <Bar dataKey="calories" radius={[4, 4, 0, 0]}>
                  {last7Days.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.calories > goals.calories ? '#ff3d00' : '#d9ff00'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Weight Progression Chart */}
        <div className="bg-zinc-900 border border-zinc-800 p-5 rounded-3xl space-y-4">
          <div className="flex items-center gap-2">
            <Weight size={18} className="text-rose-400" />
            <h3 className="text-xs font-bold text-white uppercase">体重推移</h3>
          </div>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={last7Days.filter(d => d.weight !== null)}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#333" />
                <XAxis dataKey="name" fontSize={10} axisLine={false} tickLine={false} tick={{ fill: '#666' }} />
                <YAxis fontSize={10} axisLine={false} tickLine={false} tick={{ fill: '#666' }} domain={['dataMin - 2', 'dataMax + 2']} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#18181b', border: 'none', borderRadius: '12px', color: '#fff' }}
                  itemStyle={{ color: '#fb7185' }}
                />
                <Line 
                  type="monotone" 
                  dataKey="weight" 
                  stroke="#fb7185" 
                  strokeWidth={3} 
                  dot={{ r: 4, fill: '#fb7185' }} 
                  activeDot={{ r: 6 }} 
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Data Loggers */}
        <div className="space-y-3">
          <button 
            onClick={() => {
              const weight = prompt('現在の体重(kg)を入力してください');
              if (weight) addWeight(parseFloat(weight));
            }}
            className="w-full bg-zinc-900 border border-zinc-800 p-4 rounded-2xl flex items-center justify-between hover:border-rose-500 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-rose-500/20 text-rose-500 rounded-xl flex items-center justify-center">
                <Plus size={20} />
              </div>
              <span className="text-sm font-bold text-white text-left">今日の体重を記録</span>
            </div>
            <ChevronRight size={18} className="text-zinc-600" />
          </button>
        </div>
      </div>
    );
  };

  const SectionAITrainer = () => {
    const [inputText, setInputText] = useState('');
    const [pendingImages, setPendingImages] = useState<string[]>([]);
    const [isSending, setIsSending] = useState(false);
    const messagesEndRef = React.useRef<HTMLDivElement>(null);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const scrollToBottom = () => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
      scrollToBottom();
    }, [chatMessages]);

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      files.forEach((file: File) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          setPendingImages(prev => [...prev, reader.result as string]);
        };
        reader.readAsDataURL(file);
      });
    };

    const handleSendMessage = async () => {
      if (!inputText.trim() && pendingImages.length === 0) return;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text: inputText,
        images: pendingImages,
        timestamp: new Date().toISOString()
      };

      setChatMessages(prev => [...prev, userMsg]);
      setInputText('');
      setPendingImages([]);
      setIsSending(true);

      try {
        const response = await fetch('/api/chat-trainer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: inputText,
            images: userMsg.images,
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
          id: crypto.randomUUID(),
          role: 'assistant',
          text: data.text,
          exercises: data.exercises,
          timestamp: new Date().toISOString()
        };

        setChatMessages(prev => [...prev, assistantMsg]);
      } catch (error) {
        console.error(error);
        alert('AIとの通信に失敗しました。');
      } finally {
        setIsSending(false);
      }
    };

    const addSuggestedToWorkout = (suggestedExercises: { name: string; reps: number; sets: number }[]) => {
      let workoutId = todayWorkout?.id;
      
      if (!workoutId) {
        const newWorkout: Workout = {
          id: crypto.randomUUID(),
          date: today,
          exercises: []
        };
        setWorkouts(prev => [...prev, newWorkout]);
        workoutId = newWorkout.id;
      }

      suggestedExercises.forEach(ex => {
        const exId = crypto.randomUUID();
        const sets = Array.from({ length: ex.sets }, () => ({
          id: crypto.randomUUID(),
          weight: 0,
          reps: ex.reps
        }));

        setWorkouts(prev => prev.map(w => {
          if (w.id !== workoutId) return w;
          return {
            ...w,
            exercises: [...w.exercises, { id: exId, name: ex.name, sets }]
          };
        }));
      });

      alert('今日の記録にメニューを追加しました！');
      setActiveTab('workout');
    };

    return (
      <div className="flex flex-col h-[calc(100vh-140px)]">
        <header className="flex items-center justify-between mb-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-lime-400 rounded-full flex items-center justify-center text-black">
              <Sparkles size={20} />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white uppercase italic">AI Trainer</h1>
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-lime-400 rounded-full shadow-[0_0_5px_#d9ff00] animate-pulse" />
                <span className="text-[10px] text-zinc-500 font-bold">ONLINE</span>
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar">
          {chatMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center p-8 space-y-4">
              <div className="w-16 h-16 bg-zinc-900 rounded-full flex items-center justify-center text-zinc-700">
                <MessageSquare size={32} />
              </div>
              <div className="space-y-1">
                <p className="text-white font-bold">専属AIトレーナーがサポートします</p>
                <p className="text-zinc-500 text-xs">
                  「今日の調子はどうですか？」や「現在の体の写真」を送って、パーソナライズされたアドバイスをもらいましょう。
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-4">
                <div className="bg-zinc-900 border border-zinc-800 p-2 rounded-xl text-[10px] text-zinc-400">現在の体と目標の写真を送る</div>
                <div className="bg-zinc-900 border border-zinc-800 p-2 rounded-xl text-[10px] text-zinc-400">今日の体調を伝える</div>
              </div>
            </div>
          )}

          {chatMessages.map(msg => (
            <motion.div 
              key={msg.id}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "flex flex-col max-w-[85%]",
                msg.role === 'user' ? "ml-auto items-end" : "mr-auto items-start"
              )}
            >
              <div className={cn(
                "p-3 rounded-2xl text-sm leading-relaxed",
                msg.role === 'user' ? "bg-lime-400 text-black font-medium" : "bg-zinc-900 text-zinc-200 border border-zinc-800"
              )}>
                {msg.images && msg.images.length > 0 && (
                  <div className="flex gap-2 mb-2 overflow-x-auto pb-1">
                    {msg.images.map((img, i) => (
                      <img key={i} src={img} alt="Uploaded" className="w-20 h-20 object-cover rounded-lg border border-white/20" />
                    ))}
                  </div>
                )}
                <div className="whitespace-pre-wrap">{msg.text}</div>
                
                {msg.exercises && msg.exercises.length > 0 && (
                  <div className="mt-4 p-3 bg-black/30 rounded-xl space-y-2 border border-white/10">
                    <div className="text-[10px] font-bold text-lime-400 uppercase tracking-widest">提案メニュー</div>
                    {msg.exercises.map((ex, i) => (
                      <div key={i} className="flex justify-between text-xs text-white">
                        <span>{ex.name}</span>
                        <span className="font-mono">{ex.reps}回 × {ex.sets}set</span>
                      </div>
                    ))}
                    <button 
                      onClick={() => addSuggestedToWorkout(msg.exercises!)}
                      className="w-full mt-2 py-2 bg-lime-400 text-black rounded-lg text-[10px] font-black uppercase tracking-tighter"
                    >
                      記録に追加する
                    </button>
                  </div>
                )}
              </div>
              <span className="text-[8px] text-zinc-600 mt-1 uppercase font-mono">
                {format(parseISO(msg.timestamp), 'HH:mm')}
              </span>
            </motion.div>
          ))}
          
          {isSending && (
            <div className="flex items-center gap-2 text-zinc-500 ml-2">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[10px] font-bold animate-pulse">トレーナーが入力中...</span>
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>

        {/* Chat Input */}
        <div className="mt-4 pb-2 space-y-3 flex-shrink-0">
          {pendingImages.length > 0 && (
            <div className="flex gap-2 overflow-x-auto py-2">
              {pendingImages.map((img, i) => (
                <div key={i} className="relative flex-shrink-0">
                  <img src={img} className="w-12 h-12 object-cover rounded-lg border border-lime-400" />
                  <button 
                    onClick={() => setPendingImages(prev => prev.filter((_, idx) => idx !== i))}
                    className="absolute -top-1 -right-1 bg-rose-500 text-white rounded-full p-0.5"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          
          <div className="flex items-center gap-2">
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="w-10 h-10 bg-zinc-900 border border-zinc-800 rounded-xl flex items-center justify-center text-zinc-400 hover:text-white transition-colors"
            >
              <ImagePlus size={20} />
            </button>
            <input 
              type="file" multiple accept="image/*" className="hidden" 
              ref={fileInputRef} onChange={handleImageUpload} 
            />
            
            <div className="flex-1 relative">
              <input 
                type="text" 
                placeholder="メッセージを入力..."
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-sm text-white outline-none focus:ring-1 focus:ring-lime-400"
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
              />
              <button 
                onClick={handleSendMessage}
                disabled={isSending || (!inputText.trim() && pendingImages.length === 0)}
                className="absolute right-2 top-1.5 w-7 h-7 bg-lime-400 rounded-lg flex items-center justify-center text-black disabled:opacity-50"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const SectionSettings = () => {
    return (
      <div className="space-y-8 pb-24">
        <h2 className="text-xl font-bold text-white uppercase font-mono tracking-widest underline decoration-lime-400 underline-offset-8">CORE PROTOCOL</h2>
        
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 space-y-6">
          <div className="flex items-center gap-2 mb-4">
            <Target className="text-lime-400" size={20} />
            <h3 className="text-sm font-black text-white uppercase tracking-tight">目標値の設定 (DAILY PROTOCOL)</h3>
          </div>

          <div className="space-y-5">
            <div className="space-y-2">
              <div className="flex justify-between items-center px-1">
                <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Target Calories</label>
                <span className="text-xs font-mono text-white">{goals.calories} kcal</span>
              </div>
              <input 
                type="range" min="1000" max="5000" step="50"
                className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-lime-400"
                value={goals.calories} onChange={e => setGoals({...goals, calories: Number(e.target.value)})}
              />
            </div>

            <div className="grid grid-cols-2 gap-6">
               <div className="space-y-2">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase pl-1">Protein (g)</label>
                  <input 
                    type="number" className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm outline-none"
                    value={goals.protein} onChange={e => setGoals({...goals, protein: Number(e.target.value)})}
                  />
               </div>
               <div className="space-y-2">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase pl-1">Fat (g)</label>
                  <input 
                    type="number" className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm outline-none"
                    value={goals.fat} onChange={e => setGoals({...goals, fat: Number(e.target.value)})}
                  />
               </div>
               <div className="space-y-2">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase pl-1">Carbs (g)</label>
                  <input 
                    type="number" className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm outline-none"
                    value={goals.carbs} onChange={e => setGoals({...goals, carbs: Number(e.target.value)})}
                  />
               </div>
               <div className="space-y-2">
                  <label className="text-[10px] font-bold text-rose-500 uppercase pl-1">Target Weight (kg)</label>
                  <input 
                    type="number" className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm outline-none"
                    value={goals.targetWeight} onChange={e => setGoals({...goals, targetWeight: Number(e.target.value)})}
                  />
               </div>
            </div>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell className="text-orange-400" size={20} />
              <h3 className="text-sm font-black text-white uppercase">朝の体重記録リマインダー</h3>
            </div>
            <button 
              onClick={() => remindersEnabled ? setRemindersEnabled(false) : requestNotificationPermission()}
              className={cn(
                "w-12 h-6 rounded-full transition-colors relative",
                remindersEnabled ? "bg-lime-400" : "bg-zinc-700"
              )}
            >
              <div className={cn(
                "absolute top-1 w-4 h-4 rounded-full bg-white transition-all",
                remindersEnabled ? "left-7" : "left-1"
              )} />
            </button>
          </div>
          <p className="text-[10px] text-zinc-500">
            体重を記録していない日の朝（6:00〜11:00）に通知を送ります。
          </p>
        </div>

        <div className="text-center">
            <button 
                onClick={() => {
                    if (window.confirm('全データを削除しますか？')) {
                        localStorage.clear();
                        window.location.reload();
                    }
                }}
                className="text-xs text-rose-500 font-bold opacity-50 hover:opacity-100 transition-opacity"
            >
                すべてのデータをリセット
            </button>
        </div>
      </div>
    );
  };

  // --- Main Render ---

  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans selection:bg-lime-400 selection:text-black">
      {/* Mobile-first layout container */}
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
              {activeTab === 'dashboard' && <SectionDashboard />}
              {activeTab === 'workout' && <SectionWorkout />}
              {activeTab === 'diet' && <SectionDiet />}
              {activeTab === 'analysis' && <SectionAnalysis />}
              {activeTab === 'aitrainer' && <SectionAITrainer />}
              {activeTab === 'settings' && <SectionSettings />}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Bottom Navigation */}
        <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-zinc-950/80 backdrop-blur-xl border-t border-zinc-900 px-6 py-4 flex items-center justify-between z-50">
          <NavItem active={activeTab === 'dashboard'} icon={<Activity />} label="ホーム" onClick={() => setActiveTab('dashboard')} />
          <NavItem active={activeTab === 'workout'} icon={<Dumbbell />} label="ログ" onClick={() => setActiveTab('workout')} />
          <NavItem active={activeTab === 'diet'} icon={<Utensils />} label="食事" onClick={() => setActiveTab('diet')} />
          <NavItem active={activeTab === 'aitrainer'} icon={<Sparkles />} label="AI" onClick={() => setActiveTab('aitrainer')} />
          <NavItem active={activeTab === 'analysis'} icon={<BarChart3 />} label="分析" onClick={() => setActiveTab('analysis')} />
          <NavItem active={activeTab === 'settings'} icon={<Settings />} label="設定" onClick={() => setActiveTab('settings')} />
        </nav>
      </div>

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
    </button>
  );
}

