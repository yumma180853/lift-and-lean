import React, { useState, useEffect, useRef } from 'react';
import { 
  Sparkles, 
  MessageSquare, 
  Plus, 
  Trash2, 
  Paperclip, 
  Send, 
  Square 
} from 'lucide-react';
import { motion } from 'motion/react';
import { ChatMessage, UserGoals, Workout, Tab } from '../types';

export interface SectionAITrainerProps {
  chatMessages: ChatMessage[];
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  currentWeight: number | null;
  goals: UserGoals;
  today: string;
  todayWorkout: Workout | undefined;
  setWorkouts: React.Dispatch<React.SetStateAction<Workout[]>>;
  setActiveTab: (tab: Tab) => void;
  isSending: boolean;
  handleSendMessage: (text: string, images: string[]) => void;
  handleCancelMessage: () => void;
}

export function SectionAITrainer({
  chatMessages,
  setChatMessages,
  currentWeight,
  goals,
  today,
  todayWorkout,
  setWorkouts,
  setActiveTab,
  isSending,
  handleSendMessage,
  handleCancelMessage
}: SectionAITrainerProps) {
  const [inputText, setInputText] = useState('');
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages, isSending]);

  // 🚨【大手術】チャット側にも「自動画像圧縮機能」をがっちり搭載！
  // スマホの巨大な生写真を一瞬で1024px以下に超軽量化し、メモリ破裂（真っ白クラッシュ）を完全に根絶します！
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    files.forEach((file: File) => {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 1024;
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxDim) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          }
        } else {
          if (height > maxDim) {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        
        const base64Data = canvas.toDataURL('image/jpeg', 0.6); // 画質を適度に落として極小サイズに
        setPendingImages(prev => [...prev, base64Data]);
      };
    });
  };

  const onSendClick = () => {
    if (!inputText.trim() && pendingImages.length === 0) return;
    handleSendMessage(inputText, pendingImages);
    setInputText('');
    setPendingImages([]);
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
            <div>
              <p className="text-white font-bold">LIFT & LEAN AI</p>
              <p className="text-zinc-500 text-sm mt-1">
                目標達成への課題、限界、理想を共有してください。プロトレーナーとして、最適な戦略と本日の専用メニューを構築します。
              </p>
            </div>
          </div>
        )}

        {chatMessages.map((msg) => (
          <div 
            key={msg.id} 
            className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} max-w-full`}
          >
            {msg.role === 'user' ? (
              <div className="bg-lime-400 text-black font-medium p-4 rounded-3xl rounded-tr-sm max-w-[85%] text-sm select-text">
                {msg.text}
                {msg.images && msg.images.length > 0 && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    {msg.images.map((img, i) => (
                      <img 
                        key={i} 
                        src={img} 
                        alt="添付画像" 
                        className="rounded-lg max-h-32 object-cover" 
                        referrerPolicy="no-referrer"
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-zinc-900 border border-zinc-800 text-zinc-100 p-4 rounded-3xl rounded-tl-sm max-w-[90%] text-sm leading-relaxed space-y-4 select-text shadow-md">
                <p className="whitespace-pre-line">{msg.text}</p>
                {msg.exercises && msg.exercises.length > 0 && (
                  <div className="bg-zinc-950 rounded-2xl p-4 border border-zinc-800 space-y-3">
                    <div className="flex items-center gap-2">
                      <Sparkles className="text-lime-400" size={16} />
                      <span className="text-xs font-bold text-lime-400">AI推奨メニュー</span>
                    </div>
                    <div className="space-y-2">
                      {msg.exercises.map((ex, i) => (
                        <div key={i} className="flex justify-between text-xs py-1.5 border-b border-zinc-900/50 last:border-0">
                          <span className="font-bold text-white">{ex.name}</span>
                          <span className="text-zinc-400 font-mono">{ex.reps}レップ × {ex.sets}セット</span>
                        </div>
                      ))}
                    </div>
                    <button 
                      type="button"
                      onClick={() => addSuggestedToWorkout(msg.exercises!)}
                      className="w-full bg-lime-400 text-black py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-lime-300 transition-colors"
                    >
                      <Plus size={14} /> 今日のトレーニング記録に追加
                    </button>
                  </div>
                )}
              </div>
            )}
            <span className="text-[9px] text-zinc-600 mt-1 font-mono tracking-wider">
              {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        ))}

        {isSending && (
          <div className="py-4 px-2 space-y-4 max-w-[90%] flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="relative flex items-center justify-center">
                <div className="absolute w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-400 via-purple-500 to-lime-400 blur-md opacity-40 animate-pulse" />
                <motion.div 
                  className="relative p-1.5 bg-zinc-950 text-white rounded-full border border-zinc-800 flex items-center justify-center shadow-lg"
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 4, ease: "linear" }}
                >
                  <Sparkles size={16} className="text-cyan-400 drop-shadow-[0_0_8px_#22d3ee]" />
                </motion.div>
              </div>
              <div className="text-zinc-400 font-bold text-xs tracking-widest animate-pulse">
                GEMINI AI IS SYNTHESIZING...
              </div>
            </div>
            
            <div className="space-y-2 pl-9 w-64">
              <div className="relative w-full h-1.5 overflow-hidden rounded-full bg-zinc-900/50 border border-zinc-850 shadow-inner">
                <div className="absolute inset-y-0 w-[400%] -left-full bg-gradient-to-r from-transparent via-[#d9ff00]/60 via-[#00f5ff]/60 via-[#9d00ff]/60 via-[#d9ff00]/60 to-transparent animate-gemini-flow-1" />
                <div className="absolute inset-y-0 w-[400%] -left-full bg-gradient-to-r from-transparent via-[#00f5ff]/40 via-[#d9ff00]/30 via-[#9d00ff]/50 via-transparent to-transparent animate-gemini-flow-2 opacity-80" />
              </div>
              
              <div className="relative w-11/12 h-1 overflow-hidden rounded-full bg-zinc-900/50 border border-zinc-850 shadow-inner opacity-75">
                <div className="absolute inset-y-0 w-[450%] -left-full bg-gradient-to-r from-[#9d00ff]/20 via-[#ff007c]/40 via-[#00f5ff]/50 via-transparent to-[#9d00ff]/20 animate-gemini-flow-3" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="space-y-2 py-4 border-t border-zinc-800 flex-shrink-0">
        {pendingImages.length > 0 && (
          <div className="flex gap-2 bg-zinc-900/50 p-2.5 rounded-2xl border border-zinc-800/80 items-center overflow-x-auto">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative group shrink-0">
                <img src={img} alt="プレビュー" className="w-14 h-14 object-cover rounded-xl" referrerPolicy="no-referrer" />
                <button 
                  type="button"
                  onClick={() => setPendingImages(prev => prev.filter((_, idx) => idx !== i))}
                  className="absolute -top-1 -right-1 bg-red-500 text-white w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 items-center">
          <button 
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-11 h-11 bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white rounded-xl flex items-center justify-center transition-all duration-300 relative group overflow-hidden"
          >
            <Paperclip size={18} />
          </button>
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleImageUpload} 
            accept="image/*" 
            multiple 
            className="hidden" 
          />

          <input 
            type="text" 
            placeholder="トレーナーへの相談を入力..." 
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSendClick();
              }
            }}
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white placeholder:text-zinc-600 focus:ring-1 focus:ring-lime-400 outline-none text-sm"
          />

          {isSending ? (
            <button 
              type="button"
              onClick={handleCancelMessage}
              className="w-11 h-11 bg-rose-500 text-white rounded-xl flex items-center justify-xl shadow-lg shadow-rose-500/20 active:scale-95 transition-all duration-300"
              title="生成を中断"
            >
              <Square size={16} fill="white" />
            </button>
          ) : (
            <button 
              type="button"
              onClick={onSendClick}
              disabled={(!inputText.trim() && pendingImages.length === 0)}
              className="w-11 h-11 bg-lime-400 text-black disabled:bg-zinc-800 disabled:text-zinc-600 rounded-xl flex items-center justify-center font-bold shadow-lg shadow-lime-400/10 active:scale-95 transition-all duration-300"
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes gemini-flow-1 {
          0% { transform: translateX(-50%); }
          100% { transform: translateX(50%); }
        }
        @keyframes gemini-flow-2 {
          0% { transform: translateX(30%); }
          100% { transform: translateX(-70%); }
        }
        @keyframes gemini-flow-3 {
          0% { transform: translateX(-20%); }
          100% { transform: translateX(80%); }
        }
        .animate-gemini-flow-1 {
          animation: gemini-flow-1 2.2s linear infinite;
        }
        .animate-gemini-flow-2 {
          animation: gemini-flow-2 3.2s linear infinite;
        }
        .animate-gemini-flow-3 {
          animation: gemini-flow-3 4s linear infinite;
        }
      `}</style>
    </div>
  );
}
