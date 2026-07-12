import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, Paperclip, Send, Square } from 'lucide-react';
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
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = scrollAreaRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [chatMessages, isSending]);

  // 🚨【大手術】チャット側にも「自動画像圧縮機能」をがっちり搭載！
  // スマホの巨大な生写真を一瞬で超軽量化し、容量上限による真っ白クラッシュを完全に根絶します！
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    files.forEach((file: File) => {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 800;
        let width = img.width, height = img.height;
        if (width > height) {
          if (width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
        } else {
          if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        setPendingImages(prev => [...prev, canvas.toDataURL('image/jpeg', 0.5)]);
      };
    });
  };

  const onSendClick = () => {
    if (!inputText.trim() && pendingImages.length === 0) return;
    handleSendMessage(inputText, pendingImages);
    setInputText('');
    setPendingImages([]);
  };

  return (
    <div className="flex flex-col" style={{ height: 'calc(100dvh - max(1.5rem, env(safe-area-inset-top)) - 80px)' }}>
      <header className="flex items-center justify-between mb-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 bg-lime-400 rounded-full flex items-center justify-center text-black"><Sparkles size={20} /></div>
          <div>
            <h1 className="text-lg font-bold text-white uppercase italic">AI Trainer</h1>
            <div className="flex items-center gap-1"><div className="w-1.5 h-1.5 bg-lime-400 rounded-full shadow-[0_0_5px_#d9ff00] animate-pulse" /><span className="text-[10px] text-zinc-500 font-bold">ONLINE</span></div>
          </div>
        </div>
      </header>

      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar pt-2 pb-4">
        {chatMessages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center px-6 space-y-5 pt-16">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-cyan-400/25 via-purple-500/25 to-lime-400/30 blur-xl" />
              <div className="relative w-16 h-16 ll-card rounded-full flex items-center justify-center">
                <Sparkles size={26} className="text-lime-400" />
              </div>
            </div>
            <div>
              <p className="text-white font-bold">あなた専属のAIトレーナー</p>
              <p className="text-zinc-500 text-sm mt-1.5 leading-relaxed">今日の食事・トレーニング記録を踏まえて、次の一手を一緒に考えます。</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2 max-w-full">
              {['今日のメニューを組んで', '食事のバランスどう？', 'モチベが上がらない'].map(chip => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setInputText(chip)}
                  className="ll-card rounded-full text-xs text-zinc-300 font-bold px-3.5 py-2 hover:border-lime-400/40 hover:text-white active:scale-95 transition-all whitespace-nowrap"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}

        {chatMessages.map((msg) => (
          <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} max-w-full`}>
            {msg.role === 'user' ? (
              <div className="bg-lime-400 text-black font-medium p-4 rounded-3xl rounded-tr-sm max-w-[85%] text-sm select-text">
                {msg.text}
                {msg.images && msg.images.length > 0 && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    {msg.images.map((img, i) => <img key={i} src={img} alt="添付" className="rounded-lg max-h-32 object-cover" referrerPolicy="no-referrer" />)}
                  </div>
                )}
              </div>
            ) : (
              <div className="ll-card text-zinc-100 p-4 rounded-3xl rounded-tl-sm max-w-[90%] text-sm leading-relaxed space-y-4 select-text">
                <p className="whitespace-pre-line break-words">{msg.text}</p>
                {msg.exercises && msg.exercises.length > 0 && (
                  <div className="ll-inset p-4 space-y-3">
                    <div className="flex items-center gap-2"><Sparkles className="text-lime-400" size={16} /><span className="text-xs font-bold text-lime-400">AI推奨メニュー</span></div>
                    <div className="space-y-2">
                      {msg.exercises.map((ex, i) => (
                        <div key={i} className="flex justify-between text-xs py-1.5 border-b border-zinc-900/50 last:border-0">
                          <span className="font-bold text-white">{ex.name}</span><span className="text-zinc-400 font-mono">{ex.reps}回 × {ex.sets}セット</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <span className="text-[9px] text-zinc-600 mt-1 font-mono">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        ))}

        {isSending && (
          <div className="py-4 px-2 max-w-[90%] flex-shrink-0">
            <div className="flex items-start gap-2.5">
              <div className="relative flex items-center justify-center mt-0.5">
                <div className="absolute w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-400 via-purple-500 to-lime-400 blur-md opacity-40 animate-pulse" />
                <div className="relative p-1.5 bg-zinc-950 text-white rounded-full border border-zinc-800 flex items-center justify-center"><Sparkles size={16} className="text-cyan-400" /></div>
              </div>
              <div className="flex flex-col gap-1 pt-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-lime-400 font-bold text-xs tracking-wide">AIトレーナーが回答を作成中</span>
                  <span className="flex gap-0.5 items-end pb-0.5">
                    <span className="w-1 h-1 rounded-full bg-lime-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1 h-1 rounded-full bg-lime-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1 h-1 rounded-full bg-lime-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                  </span>
                </div>
                <span className="text-zinc-500 text-[10px] tracking-wide">食事内容を分析しています</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2 pt-4 border-t border-zinc-800 flex-shrink-0" style={{ paddingBottom: '0.5rem' }}>
        {pendingImages.length > 0 && (
          <div className="flex gap-2 bg-zinc-900/50 p-2.5 rounded-2xl border border-zinc-800/80 items-center overflow-x-auto">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative group shrink-0">
                <img src={img} alt="プレビュー" className="w-14 h-14 object-cover rounded-xl" referrerPolicy="no-referrer" />
                <button type="button" onClick={() => setPendingImages(prev => prev.filter((_, idx) => idx !== i))} className="absolute -top-1 -right-1 bg-red-500 text-white w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black">✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 items-center">
          <button type="button" onClick={() => fileInputRef.current?.click()} className="w-11 h-11 bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white rounded-xl flex items-center justify-center"><Paperclip size={18} /></button>
          <input type="file" ref={fileInputRef} onChange={handleImageUpload} accept="image/*" multiple className="hidden" />
          <input type="text" placeholder="トレーナーへの相談を入力..." value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSendClick(); }} className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white placeholder:text-zinc-600 focus:ring-1 focus:ring-lime-400 outline-none text-sm" />
          {isSending ? (
            <button type="button" onClick={handleCancelMessage} className="w-11 h-11 bg-rose-500 text-white rounded-xl flex items-center justify-center"><Square size={16} fill="white" /></button>
          ) : (
            <button type="button" onClick={onSendClick} disabled={(!inputText.trim() && pendingImages.length === 0)} className="w-11 h-11 bg-lime-400 text-black disabled:bg-zinc-800 disabled:text-zinc-600 rounded-xl flex items-center justify-center font-bold"><Send size={16} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
