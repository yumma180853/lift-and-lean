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
      <div className="ll-card p-5 space-y-3">
        <div className="flex items-center gap-2 text-zinc-400">
          {remind ? <Bell size={16} className="text-lime-400" /> : <BellOff size={16} />}
          <h3 className="ll-label text-zinc-400 text-xs">リマインダー通知</h3>
        </div>
        <div className="flex items-center justify-between ll-inset p-4">
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
      <div className="ll-card p-5 space-y-3">
        <h3 className="ll-label text-zinc-500 text-xs">ターゲット目標</h3>
        <div className="ll-inset divide-y divide-zinc-900 overflow-hidden">
          {([
            { key: 'calories',     label: '目標カロリー',   unit: 'kcal', step: '1' },
            { key: 'protein',      label: '目標タンパク質', unit: 'g',    step: '1' },
            { key: 'fat',          label: '目標脂質',       unit: 'g',    step: '1' },
            { key: 'carbs',        label: '目標炭水化物',   unit: 'g',    step: '1' },
            { key: 'targetWeight', label: '目標体重',       unit: 'kg',   step: '0.1' },
          ] as const).map(({ key, label, unit, step }) => (
            <div key={key} className="flex items-center justify-between px-4 py-3 gap-3">
              <label className="text-xs font-bold text-zinc-300 shrink-0" htmlFor={`goal-${key}`}>{label}</label>
              <div className="flex items-baseline gap-1.5 min-w-0">
                <input
                  id={`goal-${key}`}
                  type="number"
                  step={step}
                  placeholder="0"
                  value={goals[key] === 0 ? '' : goals[key]}
                  onChange={(e) => handleChange(key, e.target.value === '' ? 0 : Number(e.target.value))}
                  className="w-24 min-w-0 bg-transparent text-right ll-num text-base text-lime-400 outline-none border-b border-transparent focus:border-lime-400/50 transition-colors"
                />
                <span className="text-[10px] text-zinc-500 font-mono shrink-0">{unit}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* AIのしゃべり方 */}
      <div className="ll-card p-5 space-y-4">
        <div>
          <h3 className="ll-label text-zinc-500 text-xs">AIのしゃべり方</h3>
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
      <div className="ll-card p-5">
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
