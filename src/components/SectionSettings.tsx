import React, { useState } from 'react';
import { 
  Settings, 
  Save, 
  Bell 
} from 'lucide-react';
import { UserGoals } from '../types';

export interface SectionSettingsProps {
  goals: UserGoals;
  setGoals: React.Dispatch<React.SetStateAction<UserGoals>>;
  requestNotificationPermission: () => void;
}

export function SectionSettings({ 
  goals, 
  setGoals, 
  requestNotificationPermission 
}: SectionSettingsProps) {
  const [cal, setCal] = useState(goals.calories.toString());
  const [prot, setProt] = useState(goals.protein.toString());
  const [fat, setFat] = useState(goals.fat.toString());
  const [carb, setCarb] = useState(goals.carbs.toString());
  const [wt, setWt] = useState(goals.targetWeight.toString());

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setGoals({
      calories: parseFloat(cal) || 0,
      protein: parseFloat(prot) || 0,
      fat: parseFloat(fat) || 0,
      carbs: parseFloat(carb) || 0,
      targetWeight: parseFloat(wt) || 0,
    });
    alert('目標設定を更新しました！');
  };

  return (
    <div className="space-y-6 pb-24">
      <header className="flex items-center gap-2">
        <div className="w-10 h-10 bg-zinc-900 border border-zinc-800 rounded-full flex items-center justify-center text-zinc-400">
          <Settings size={20} />
        </div>
        <div>
          <h1 className="text-lg font-bold text-white uppercase italic">GOAL SETTINGS</h1>
          <p className="text-zinc-500 text-xs">日々のターゲット数値を管理</p>
        </div>
      </header>

      {/* Manual target config form */}
      <form onSubmit={handleSave} className="bg-zinc-900 border border-zinc-800 p-6 rounded-3xl space-y-4">
        <h3 className="font-bold text-white text-sm border-b border-zinc-800 pb-2">目標PFC&カロリー設定</h3>
        
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-zinc-400" htmlFor="target-weight-input-settings">目標体重 (kg)</label>
              <input 
                id="target-weight-input-settings"
                type="number" 
                step="0.1" 
                value={wt}
                onChange={(e) => setWt(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-zinc-400" htmlFor="target-calories-input-settings">目標カロリー (kcal)</label>
              <input 
                id="target-calories-input-settings"
                type="number" 
                value={cal}
                onChange={(e) => setCal(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-400" htmlFor="target-protein-input-settings">タンパク質 (g)</label>
              <input 
                id="target-protein-input-settings"
                type="number" 
                value={prot}
                onChange={(e) => setProt(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm text-center focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-400" htmlFor="target-fat-input-settings">脂質 (g)</label>
              <input 
                id="target-fat-input-settings"
                type="number" 
                value={fat}
                onChange={(e) => setFat(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm text-center focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-400" htmlFor="target-carbs-input-settings">炭水化物 (g)</label>
              <input 
                id="target-carbs-input-settings"
                type="number" 
                value={carb}
                onChange={(e) => setCarb(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white text-sm text-center focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
          </div>
        </div>

        <button 
          type="submit"
          className="w-full bg-lime-400 text-black py-3 rounded-2xl font-bold text-sm shadow-lg shadow-lime-400/10 flex items-center justify-center gap-1.5 hover:bg-lime-300 transition-colors"
        >
          <Save size={16} /> 設定を保存する
        </button>
      </form>

      {/* Service Notification Panel */}
      <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-3xl space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 bg-indigo-500/10 text-indigo-400 rounded-xl flex items-center justify-center flex-shrink-0">
            <Bell size={20} />
          </div>
          <div>
            <h4 className="font-bold text-white text-sm">毎朝の体重計測リマインダー</h4>
            <p className="text-zinc-500 text-xs mt-1">朝8:00に通知を送信して、測り忘れをゼロにします。</p>
          </div>
        </div>
        <button 
          onClick={requestNotificationPermission}
          className="w-full bg-zinc-800 text-zinc-300 border border-zinc-700 py-2.5 rounded-xl text-xs font-bold hover:bg-zinc-750 transition-colors"
        >
          通知テスト ＆ 権限リクエスト
        </button>
      </div>
    </div>
  );
}
