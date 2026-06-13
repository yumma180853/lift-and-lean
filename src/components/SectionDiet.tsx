import React, { useState, useRef, useMemo } from 'react';
import { Plus, Camera, Calendar, Sparkles, Trash2 } from 'lucide-react';
import { Meal, UserGoals } from '../types';

export interface SectionDietProps {
  todayMeals: Meal[];
  allMeals: Meal[];
  addMeal: (meal: Omit<Meal, 'id'>) => void;
  deleteMeal: (id: string) => void;
  goals: UserGoals;
}

export function SectionDiet({ todayMeals, allMeals, addMeal, deleteMeal, goals }: SectionDietProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [mealName, setMealName] = useState('');
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [fat, setFat] = useState('');
  const [carbs, setCarbs] = useState('');
  const suggestions = useMemo(() => {
    const seen = new Map<string, Meal>();
    [...allMeals].sort((a, b) => b.date.localeCompare(a.date)).forEach(m => {
      if (!seen.has(m.name)) seen.set(m.name, m);
    });
    return Array.from(seen.values()).slice(0, 5);
  }, [allMeals]);

  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [isAiResult, setIsAiResult] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleManualAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!mealName) return;
    const newMeal = {
      date: new Date().toISOString().split('T')[0],
      name: mealName,
      calories: parseFloat(calories) || 0,
      protein: parseFloat(protein) || 0,
      fat: parseFloat(fat) || 0,
      carbs: parseFloat(carbs) || 0,
    };
    addMeal(newMeal);

    const totalKcal = todayMeals.reduce((s, m) => s + m.calories, 0) + newMeal.calories;
    const totalProtein = todayMeals.reduce((s, m) => s + m.protein, 0) + newMeal.protein;
    const remainKcal = Math.round(goals.calories - totalKcal);
    const remainProtein = Math.round(goals.protein - totalProtein);
    const msg = remainKcal < 0
      ? `✓ ${mealName}を記録  今日はしっかり食べた日`
      : `✓ ${mealName}を記録  残り ${remainKcal}kcal · P あと ${remainProtein}g`;
    setFeedbackMsg(msg);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedbackMsg(null), 1500);

    setMealName('');
    setCalories('');
    setProtein('');
    setFat('');
    setCarbs('');
    setIsAiResult(false);
    setIsAdding(false);
  };

  const compressImage = (file: File): Promise<string> =>
    new Promise((resolve) => {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 1024;
        let { width, height } = img;
        if (width > height) {
          if (width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
        } else {
          if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
    });

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    if (files.length > 5) {
      alert('一度に解析できる画像は5枚までです');
      e.target.value = '';
      return;
    }

    setAiAnalyzing(true);
    setIsAdding(true);

    try {
      const compressedImages = await Promise.all(files.map(compressImage));
      const response = await fetch('/api/analyze-meal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: compressedImages }),
      });
      const data = await response.json();

      if (data.name || data.mealName) {
        setMealName(data.mealName || data.name || '解析された食事');
        setCalories(String(Math.round(data.calories || 0)));
        setProtein(String(Math.round(data.protein || 0)));
        setFat(String(Math.round(data.fat || 0)));
        setCarbs(String(Math.round(data.carbs || 0)));
        setIsAiResult(true);
      } else {
        alert('画像の解析に失敗しました。手動で入力してください。');
      }
    } catch (error) {
      console.error(error);
      alert('エラーが発生しました。手動で入力してください。');
    } finally {
      setAiAnalyzing(false);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-6 pb-24">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold text-white">DIET LOG</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="bg-indigo-600 text-white px-4 py-2 rounded-full font-bold text-xs flex items-center gap-1 shadow-lg shadow-indigo-600/20"
          >
            <Camera size={16} /> AI写真解析
          </button>
          <button
            type="button"
            onClick={() => { setIsAdding(!isAdding); setIsAiResult(false); }}
            className="bg-lime-400 text-black px-4 py-2 rounded-full font-bold text-xs flex items-center gap-1 shadow-lg shadow-lime-400/20"
          >
            <Plus size={16} /> 手動追加
          </button>
        </div>
        <input type="file" ref={fileInputRef} onChange={handlePhotoUpload} accept="image/*" multiple className="hidden" />
      </div>

      {isAdding && (
        <form onSubmit={handleManualAdd} className="bg-zinc-900 border border-zinc-800 p-6 rounded-2xl space-y-4 relative">
          {aiAnalyzing && (
            <div className="absolute inset-0 bg-black/80 rounded-2xl flex flex-col items-center justify-center space-y-3 z-10">
              <div className="w-10 h-10 border-4 border-lime-400 border-t-transparent rounded-full animate-spin" />
              <div className="flex items-center gap-1.5 text-lime-400 font-bold text-xs animate-pulse">
                <Sparkles size={14} /> <span>AI食事解析中...</span>
              </div>
            </div>
          )}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-zinc-400" htmlFor="meal-name-input">食事名 / メニュー</label>
              {isAiResult && (
                <span className="text-[9px] font-bold text-zinc-500 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 tracking-widest font-mono uppercase">AI推定</span>
              )}
            </div>
            {!isAiResult && mealName === '' && suggestions.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[9px] text-zinc-600 font-bold tracking-widest uppercase font-mono">最近の食品</p>
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map(s => (
                    <button
                      type="button"
                      key={s.name}
                      onClick={() => {
                        setMealName(s.name);
                        setCalories(String(s.calories));
                        setProtein(String(s.protein));
                        setFat(String(s.fat));
                        setCarbs(String(s.carbs));
                      }}
                      className="text-[10px] text-zinc-400 bg-zinc-800 border border-zinc-700 rounded-full px-2.5 py-1 font-medium"
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <input
              id="meal-name-input"
              type="text"
              placeholder="例: チキン胸肉とブロッコリー"
              value={mealName}
              onChange={(e) => setMealName(e.target.value)}
              className="w-full bg-zinc-800 border-0 rounded-lg p-3 text-white placeholder:text-zinc-600 text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              required
            />
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-zinc-400" htmlFor="calories-input">KCAL</label>
              <input
                id="calories-input"
                type="number"
                placeholder="0"
                value={calories}
                onChange={(e) => setCalories(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-zinc-400 hover:text-lime-400" htmlFor="protein-input">P (g)</label>
              <input
                id="protein-input"
                type="number"
                placeholder="0"
                value={protein}
                onChange={(e) => setProtein(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-zinc-400 hover:text-orange-400" htmlFor="fat-input">F (g)</label>
              <input
                id="fat-input"
                type="number"
                placeholder="0"
                value={fat}
                onChange={(e) => setFat(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-zinc-400 hover:text-cyan-400" htmlFor="carbs-input">C (g)</label>
              <input
                id="carbs-input"
                type="number"
                placeholder="0"
                value={carbs}
                onChange={(e) => setCarbs(e.target.value)}
                className="w-full bg-zinc-800 border-0 rounded-lg p-2 text-white text-center text-sm focus:ring-1 focus:ring-lime-400 outline-none"
              />
            </div>
          </div>
          {isAiResult && (
            <p className="text-[10px] text-zinc-600 text-center -mt-1">量が違う場合は、保存前に調整できます</p>
          )}
          <div className="flex gap-2">
            <button type="submit" className="flex-1 bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm shadow-md">
              保存する
            </button>
            <button type="button" onClick={() => { setIsAdding(false); setIsAiResult(false); }} className="flex-1 bg-zinc-800 text-white py-2.5 rounded-xl font-bold text-sm">
              キャンセル
            </button>
          </div>
        </form>
      )}

      {feedbackMsg && (
        <div className="text-xs font-bold text-lime-400 bg-lime-400/10 border border-lime-400/20 rounded-xl px-4 py-2.5 animate-in fade-in duration-200">
          {feedbackMsg}
        </div>
      )}

      {todayMeals.length > 0 ? (
        <div className="space-y-4">
          {todayMeals.map((meal) => (
            <div key={meal.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 flex justify-between items-center">
              <div>
                <h4 className="font-bold text-white text-sm">{meal.name}</h4>
                <div className="flex gap-3 mt-1.5 text-xs font-mono text-zinc-500">
                  <span>P: <strong className="text-white">{meal.protein}g</strong></span>
                  <span>F: <strong className="text-white">{meal.fat}g</strong></span>
                  <span>C: <strong className="text-white">{meal.carbs}g</strong></span>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="font-black text-lime-400 text-md font-mono">{meal.calories}</div>
                  <div className="text-[9px] text-zinc-500 uppercase font-black">kcal</div>
                </div>
                <button type="button" onClick={() => deleteMeal(meal.id)} className="text-zinc-600 hover:text-rose-400 transition-colors">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="h-[40vh] flex flex-col items-center justify-center text-center space-y-4 p-8">
          <div className="w-16 h-16 bg-zinc-900 rounded-full flex items-center justify-center text-zinc-700">
            <Calendar size={32} />
          </div>
          <div>
            <p className="text-white font-bold">今日の食事記録はありません</p>
            <p className="text-zinc-500 text-sm mt-1">「AI写真解析」を使うと、料理の写真から自動でPFCとカロリーを割り出し、一撃で記録できます。</p>
          </div>
        </div>
      )}
    </div>
  );
}
