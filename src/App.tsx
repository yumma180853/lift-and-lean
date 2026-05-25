import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Activity, Utensils, BarChart3, Settings, Dumbbell, Sparkles } from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { UserGoals, WeightRecord, Workout, Meal, ChatMessage, Tab } from './types';
import { SectionDashboard } from './components/SectionDashboard';
import { SectionWorkout } from './components/SectionWorkout';
import { SectionDiet } from './components/SectionDiet';
import { SectionAnalysis } from './components/SectionAnalysis';
import { SectionAITrainer } from './components/SectionAITrainer';
import { SectionSettings } from './components/SectionSettings';

function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

// 🚨【真っ白クラッシュ完全防衛盾】スマホ自爆を200%防ぐ安全IDジェネレーター
const safeUUID = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
};

const DEFAULT_GOALS: UserGoals = { calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 70 };

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [weightHistory, setWeightHistory] = useState<WeightRecord[]>([]);
  const [goals, setGoals] = useState<UserGoals>(DEFAULT_GOALS);
  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isWeightModalOpen, setIsWeightModalOpen] = useState(false);
  const [modalWeight, setModalWeight] = useState('');
  const [isSendingChat, setIsSendingChat] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const savedWorkouts = localStorage.getItem('workouts');
      const savedMeals = localStorage.getItem('meals');
      const savedWeight = localStorage.getItem('weight_history');
      const savedGoals = localStorage.getItem('user_goals');
      const savedReminders = localStorage.getItem('reminders_enabled');
      const savedChat = localStorage.getItem('chat_messages');
      if (savedWorkouts) { const parsed = JSON.parse(savedWorkouts); if (Array.isArray(parsed)) setWorkouts(parsed); }
      if (savedMeals) { const parsed = JSON.parse(savedMeals); if (Array.isArray(parsed)) setMeals(parsed); }
      if (savedWeight) { const parsed = JSON.parse(savedWeight); if (Array.isArray(parsed)) setWeightHistory(parsed); }
      if (savedGoals) { const parsed = JSON.parse(savedGoals); setGoals({ ...DEFAULT_GOALS, ...parsed }); }
      if (savedReminders) setRemindersEnabled(JSON.parse(savedReminders));
      if (savedChat) { const parsed = JSON.parse(savedChat); if (Array.isArray(parsed)) setChatMessages(parsed); }
    } catch (e) { console.error(e); }
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    localStorage.setItem('workouts', JSON.stringify(workouts));
    localStorage.setItem('meals', JSON.stringify(meals));
    localStorage.setItem('weight_history', JSON.stringify(weightHistory));
    localStorage.setItem('user_goals', JSON.stringify(goals));
    localStorage.setItem('reminders_enabled', JSON.stringify(remindersEnabled));
    localStorage.setItem('chat_messages', JSON.stringify(chatMessages));
  }, [workouts, meals, weightHistory, goals, remindersEnabled, chatMessages, isLoaded]);

  useEffect(() => { return () => { if (abortControllerRef.current) abortControllerRef.current.abort(); }; }, []);

  useEffect(() => {
    if (remindersEnabled && isLoaded) {
      const today = format(new Date(), 'yyyy-MM-dd');
      const hasWeightToday = weightHistory.some(w => w.date === today);
      if (!hasWeightToday && Notification.permission === 'granted') {
        const hour = new Date().getHours();
        if (hour >= 6 && hour <= 11) { new Notification('LIFT & LEAN', { body: 'おはようございます！今日の体重を記録しましょう。', icon: '/favicon.ico' }); }
      }
    }
  }, [remindersEnabled, weightHistory, isLoaded]);

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) { alert('このブラウザは通知に対応していません。'); return; }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') { setRemindersEnabled(true); } else { alert('通知設定を許可してください。'); }
  };

  const handleSendMessage = async (text: string, images: string[]) => {
    if (!text.trim() && images.length === 0) return;
    const userMsg: ChatMessage = { id: safeUUID(), role: 'user', text, images, timestamp: new Date().toISOString() };
    setChatMessages(prev => [...prev, userMsg]);
    setIsSendingChat(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const response = await fetch('/api/chat-trainer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          message: userMsg.text, images: userMsg.images, workouts: todayWorkout ? [todayWorkout] : [], meals: todayMeals,
          userData: { weight: currentWeight || 0, targetWeight: goals.targetWeight, calories: goals.calories, protein: goals.protein, fat: goals.fat, carbs: goals.carbs }
        }),
