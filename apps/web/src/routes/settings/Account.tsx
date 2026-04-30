import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';

export default function AccountSettings() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="mb-2 font-semibold">Profile</h2>
        <div className="text-sm">
          <div>
            <span className="text-ink-500">Email:</span> {user?.email}
          </div>
          <div>
            <span className="text-ink-500">Name:</span> {user?.displayName}
          </div>
        </div>
      </div>
      <div className="card">
        <h2 className="mb-2 font-semibold">Theme</h2>
        <div className="flex gap-2">
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              className={theme === t ? 'btn-primary' : 'btn-secondary'}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <button className="btn-secondary" onClick={logout}>
        Sign out
      </button>
    </div>
  );
}
