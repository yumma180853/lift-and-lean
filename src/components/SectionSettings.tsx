import React, { useState } from 'react';
import { Settings, Bell, BellOff, Sparkles, X, RefreshCw } from 'lucide-react';
import { UserGoals } from '../types';
import { AI_DAILY_LIMITS, loadAiUsage, incrementAiUsage, remainingOf, AiUsage } from '../utils/aiUsage';

interface SectionSettingsProps {
  goals: UserGoals;
  setGoals: (goals: UserGoals) => void;
  remind: boolean;
  toggleNotification: () => void;
}

interface GoalSuggestion {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  targetWeight: number;
  interimTargetWeight: number;
  isAggressiveGoal: boolean;
  recommendedPaceKgPerMonth: number;
  periodMonths: number;
  reason: string;
  nextSteps: string;
  note: string;
}

const ACTIVITY_OPTIONS = ['ほぼしない', '週1〜2回', '週3〜4回', '週5回以上'];
const GOAL_OPTIONS = ['筋肉を増やしたい', '体を大きくしたい', '体脂肪を落としたい', '引き締めたい', '健康維持'];
const INTENSITY_OPTIONS = ['ゆるく', '標準', 'しっかり'];
const STRUGGLE_OPTIONS = ['自炊が苦手', '外食が多い', '間食がやめられない', '量を食べられない'];

