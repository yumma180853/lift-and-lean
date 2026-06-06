import React, { useState } from 'react';
import { Plus, Calendar, Dumbbell, ArrowLeft, Trash2, Award } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { Workout } from '../types';

const PRESET_EXERCISES = [
  { category: '胸', items: ['ベンチプレス', 'インクラインダンベルプレス', 'チェストプレスマシン', 'ペックフライ'] },
  { category: '背中', items: ['チンニング', 'ラットプルダウン', 'デッドリフト', 'シーテッドロー'] },
  { category: '肩', items: ['ショルダープレス', 'ミリタリープレス', 'サイドレイズ', 'リアレイズ'] },
  { category: '腕', items: ['アームカール', 'プッシュダウン', 'スカルクラッシャー'] },
  { category: '脚', items: ['スクワット', 'レッグプレス', 'レッグエクステンション'] }
];

export interface SectionWorkoutProps {
  todayWorkout: Workout | undefined;
  addWorkout: () => void;
  addExercise: (workoutId: string, name: string, category: string) => void; // 💡 改善：部位情報（category）も送れるように型を拡張！
  addSet: (workoutId: string, exerciseId: string, weight: number, reps: number) => void;
  today: string;
  deleteExercise: (workoutId: string, exerciseId: string) => void;
  deleteSet: (workoutId: string, exerciseId: string, setId: string) => void;
  updateSet: (workoutId: string, exerciseId: string, setId: string, weight: number, reps: number) => void;
  setActiveTab: (tab: any) => void;
  currentWeight: number | null;
}

interface SetRowProps {
  set: { id: string; weight: number; reps: number };
  idx: number;
  workoutId: string;
  exerciseId: string;
  updateSet: (workoutId: string, exerciseId: string, setId: string, weight: number, reps: number) => void;
  deleteSet: (workoutId: string, exerciseId: string, setId: string) => void;
}

