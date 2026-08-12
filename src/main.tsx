import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ResetPassword} from './components/ResetPassword.tsx';
import './index.css';

// パスワード再設定だけはアプリ本体と別画面。
// ルーターは入れず、メールのリンク先パスだけを見分ける（既存の画面遷移は変えない）
const isResetPassword = window.location.pathname.replace(/\/+$/, '') === '/reset-password';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isResetPassword ? <ResetPassword /> : <App />}
  </StrictMode>,
);
