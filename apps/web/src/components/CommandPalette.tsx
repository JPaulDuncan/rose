import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Inbox,
  Home,
  Calendar as CalendarIcon,
  Settings,
  FileText,
  BookOpen,
  ShieldAlert,
  Megaphone,
  Sparkles,
  Link2,
  Star,
  CloudSun,
  MoonStar,
  Package,
} from 'lucide-react';
import { useApi } from '../lib/api';

type Page = { _id: string; slug: string; title: string };

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
}) {
  const navigate = useNavigate();
  const api = useApi();
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState<Page[]>([]);

  useEffect(() => {
    if (!open) return;
    void api.get<{ pages: Page[] }>('/api/pages?limit=200').then((r) => setPages(r.pages));
  }, [open]);

  function go(to: string) {
    onOpenChange(false);
    navigate(to);
  }

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/40 p-6 pt-32 backdrop-blur-sm animate-fade-in"
      onClick={() => onOpenChange(false)}
    >
      <div className="w-full max-w-xl animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <Command label="Command Palette">
          <Command.Input
            placeholder="Search pages, jump anywhere…"
            value={query}
            onValueChange={setQuery}
            autoFocus
          />
          <Command.List>
            <Command.Empty>No results.</Command.Empty>
            <Command.Group heading="Navigate">
              <Command.Item onSelect={() => go('/')}>
                <Home className="h-4 w-4" /> Home
              </Command.Item>
              <Command.Item onSelect={() => go('/settings/ingest')}>
                <Inbox className="h-4 w-4" /> Ingest queue
              </Command.Item>
              <Command.Item onSelect={() => go('/chat')}>
                <Sparkles className="h-4 w-4" /> Ask the archive
              </Command.Item>
              <Command.Item onSelect={() => go('/search')}>
                <Search className="h-4 w-4" /> Search
              </Command.Item>
              <Command.Item onSelect={() => go('/calendar')}>
                <CalendarIcon className="h-4 w-4" /> Calendar
              </Command.Item>
              <Command.Item onSelect={() => go('/browse')}>
                <BookOpen className="h-4 w-4" /> Browse
              </Command.Item>
              <Command.Item onSelect={() => go('/weather')}>
                <CloudSun className="h-4 w-4" /> Weather
              </Command.Item>
              <Command.Item onSelect={() => go('/moon')}>
                <MoonStar className="h-4 w-4" /> Moon Phase
              </Command.Item>
              <Command.Item onSelect={() => go('/favorites')}>
                <Star className="h-4 w-4" /> Favorites
              </Command.Item>
              <Command.Item onSelect={() => go('/shipments')}>
                <Package className="h-4 w-4" /> Shipment Statuses
              </Command.Item>
              <Command.Item onSelect={() => go('/quarantine')}>
                <ShieldAlert className="h-4 w-4" /> Quarantine
              </Command.Item>
              <Command.Item onSelect={() => go('/promotions')}>
                <Megaphone className="h-4 w-4" /> Promotions
              </Command.Item>
              <Command.Item onSelect={() => go('/settings')}>
                <Settings className="h-4 w-4" /> Settings
              </Command.Item>
            </Command.Group>
            <Command.Group heading="Actions">
              <Command.Item onSelect={() => go('/save')}>
                <Link2 className="h-4 w-4" /> Save URL or document
              </Command.Item>
              <Command.Item onSelect={() => go('/settings/sources')}>
                <Settings className="h-4 w-4" /> Connect a source
              </Command.Item>
            </Command.Group>
            {pages.length > 0 && (
              <Command.Group heading="Pages">
                {pages.slice(0, 50).map((p) => (
                  <Command.Item key={p._id} onSelect={() => go(`/p/${p.slug}`)}>
                    <FileText className="h-4 w-4" /> {p.title}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