function SetRow({ set, idx, workoutId, exerciseId, updateSet, deleteSet }: SetRowProps) {
  const [weight, setWeight] = useState(set.weight.toString());
  const [reps, setReps] = useState(set.reps.toString());

  React.useEffect(() => {
    setWeight(set.weight.toString());
    setReps(set.reps.toString());
  }, [set.weight, set.reps]);

  const handleBlur = () => {
    const w = parseFloat(weight);
    const r = parseInt(reps, 10);
    if (!isNaN(w) && !isNaN(r) && w >= 0 && r >= 0) {
      updateSet(workoutId, exerciseId, set.id, w, r);
    } else {
      setWeight(set.weight.toString());
      setReps(set.reps.toString());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  };

  return (
    <div className="grid grid-cols-5 text-xs py-2 border-b border-zinc-800/50 last:border-0 items-center justify-between gap-1">
      <div className="text-zinc-400 font-mono pl-1">SET {idx + 1}</div>
      <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 justify-center">
        <input type="number" step="0.5" value={weight} onChange={(e) => setWeight(e.target.value)} onBlur={handleBlur} onKeyDown={handleKeyDown} className="w-full bg-transparent text-white font-mono text-center font-bold outline-none border-none p-0 focus:ring-0 [&::-webkit-inner-spin-button]:appearance-none" />
        <span className="text-[9px] text-zinc-500 font-black ml-1">KG</span>
      </div>
      <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 justify-center">
        <input type="number" step="1" value={reps} onChange={(e) => setReps(e.target.value)} onBlur={handleBlur} onKeyDown={handleKeyDown} className="w-full bg-transparent text-white font-mono text-center font-bold outline-none border-none p-0 focus:ring-0 [&::-webkit-inner-spin-button]:appearance-none" />
        <span className="text-[9px] text-zinc-500 font-black ml-1">R</span>
      </div>
      <div className="text-right text-lime-400 font-bold font-mono text-[11px] pr-2">
        {(!isNaN(parseFloat(weight)) && !isNaN(parseInt(reps, 10))) ? (parseFloat(weight) * parseInt(reps, 10)).toFixed(0) : 0}
      </div>
      <div className="text-right pr-1">
        <button type="button" onClick={() => deleteSet(workoutId, exerciseId, set.id)} className="px-2 py-1 rounded-lg transition-all flex items-center justify-center gap-1 text-[10px] font-bold ml-auto text-zinc-500 hover:text-rose-500 hover:bg-zinc-850" >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

interface ExerciseCardProps {
  exercise: { id: string; name: string; sets: { id: string; weight: number; reps: number }[] };
  workoutId: string;
  addSet: (workoutId: string, exerciseId: string, weight: number, reps: number) => void;
  deleteExercise: (workoutId: string, exerciseId: string) => void;
  deleteSet: (workoutId: string, exerciseId: string, setId: string) => void;
  updateSet: (workoutId: string, exerciseId: string, setId: string, weight: number, reps: number) => void;
  currentWeight: number | null;
}

function ExerciseCard({ exercise, workoutId, addSet, deleteExercise, deleteSet, updateSet, currentWeight }: ExerciseCardProps) {
  const userWeight = currentWeight || 65; 
  const totalVolume = exercise.sets.reduce((sum, set) => sum + (set.weight * set.reps), 0);

  let estimatedCalories = 0;
  if (totalVolume > 0) {
    estimatedCalories = Math.round(totalVolume * 0.0006 * userWeight);
    const floorLimit = Math.round(exercise.sets.length * 5);
    if (estimatedCalories < floorLimit) estimatedCalories = floorLimit;
  } else if (exercise.sets.length > 0) {
    const totalReps = exercise.sets.reduce((sum, set) => sum + set.reps, 0);
    estimatedCalories = Math.round(userWeight * totalReps * 0.005 * exercise.sets.length);
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
      <div className="p-4 bg-zinc-850 flex justify-between items-center whitespace-nowrap">
        <div className="flex items-center gap-3">
          <h3 className="font-bold text-white flex items-center gap-2">
            {exercise.name}
            {exercise.sets.length > 0 && (
              <span className="text-[11px] bg-lime-400/10 border border-lime-400/20 text-lime-400 px-2 py-0.5 rounded-md font-mono font-bold transition-all animate-pulse">
                {estimatedCalories} kcal
              </span>
            )}
          </h3>
          <button type="button" onClick={() => deleteExercise(workoutId, exercise.id)} className="px-2 py-1 rounded-lg transition-all flex items-center justify-center gap-1 text-[10px] font-extrabold text-zinc-500 hover:text-rose-500 hover:bg-zinc-800" >
            <Trash2 size={13} />
          </button>
        </div>
        <button type="button" onClick={() => { const lastSet = exercise.sets[exercise.sets.length - 1]; const defaultWeight = lastSet ? lastSet.weight : 60; const defaultReps = lastSet ? lastSet.reps : 10; addSet(workoutId, exercise.id, defaultWeight, defaultReps); }} className="text-[10px] font-black uppercase text-lime-400 border border-lime-400/30 px-2.5 py-1.5 rounded-lg hover:bg-lime-400/10 transition-colors" > セットを追加 </button>
      </div>
      <div className="p-4 space-y-2">
        {exercise.sets.length > 0 ? (
          <div className="grid grid-cols-5 text-[10px] font-bold text-zinc-500 uppercase pb-2 border-b border-zinc-800 gap-1">
            <div>SET</div>
            <div className="text-center">KG (重量)</div>
            <div className="text-center">REPS (回数)</div>
            <div className="text-right pr-2">VOL</div>
            <div className="text-right pr-1">削除</div>
          </div>
        ) : (
          <p className="text-xs text-zinc-650 italic">セットを追加してください</p>
        )}
        {exercise.sets.map((set, idx) => (
          <SetRow key={set.id} set={set} idx={idx} workoutId={workoutId} exerciseId={exercise.id} updateSet={updateSet} deleteSet={deleteSet} />
        ))}
      </div>
    </div>
  );
}

export function SectionWorkout({ todayWorkout, addWorkout, addExercise, addSet, deleteExercise, deleteSet, updateSet, setActiveTab, currentWeight }: SectionWorkoutProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [tempExercise, setTempExercise] = useState('');
  const [selCat, setSelCat] = useState('胸');
  const currentWorkout = todayWorkout;

  return (
    <div className="space-y-6 pb-24">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setActiveTab('dashboard')} className="p-1.5 hover:bg-zinc-900 rounded-lg text-zinc-400 hover:text-white transition-colors flex items-center gap-1 text-xs font-bold" >
            <ArrowLeft size={16} /> 戻る
          </button>
          <h2 className="text-xl font-bold text-white">TRAINING LOG</h2>
        </div>
        {!currentWorkout && (
          <button type="button" onClick={addWorkout} className="bg-lime-400 text-black px-4 py-2 rounded-full font-bold text-xs flex items-center gap-1 shadow-lg shadow-lime-400/20" >
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
            <ExerciseCard key={exercise.id} exercise={exercise} workoutId={currentWorkout.id} addSet={addSet} deleteExercise={deleteExercise} deleteSet={deleteSet} updateSet={updateSet} currentWeight={currentWeight} />
          ))}

          {!isAdding ? (
            <button type="button" onClick={() => setIsAdding(true)} className="w-full py-4 border-2 border-dashed border-zinc-800 rounded-2xl text-zinc-500 text-sm font-bold flex items-center justify-center gap-2 hover:bg-zinc-900 transition-colors" >
              <Plus size={18} /> 種目を追加
            </button>
          ) : (
            <div className="bg-zinc-900 p-5 rounded-2xl border border-lime-400/40 space-y-5 animate-in fade-in zoom-in-95 duration-150">
              <div className="space-y-2">
                <label className="text-[10px] font-black tracking-widest text-zinc-400 uppercase flex items-center gap-1"><Award size={12} /> クイック追加（部位別メニュー）</label>
                
                <div className="flex bg-zinc-950 p-1 border border-zinc-850 rounded-xl justify-between gap-1 overflow-x-auto">
                  {PRESET_EXERCISES.map(cat => (
                    <button key={cat.category} type="button" onClick={() => setSelCat(cat.category)} className={`flex-1 min-w-[50px] text-center py-1.5 rounded-lg text-xs font-black transition-all ${selCat === cat.category ? 'bg-lime-400 text-black shadow-md' : 'text-zinc-500 hover:text-white'}`} >
                      {cat.category}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap gap-2 pt-1.5">
                  {PRESET_EXERCISES.find(c => c.category === selCat)?.items.map(item => (
                    <button key={item} type="button" onClick={() => { addExercise(currentWorkout.id, item, selCat); setIsAdding(false); }} className="bg-zinc-950 border border-zinc-800 hover:border-lime-400 text-white font-medium text-xs px-3 py-2 rounded-xl transition-all active:scale-95" >
                      + {item}
                    </button>
                  ))}
                </div>
              </div>

              <div className="border-t border-zinc-800/60 my-3 pt-3 space-y-3">
                <label className="text-[10px] font-black tracking-widest text-zinc-400 uppercase">または自由に入力</label>
                {/* 💡 改善：プレースホルダーから「マニアック」を排除し、スマートに変更！ */}
                <input type="text" placeholder="種目名を入力（例: ダンベルフライ）..." value={tempExercise} onChange={(e) => setTempExercise(e.target.value)} className="w-full bg-zinc-800 border-0 rounded-xl p-3 text-white placeholder:text-zinc-650 focus:ring-1 focus:ring-lime-400 text-sm outline-none font-medium" autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && tempExercise.trim()) { addExercise(currentWorkout.id, tempExercise.trim(), selCat); setTempExercise(''); setIsAdding(false); } }} />
              </div>

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => { if (tempExercise.trim()) { addExercise(currentWorkout.id, tempExercise.trim(), selCat); setTempExercise(''); setIsAdding(false); } }} className="flex-1 bg-lime-400 text-black font-black py-2.5 rounded-xl text-xs uppercase italic tracking-wider shadow-lg shadow-lime-400/10" > 確定 </button>
                <button type="button" onClick={() => { setIsAdding(false); setTempExercise(''); }} className="flex-1 bg-zinc-800 text-zinc-400 font-bold py-2.5 rounded-xl text-xs" > キャンセル </button>
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
}
