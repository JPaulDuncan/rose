import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { useIdleLogout } from './lib/useIdleLogout';
import { Shell } from './components/Shell';

// Login + Register stay eager — they're tiny, on the unauthenticated
// critical path, and have no shared deps with the protected shell.
import LoginPage from './routes/Login';
import RegisterPage from './routes/Register';

// Every authenticated route is split into its own chunk via React.lazy
// so the initial bundle only has to ship the shell + the route the
// user actually navigates to first. Vite emits one chunk per dynamic
// import; total network bytes are similar but the cold-load cost on
// every page drops dramatically.
const HomePage = lazy(() => import('./routes/Home'));
const PageView = lazy(() => import('./routes/Page'));
const SearchPage = lazy(() => import('./routes/Search'));
const CalendarPage = lazy(() => import('./routes/Calendar'));
const WeatherPage = lazy(() => import('./routes/Weather'));
const MoonPage = lazy(() => import('./routes/Moon'));
const CodexPage = lazy(() => import('./routes/Codex'));
const TagPage = lazy(() => import('./routes/Tag'));
const EntityPage = lazy(() => import('./routes/Entity'));
const EmailView = lazy(() => import('./routes/Email'));
const SenderPage = lazy(() => import('./routes/Sender'));
const QuarantinePage = lazy(() => import('./routes/Quarantine'));
const PromotionsPage = lazy(() => import('./routes/Promotions'));
const HiddenPage = lazy(() => import('./routes/Hidden'));
const ChatPage = lazy(() => import('./routes/Chat'));
const SavePage = lazy(() => import('./routes/Save'));
const FavoritesPage = lazy(() => import('./routes/Favorites'));
const LibraryPage = lazy(() => import('./routes/Library'));
const ShipmentsPage = lazy(() => import('./routes/Shipments'));
const PromoCodesPage = lazy(() => import('./routes/PromoCodes'));

const SettingsLayout = lazy(() => import('./routes/settings/Layout'));
const AccountSettings = lazy(() => import('./routes/settings/Account'));
const SourcesSettings = lazy(() => import('./routes/settings/Sources'));
const RulesSettings = lazy(() => import('./routes/settings/Rules'));
const RecipesSettings = lazy(() => import('./routes/settings/Recipes'));
const IntegrationsSettings = lazy(() => import('./routes/settings/Integrations'));
const InstructionsSettings = lazy(() => import('./routes/settings/Instructions'));
const ModelsSettings = lazy(() => import('./routes/settings/Models'));
const SpamSettings = lazy(() => import('./routes/settings/Spam'));
const NewsletterSettings = lazy(() => import('./routes/settings/Newsletter'));
const IngestPage = lazy(() => import('./routes/settings/Ingest'));
const DaydreamSettingsPage = lazy(() => import('./routes/settings/Daydream'));
const MapsSettingsPage = lazy(() => import('./routes/settings/Maps'));
const TagsSettingsPage = lazy(() => import('./routes/settings/Tags'));
const EntitiesSettingsPage = lazy(() => import('./routes/settings/Entities'));
const LibrarySettingsPage = lazy(() => import('./routes/settings/Library'));
const AdminSettingsPage = lazy(() => import('./routes/settings/Admin'));
const StorageSettingsPage = lazy(() => import('./routes/settings/Storage'));

/**
 * Generic chunk-loading fallback. Plain text rather than a spinner so
 * a fast-loading chunk doesn't briefly flash a busy state — the
 * fallback only appears when the chunk genuinely takes >100ms or so.
 */
function RouteFallback() {
  return (
    <div className="flex h-full min-h-[40vh] items-center justify-center text-sm text-ink-500">
      <span className="animate-pulse">Loading…</span>
    </div>
  );
}

function ProtectedShell() {
  const { user, ready } = useAuth();
  // Idle-timeout watcher. Hook is unconditional (rules of hooks);
  // its effect bails out internally when there's no authenticated
  // user, so unauth renders below still go through the early return.
  useIdleLogout();
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
      <Suspense fallback={<RouteFallback />}>
        <Outlet />
      </Suspense>
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
        <Route path="/n/:key" element={<EntityPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/weather" element={<WeatherPage />} />
        <Route path="/moon" element={<MoonPage />} />
        <Route path="/codex" element={<CodexPage />} />
        {/* Old discovery surfaces folded into /codex — keep redirects so
            existing bookmarks land on the right tab. */}
        <Route path="/browse" element={<Navigate to="/codex" replace />} />
        <Route path="/browse/*" element={<Navigate to="/codex" replace />} />
        <Route path="/streams" element={<Navigate to="/codex?tab=streams" replace />} />
        <Route path="/s/:brandKey" element={<SenderPage />} />
        <Route path="/quarantine" element={<QuarantinePage />} />
        <Route path="/promotions" element={<PromotionsPage />} />
        <Route path="/hidden" element={<HiddenPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
        <Route path="/save" element={<SavePage />} />
        <Route path="/favorites" element={<FavoritesPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/shipments" element={<ShipmentsPage />} />
        <Route path="/promo-codes" element={<PromoCodesPage />} />
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="account" replace />} />
          <Route path="account" element={<AccountSettings />} />
          <Route path="sources" element={<SourcesSettings />} />
          {/* Settings → Senders consolidated into Browse → Senders tab.
              Keep an explicit redirect so old bookmarks land somewhere
              useful rather than the catch-all home redirect. */}
          <Route
            path="senders"
            element={<Navigate to="/codex?tab=senders" replace />}
          />
          <Route path="rules" element={<RulesSettings />} />
          <Route path="recipes" element={<RecipesSettings />} />
          <Route path="integrations" element={<IntegrationsSettings />} />
          <Route path="instructions" element={<InstructionsSettings />} />
          <Route path="models" element={<ModelsSettings />} />
          <Route path="spam" element={<SpamSettings />} />
          <Route path="newsletter" element={<NewsletterSettings />} />
          <Route path="ingest" element={<IngestPage />} />
          <Route path="daydream" element={<DaydreamSettingsPage />} />
          <Route path="maps" element={<MapsSettingsPage />} />
          <Route path="tags" element={<TagsSettingsPage />} />
          <Route path="entities" element={<EntitiesSettingsPage />} />
          <Route path="library" element={<LibrarySettingsPage />} />
          <Route path="admin" element={<AdminSettingsPage />} />
          <Route path="storage" element={<StorageSettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
