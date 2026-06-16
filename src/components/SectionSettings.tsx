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

      {/* リマインダー通知 */}
      <div className="bg-zinc-950 border border-zinc-900 rounded-3xl p-5 space-y-3">
        <div className="flex items-center gap-2 text-zinc-400">
          {remind ? <Bell size={16} className="text-lime-400" /> : <BellOff size={16} />}
          <h3 className="text-xs font-bold uppercase tracking-wider">リマインダー通知</h3>
        </div>
        <div className="flex items-center justify-between bg-zinc-900/50 border border-zinc-900 rounded-2xl p-4">
          <div className="space-y-0.5 flex-1 min-w-0 pr-4">
            <p className="text-sm font-bold text-white">毎朝の体重記録リマインダー</p>
            <p className="text-xs text-zinc-500">毎朝7時、体重が未入力の場合のみ通知</p>
          </div>
          <div className="flex flex-col items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={toggleNotification}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-200 ${remind ? 'bg-lime-400' : 'bg-zinc-700'}`}
              aria-label={remind ? '通知をオフにする' : '通知をオンにする'}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform duration-200 ${remind ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
            <span className={`text-[10px] font-black ${remind ? 'text-lime-400' : 'text-zinc-500'}`}>
              {remind ? 'ON' : 'OFF'}
            </span>
          </div>
        </div>
      </div>

      {/* 目標設定セクション */}
      <div className="bg-zinc-950 border border-zinc-900 rounded-3xl p-5 space-y-4">
        <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider">ターゲット目標</h3>
        
        <div className="space-y-4">
          {/* 🚨【快適大改造】値が0の時は空文字にして、新しく打ちやすく調整！ */}
          <div>
            <label className="text-xs font-bold text-zinc-400 block mb-1.5">目標カロリー (kcal)</label>
            <input
              type="number"
              placeholder="0"
              value={goals.calories === 0 ? '' : goals.calories}
              onChange={(e) => handleChange('calories', e.target.value === '' ? 0 : Number(e.target.value))}
              className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-sm font-bold text-white outline-none focus:border-lime-400 transition-all"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-zinc-400 block mb-1.5">目標タンパク質 (g)</label>
            <input
              type="number"
              placeholder="0"
              value={goals.protein === 0 ? '' : goals.protein}
              onChange={(e) => handleChange('protein', e.target.value === '' ? 0 : Number(e.target.value))}
              className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-sm font-bold text-white outline-none focus:border-lime-400 transition-all"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-zinc-400 block mb-1.5">目標脂質 (g)</label>
            <input
              type="number"
              placeholder="0"
              value={goals.fat === 0 ? '' : goals.fat}
              onChange={(e) => handleChange('fat', e.target.value === '' ? 0 : Number(e.target.value))}
              className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-sm font-bold text-white outline-none focus:border-lime-400 transition-all"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-zinc-400 block mb-1.5">目標炭水化物 (g)</label>
            <input
              type="number"
              placeholder="0"
              value={goals.carbs === 0 ? '' : goals.carbs}
              onChange={(e) => handleChange('carbs', e.target.value === '' ? 0 : Number(e.target.value))}
              className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-sm font-bold text-white outline-none focus:border-lime-400 transition-all"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-zinc-400 block mb-1.5">目標体重 (kg)</label>
            <input
              type="number"
              step="0.1"
              placeholder="0.0"
              value={goals.targetWeight === 0 ? '' : goals.targetWeight}
              onChange={(e) => handleChange('targetWeight', e.target.value === '' ? 0 : Number(e.target.value))}
              className="w-full bg-zinc-900 border border-zinc-900 rounded-2xl p-4 text-sm font-bold text-white outline-none focus:border-lime-400 transition-all"
            />
          </div>
        </div>
      </div>

      {/* AIのしゃべり方 */}
      <div className="bg-zinc-950 border border-zinc-900 rounded-3xl p-5 space-y-4">
        <div>
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider">AIのしゃべり方</h3>
          <p className="text-xs text-zinc-600 mt-1">AIトレーナーのトーンを選べます</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {([
            { value: 'buddy', label: '伴走型', desc: '友達感覚で一緒に' },
            { value: 'coach', label: 'コーチ型', desc: '短く、現実的に' },
            { value: 'stoic', label: 'ストイック型', desc: '数字中心で淡々と' },
            { value: 'cheer', label: '励まし型', desc: 'まず受け止めて次へ' },
          ] as const).map(({ value, label, desc }) => {
            const selected = (goals.trainerStyle || 'buddy') === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setGoals({ ...goals, trainerStyle: value })}
                className={`p-3 rounded-2xl border text-left transition-all ${
                  selected
                    ? 'bg-lime-400/10 border-lime-400/40 text-lime-400'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                <div className={`text-xs font-black ${selected ? 'text-lime-400' : 'text-white'}`}>{label}</div>
                <div className="text-[10px] mt-0.5 text-zinc-500">{desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* プライバシーポリシー */}
      <div className="bg-zinc-950 border border-zinc-900 rounded-3xl p-5">
        <a
          href="/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-bold text-zinc-400 hover:text-lime-400 transition-colors"
        >
          プライバシーポリシー
        </a>
      </div>
    </div>
  );
}
