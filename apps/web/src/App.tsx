import { useEffect } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Shell } from './components/Shell';
import LoginPage from './routes/Login';
import RegisterPage from './routes/Register';
import HomePage from './routes/Home';
import InboxPage from './routes/Inbox';
import PageView from './routes/Page';
import SearchPage from './routes/Search';
import GraphPage from './routes/Graph';
import SettingsLayout from './routes/settings/Layout';
import AccountSettings from './routes/settings/Account';
import SourcesSettings from './routes/settings/Sources';
import InstructionsSettings from './routes/settings/Instructions';
import ModelsSettings from './routes/settings/Models';

function ProtectedShell() {
  const { user, ready } = useAuth();
  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-500">
        <span className="animate-pulse">Loading…</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<ProtectedShell />}>
        <Route index element={<HomePage />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/p/:slug" element={<PageView />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/graph" element={<GraphPage />} />
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="account" replace />} />
          <Route path="account" element={<AccountSettings />} />
          <Route path="sources" element={<SourcesSettings />} />
          <Route path="instructions" element={<InstructionsSettings />} />
          <Route path="models" element={<ModelsSettings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
