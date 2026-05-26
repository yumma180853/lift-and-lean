import React from 'react';
import { Settings, Bell, BellOff } from 'lucide-react';
import { UserGoals } from '../types';

interface SectionSettingsProps {
  goals: UserGoals;
  setGoals: (goals: UserGoals) => void;
  remind: boolean;
  toggleNotification: () => void;
}

export function SectionSettings({ goals, setGoals, remind, toggleNotification }: SectionSettingsProps) {
  const handleChange = (key: keyof UserGoals, value: number) => {
    setGoals({ ...goals, [key]: value });
  };

  return (
    <div className="space-y-6 pb-24">
      {/* ヘッダー */}
      <div className="flex items-center gap-2 text-lime-400 font-black italic text-xl uppercase tracking-wider mb-2">
        <Settings size={24} />
        <span>SETTINGS</span>
      </div>

      {/* 🚨【超美化】一般ユーザー向けの美しい通知ON/OFFスイッチを新設！ */}
      <div className="bg-zinc-950 border border-zinc-900 rounded-3xl p-5 space-y-3">
        <div className="flex items-center gap-2 text-zinc-400">
          {remind ? <Bell size={16} className="text-lime-400" /> : <BellOff size={16} />}
          <h3 className="text-xs font-bold uppercase tracking-wider">リマインダー通知</h3>
        </div>
        <div className="flex items-center justify-between bg-zinc-900/50 border border-zinc-900 rounded-2xl p-4">
          <div className="space-y-0.5 max-w-[70%]">
            <p className="text-sm font-bold text-white">毎朝の体重記録リマインダー</p>
            <p className="text-xs text-zinc-500">毎朝7時、体重が未入力の場合のみ通知を飛ばします</p>
          </div>
          <button
            onClick={toggleNotification}
            className={`px-4 py-2.5 rounded-xl font-bold text-xs transition-all tracking-tight ${
              remind 
                ? 'bg-red-500/10 text-red-400 border border-red-500/20 active:bg-red-500/20' 
                : 'bg-lime-400 text-black font-black active:scale-95'
            }`}
          >
            {remind ? 'オフにする' : 'オンにする'}
          </button>
        </div>
      </div>

      {/* 目標設定セクション（PFCバランスフォームを1ミリも壊さず維持！） */}
      <div className="bg-zinc-950 border border-zinc-900 rounded-3xl p-5 space-y-4">
        <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider">ターゲット目標</h3>
        
        <div className="space-y-4">
          <div>
            <label className="text-xs font-bold text-zinc-400 block mb-1.5">目標カロリー (kcal)</label>
            <input
              type="number"
              value={goals.calories}
              onChange={(e) => handleChange('calories', Number(e.target.value))}
              className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-sm font-bold text-white outline-none focus:border-lime-400 transition-all"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-zinc-400 block mb-1.5">目標タンパク質 (g)</label>
            <input
              type="number"
              value={goals.protein}
              onChange={(e) => handleChange('protein', Number(e.target.value))}
              className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-sm font-bold text-white outline-none focus:border-lime-400 transition-all"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-zinc-400 block mb-1.5">目標脂質 (g)</label>
            <input
              type="number"
              value={goals.fat}
              onChange={(e) => handleChange('fat', Number(e.target.value))}
              className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-sm font-bold text-white outline-none focus:border-lime-400 transition-all"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-zinc-400 block mb-1.5">目標炭水化物 (g)</label>
            <input
              type="number"
              value={goals.carbs}
              onChange={(e) => handleChange('carbs', Number(e.target.value))}
              className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-sm font-bold text-white outline-none focus:border-lime-400 transition-all"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-zinc-400 block mb-1.5">目標体重 (kg)</label>
            <input
              type="number"
              step="0.1"
              value={goals.targetWeight}
              onChange={(e) => handleChange('targetWeight', Number(e.target.value))}
              className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-sm font-bold text-white outline-none focus:border-lime-400 transition-all"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
