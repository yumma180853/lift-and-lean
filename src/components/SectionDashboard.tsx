import React from 'react';
import { 
  Activity, 
  Flame, 
  Dumbbell, 
  Utensils, 
  Weight, 
  BellRing 
} from 'lucide-react';
import { format } from 'date-fns';
import { ja } from 'date-fns/locale';
import { motion } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { UserGoals, WeightRecord, Workout, Meal, Tab } from '../types';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export interface SectionDashboardProps {
  todayStats: { calories: number; protein: number; fat: number; carbs: number };
  goals: UserGoals;
  weightHistory: WeightRecord[];
  today: string;
  todayWorkout: Workout | undefined;
  todayMeals: Meal[];
  currentWeight: number | null;
  addWeight: (weight: number) => void;
  setActiveTab: (tab: Tab) => void;
  openWeightModal: () => void;
}

export function SectionDashboard({ 
  todayStats, 
  goals, 
  weightHistory, 
  today, 
  todayWorkout, 
  todayMeals, 
  currentWeight, 
  addWeight, 
  setActiveTab,
  openWeightModal
}: SectionDashboardProps) {
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
            onClick={openWeightModal}
            className="bg-rose-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold active:scale-95 transition-transform"
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
}
