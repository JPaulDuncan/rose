import { useEffect } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Shell } from './components/Shell';
import LoginPage from './routes/Login';
import RegisterPage from './routes/Register';
import HomePage from './routes/Home';
import PageView from './routes/Page';
import SearchPage from './routes/Search';
import CalendarPage from './routes/Calendar';
import StreamsPage from './routes/Streams';
import TagPage from './routes/Tag';
import EmailView from './routes/Email';
import CodexPage from './routes/Codex';
import SenderPage from './routes/Sender';
import QuarantinePage from './routes/Quarantine';
import PromotionsPage from './routes/Promotions';
import ChatPage from './routes/Chat';
import SavePage from './routes/Save';
import FavoritesPage from './routes/Favorites';
import SettingsLayout from './routes/settings/Layout';
import AccountSettings from './routes/settings/Account';
import SourcesSettings from './routes/settings/Sources';
import SendersSettings from './routes/settings/Senders';
import RulesSettings from './routes/settings/Rules';
import IntegrationsSettings from './routes/settings/Integrations';
import InstructionsSettings from './routes/settings/Instructions';
import ModelsSettings from './routes/settings/Models';
import SpamSettings from './routes/settings/Spam';
import NewsletterSettings from './routes/settings/Newsletter';
import IngestPage from './routes/settings/Ingest';
import DaydreamSettingsPage from './routes/settings/Daydream';

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
        {/* /inbox lived as a top-level page; preserve old bookmarks
            by redirecting to the new home under Settings → Ingest. */}
        <Route path="/inbox" element={<Navigate to="/settings/ingest" replace />} />
        <Route path="/p/:slug" element={<PageView />} />
        <Route path="/e/:id" element={<EmailView />} />
        <Route path="/t/:tag" element={<TagPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/streams" element={<StreamsPage />} />
        <Route path="/codex" element={<CodexPage />} />
        <Route path="/s/:brandKey" element={<SenderPage />} />
        <Route path="/quarantine" element={<QuarantinePage />} />
        <Route path="/promotions" element={<PromotionsPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
        <Route path="/save" element={<SavePage />} />
        <Route path="/favorites" element={<FavoritesPage />} />
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="account" replace />} />
          <Route path="account" element={<AccountSettings />} />
          <Route path="sources" element={<SourcesSettings />} />
          <Route path="senders" element={<SendersSettings />} />
          <Route path="rules" element={<RulesSettings />} />
          <Route path="integrations" element={<IntegrationsSettings />} />
          <Route path="instructions" element={<InstructionsSettings />} />
          <Route path="models" element={<ModelsSettings />} />
          <Route path="spam" element={<SpamSettings />} />
          <Route path="newsletter" element={<NewsletterSettings />} />
          <Route path="ingest" element={<IngestPage />} />
          <Route path="daydream" element={<DaydreamSettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