export function SectionSettings({ goals, setGoals, remind, toggleNotification }: SectionSettingsProps) {
  const handleChange = (key: keyof UserGoals, value: number) => {
    setGoals({ ...goals, [key]: value });
  };

  // AI目標提案フロー
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [step, setStep] = useState(0); // 0,1,2 = 質問, 3 = 結果
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [age, setAge] = useState('');
  const [sex, setSex] = useState('');
  const [activity, setActivity] = useState('');
  const [goal, setGoal] = useState('');
  const [intensity, setIntensity] = useState('標準');
  const [targetWeightInput, setTargetWeightInput] = useState('');
  const [periodMonthsInput, setPeriodMonthsInput] = useState('');
  const [struggles, setStruggles] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<GoalSuggestion | null>(null);
  const [reflectedMsg, setReflectedMsg] = useState(false);
  // AI利用回数（1日あたりの端末ローカル制限）。表示更新用にstateにも持つ
  const [aiUsage, setAiUsage] = useState<AiUsage>(loadAiUsage);

  const resetSuggestFlow = () => {
    setIsSuggesting(false);
    setStep(0);
    setSuggestError(null);
    setSuggestion(null);
    setSuggestLoading(false);
    setReflectedMsg(false);
  };

  const toggleStruggle = (s: string) => {
    setStruggles(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  };

  const canProceedStep0 = height.trim() !== '' && weight.trim() !== '' && age.trim() !== '';

  const handleSuggest = async () => {
    // 1日あたりの利用回数制限。上限時はAPIを呼ばない
    const usage = loadAiUsage();
    if (usage.suggestGoalsCount >= AI_DAILY_LIMITS.suggestGoals) {
      setSuggestError('今日のAI目標提案回数の上限に達しました。明日また使えます。');
      return;
    }
    setSuggestLoading(true);
    setSuggestError(null);
    setSuggestion(null);
    // API呼び出しが発生する時点でカウント（失敗してもサーバー側コストは発生するため）
    setAiUsage(incrementAiUsage('suggestGoalsCount'));
    try {
      const response = await fetch('/api/suggest-goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          height: parseFloat(height),
          weight: parseFloat(weight),
          age: parseFloat(age),
          sex: sex || undefined,
          activity: activity || undefined,
          goal: goal || undefined,
          intensity,
          targetWeight: targetWeightInput ? parseFloat(targetWeightInput) : undefined,
          periodMonths: periodMonthsInput ? parseFloat(periodMonthsInput) : undefined,
          struggles: struggles.length > 0 ? struggles.join('、') : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.calories) {
        setSuggestError(data.error || '提案の生成に失敗しました。時間をおいて試してください。');
      } else {
        setSuggestion(data as GoalSuggestion);
        setStep(3);
      }
    } catch {
      setSuggestError('通信エラーが発生しました。時間をおいて試してください。');
    } finally {
      setSuggestLoading(false);
    }
  };

  const handleApplySuggestion = () => {
    if (!suggestion) return;
    setGoals({
      ...goals,
      calories: suggestion.calories,
      protein: suggestion.protein,
      fat: suggestion.fat,
      carbs: suggestion.carbs,
      // 実行目標としてはまず中間目標を反映する（最終目標は提案カード内で参考表示のみ）
      targetWeight: suggestion.isAggressiveGoal ? suggestion.interimTargetWeight : suggestion.targetWeight,
    });
    setReflectedMsg(true);
    setTimeout(() => resetSuggestFlow(), 1200);
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

      {/* AIで目標を提案 */}
      <button
        type="button"
        onClick={() => { resetSuggestFlow(); setIsSuggesting(true); }}
        className="ll-card p-4 w-full text-left flex items-center gap-3 active:scale-[0.99] transition-all"
        style={{ borderColor: 'rgba(163,230,53,0.3)' }}
      >
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0" style={{ background: 'rgba(163,230,53,0.1)' }}>✨</div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-black text-white">AIで目標を提案</div>
          <div className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">身長・体重・目的から、カロリーとPFCの目安を一緒に決めます</div>
        </div>
        <div className="text-lime-400 font-black shrink-0">›</div>
      </button>

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

      {/* AI目標提案ボトムシート */}
      {isSuggesting && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center" onClick={resetSuggestFlow}>
          <div className="absolute inset-0 bg-black/70" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md ll-card ll-pop rounded-t-3xl rounded-b-none flex flex-col"
            style={{ maxHeight: 'calc(100dvh - max(1rem, env(safe-area-inset-top)))' }}
          >
            {/* ヘッダー */}
            <div className="shrink-0 flex items-center justify-between p-5 pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-1.5 text-lime-400 font-bold text-xs">
                <Sparkles size={14} /> AIで目標を提案
              </div>
              <button type="button" onClick={resetSuggestFlow} className="text-zinc-500 hover:text-white transition-colors p-1">
                <X size={18} />
              </button>
            </div>

            {/* 本文 */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4" style={{ WebkitOverflowScrolling: 'touch' }}>
              {step < 3 && (
                <div className="flex gap-1.5 justify-center">
                  {[0, 1, 2].map(i => (
                    <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? 'w-4 bg-lime-400' : 'w-1.5 bg-zinc-700'}`} />
                  ))}
                </div>
              )}

              {step === 0 && (
                <div className="space-y-4">
                  <div>
                    <div className="text-sm font-bold text-white">いまのからだを教えてください</div>
                    <div className="text-[10px] text-zinc-500 mt-1 leading-relaxed">提案の計算にだけ使います。端末の外には保存しません。</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-zinc-800 rounded-xl px-3 py-2.5">
                      <label className="text-[9px] font-bold text-zinc-500 uppercase" htmlFor="sg-height">身長</label>
                      <div className="flex items-baseline gap-1">
                        <input id="sg-height" type="number" inputMode="decimal" placeholder="172" value={height} onChange={(e) => setHeight(e.target.value)} className="w-full bg-transparent text-white font-black text-base outline-none" />
                        <span className="text-[10px] text-zinc-500 shrink-0">cm</span>
                      </div>
                    </div>
                    <div className="bg-zinc-800 rounded-xl px-3 py-2.5">
                      <label className="text-[9px] font-bold text-zinc-500 uppercase" htmlFor="sg-weight">体重</label>
                      <div className="flex items-baseline gap-1">
                        <input id="sg-weight" type="number" inputMode="decimal" placeholder="65" value={weight} onChange={(e) => setWeight(e.target.value)} className="w-full bg-transparent text-white font-black text-base outline-none" />
                        <span className="text-[10px] text-zinc-500 shrink-0">kg</span>
                      </div>
                    </div>
                    <div className="bg-zinc-800 rounded-xl px-3 py-2.5">
                      <label className="text-[9px] font-bold text-zinc-500 uppercase" htmlFor="sg-age">年齢</label>
                      <div className="flex items-baseline gap-1">
                        <input id="sg-age" type="number" inputMode="numeric" placeholder="24" value={age} onChange={(e) => setAge(e.target.value)} className="w-full bg-transparent text-white font-black text-base outline-none" />
                        <span className="text-[10px] text-zinc-500 shrink-0">歳</span>
                      </div>
                    </div>
                    <div className="bg-zinc-800 rounded-xl px-3 py-2.5">
                      <label className="text-[9px] font-bold text-zinc-500 uppercase">性別（任意）</label>
                      <div className="flex gap-2 mt-1 flex-wrap">
                        {['男性', '女性', '未回答'].map(s => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setSex(sex === s ? '' : s)}
                            className={`text-[10px] font-bold px-2 py-1 rounded-full ${sex === s ? 'bg-lime-400 text-black' : 'bg-zinc-900 text-zinc-500'}`}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white">運動の頻度は？</div>
                    <div className="flex gap-1.5 flex-wrap mt-2">
                      {ACTIVITY_OPTIONS.map(a => (
                        <button
                          key={a}
                          type="button"
                          onClick={() => setActivity(activity === a ? '' : a)}
                          className={`text-[11px] font-bold px-3 py-1.5 rounded-full border ${activity === a ? 'bg-lime-400/10 border-lime-400/40 text-lime-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400'}`}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {step === 1 && (
                <div className="space-y-4">
                  <div className="text-sm font-bold text-white">どんなからだを目指しますか？</div>
                  <div className="flex gap-1.5 flex-wrap">
                    {GOAL_OPTIONS.map(g => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => setGoal(goal === g ? '' : g)}
                        className={`text-[11px] font-bold px-3 py-1.5 rounded-full border ${goal === g ? 'bg-lime-400/10 border-lime-400/40 text-lime-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400'}`}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white">食事管理の本気度は？</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">「ゆるく」でも続けば十分成果になります。</div>
                    <div className="flex gap-1.5 mt-2">
                      {INTENSITY_OPTIONS.map(i => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setIntensity(i)}
                          className={`flex-1 text-[11px] font-bold px-3 py-1.5 rounded-full border ${intensity === i ? 'bg-lime-400/10 border-lime-400/40 text-lime-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400'}`}
                        >
                          {i}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-zinc-800 rounded-xl px-3 py-2.5">
                      <label className="text-[9px] font-bold text-zinc-500 uppercase" htmlFor="sg-target">目標体重（任意）</label>
                      <div className="flex items-baseline gap-1">
                        <input id="sg-target" type="number" inputMode="decimal" placeholder="未指定" value={targetWeightInput} onChange={(e) => setTargetWeightInput(e.target.value)} className="w-full bg-transparent text-white font-black text-base outline-none placeholder:text-zinc-600 placeholder:text-xs" />
                        <span className="text-[10px] text-zinc-500 shrink-0">kg</span>
                      </div>
                    </div>
                    <div className="bg-zinc-800 rounded-xl px-3 py-2.5">
                      <label className="text-[9px] font-bold text-zinc-500 uppercase" htmlFor="sg-period">期間の目安（任意）</label>
                      <div className="flex items-baseline gap-1">
                        <input id="sg-period" type="number" inputMode="numeric" placeholder="未指定" value={periodMonthsInput} onChange={(e) => setPeriodMonthsInput(e.target.value)} className="w-full bg-transparent text-white font-black text-base outline-none placeholder:text-zinc-600 placeholder:text-xs" />
                        <span className="text-[10px] text-zinc-500 shrink-0">ヶ月</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-4">
                  <div>
                    <div className="text-sm font-bold text-white">続かなくなる理由があれば（任意）</div>
                    <div className="text-[10px] text-zinc-500 mt-1">当てはまるものを選ぶと、提案に軽く反映します。</div>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {STRUGGLE_OPTIONS.map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => toggleStruggle(s)}
                        className={`text-[11px] font-bold px-3 py-1.5 rounded-full border ${struggles.includes(s) ? 'bg-lime-400/10 border-lime-400/40 text-lime-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400'}`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] font-bold text-zinc-600">
                    AI目標提案は1日{AI_DAILY_LIMITS.suggestGoals}回まで・今日あと{remainingOf(aiUsage.suggestGoalsCount, AI_DAILY_LIMITS.suggestGoals)}回
                  </p>
                  {suggestError && (
                    <p className="text-[11px] text-rose-400 font-bold">{suggestError}</p>
                  )}
                </div>
              )}

              {step === 3 && suggestion && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold text-white">あなたへの提案</div>
                    <span className="text-[9px] font-bold text-lime-400 bg-lime-400/10 border border-lime-400/30 rounded-full px-2 py-0.5">AI提案・目安</span>
                  </div>
                  <div className="ll-card p-4" style={{ borderColor: 'rgba(163,230,53,0.3)' }}>
                    <div className="text-center">
                      <div className="ll-num text-4xl text-lime-400 leading-none">{suggestion.calories.toLocaleString()}</div>
                      <div className="text-[9px] text-zinc-500 font-mono tracking-widest mt-1.5">KCAL / 日</div>
                    </div>
                    <div className="flex justify-between items-center mt-3 bg-zinc-900/60 border border-zinc-800 rounded-xl px-4 py-3">
                      <div className="text-center">
                        <div className="ll-num text-lg text-rose-400 leading-none">{suggestion.protein}</div>
                        <div className="text-[8px] text-zinc-600 font-mono mt-0.5">P(g)</div>
                      </div>
                      <div className="w-px h-6 bg-zinc-700" />
                      <div className="text-center">
                        <div className="ll-num text-lg text-amber-400 leading-none">{suggestion.fat}</div>
                        <div className="text-[8px] text-zinc-600 font-mono mt-0.5">F(g)</div>
                      </div>
                      <div className="w-px h-6 bg-zinc-700" />
                      <div className="text-center">
                        <div className="ll-num text-lg text-blue-400 leading-none">{suggestion.carbs}</div>
                        <div className="text-[8px] text-zinc-600 font-mono mt-0.5">C(g)</div>
                      </div>
                    </div>
                    {suggestion.isAggressiveGoal ? (
                      <div className="mt-3 space-y-2">
                        <div className="flex justify-between items-center px-1">
                          <span className="text-[10px] text-zinc-500 font-bold">最終目標</span>
                          <span className="ll-num text-sm text-zinc-400">{suggestion.targetWeight}kg</span>
                        </div>
                        <div className="flex justify-between items-center px-3 py-2 rounded-xl" style={{ background: 'rgba(163,230,53,0.08)', border: '1px solid rgba(163,230,53,0.25)' }}>
                          <span className="text-[10px] text-lime-400 font-bold">まずの中間目標</span>
                          <span className="ll-num text-base text-lime-400">{suggestion.interimTargetWeight}kg</span>
                        </div>
                        <div className="flex justify-between items-center px-1">
                          <span className="text-[10px] text-zinc-500 font-bold">目安期間</span>
                          <span className="text-[11px] text-zinc-400 font-mono">{suggestion.periodMonths}ヶ月</span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-between items-center mt-3 px-1">
                        <span className="text-[10px] text-zinc-500 font-bold">{suggestion.periodMonths}ヶ月後の目安</span>
                        <span className="ll-num text-sm text-white">{suggestion.targetWeight}kg</span>
                      </div>
                    )}
                  </div>
                  {suggestion.isAggressiveGoal && (
                    <p className="text-[10px] text-amber-400 leading-relaxed">
                      まず{suggestion.periodMonths}ヶ月で{suggestion.interimTargetWeight}kgを目安にしましょう。その後、体重の増え方を見て{suggestion.targetWeight}kgを目指します。
                    </p>
                  )}
                  <p className="text-[11px] text-zinc-400 leading-relaxed bg-zinc-800/60 rounded-xl p-3">{suggestion.reason}</p>
                  <div className="flex gap-2 items-start bg-zinc-800/40 rounded-xl p-3">
                    <span className="text-sm shrink-0">👉</span>
                    <p className="text-[11px] text-zinc-400 leading-relaxed">{suggestion.nextSteps}</p>
                  </div>
                  <p className="text-[9px] text-zinc-600 text-center leading-relaxed">{suggestion.note}</p>
                </div>
              )}
            </div>

            {/* フッター */}
            <div className="shrink-0 p-4 border-t border-zinc-800 flex gap-2" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
              {step < 2 && (
                <button
                  type="button"
                  onClick={() => setStep(step + 1)}
                  disabled={step === 0 && !canProceedStep0}
                  className="flex-1 bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm disabled:opacity-40 active:scale-95 transition-all"
                >
                  次へ
                </button>
              )}
              {step === 2 && (
                <button
                  type="button"
                  onClick={handleSuggest}
                  disabled={suggestLoading}
                  className="flex-1 bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm disabled:opacity-60 active:scale-95 transition-all flex items-center justify-center gap-2"
                >
                  {suggestLoading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                      提案中…
                    </>
                  ) : 'AIに提案してもらう'}
                </button>
              )}
              {step === 3 && (
                <>
                  {reflectedMsg ? (
                    <div className="flex-1 flex items-center justify-center gap-2 text-lime-400 font-bold text-sm py-2.5">
                      <span className="w-5 h-5 rounded-full bg-lime-400 text-black flex items-center justify-center text-[11px] font-black">✓</span>
                      反映しました
                    </div>
                  ) : (
                    <>
                      <button type="button" onClick={handleApplySuggestion} className="flex-1 bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm active:scale-95 transition-all">
                        この目標を反映する
                      </button>
                      <button type="button" onClick={() => setStep(0)} className="shrink-0 bg-zinc-800 text-white px-4 rounded-xl font-bold text-xs active:scale-95 transition-all flex items-center gap-1">
                        <RefreshCw size={12} /> 条件を変える
                      </button>
                    </>
                  )}
                </>
              )}
              {step > 0 && step < 3 && (
                <button type="button" onClick={() => setStep(step - 1)} className="shrink-0 bg-zinc-800 text-white px-4 rounded-xl font-bold text-xs active:scale-95 transition-all">
                  戻る
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
