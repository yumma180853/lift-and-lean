import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ResetPassword} from './components/ResetPassword.tsx';
import {VerifyEmail} from './components/VerifyEmail.tsx';
import './index.css';

// メールのリンクから来る画面だけはアプリ本体と分ける。
// ルーターは入れず、パスだけを見分ける（既存の画面遷移は変えない）
const path = window.location.pathname.replace(/\/+$/, '');

const screen = path === '/reset-password' ? <ResetPassword />
  : path === '/verify-email' ? <VerifyEmail />
  : <App />;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {screen}
  </StrictMode>,
);
