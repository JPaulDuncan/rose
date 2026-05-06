import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

/** Star toggle for a wiki page. Hits /api/pages/:id/favorite and
 *  optimistically flips state; failures snap back. Initial state is
 *  hydrated from /api/page-state/lookup so we don't need to add a
 *  field to the page payload itself. */
export function FavoriteButton({ pageId }: { pageId: string }) {
  const api = useApi();
  const [favorited, setFavorited] = useState<boolean | null>(null);

  useEffect(() => {
    let canceled = false;
    api
      .post<{ states: Record<string, { favorited: boolean }> }>('/api/page-state/lookup', {
        pageIds: [pageId],
      })
      .then((r) => {
        if (canceled) return;
        setFavorited(!!r.states[pageId]?.favorited);
      })
      .catch(() => {
        if (!canceled) setFavorited(false);
      });
    return () => {
      canceled = true;
    };
  }, [api, pageId]);

  const toggle = useMutation({
    mutationFn: async (next: boolean) =>
      api.post<{ ok: true }>(`/api/pages/${pageId}/favorite`, { favorited: next }),
    onError: (err: Error, _next, ctx) => {
      toast.error(err.message);
      if (ctx?.previous != null) setFavorited(ctx.previous);
    },
    onMutate: async (next: boolean) => {
      const previous = favorited;
      setFavorited(next);
      return { previous };
    },
  });

  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={() => toggle.mutate(!favorited)}
      title={favorited ? 'Unfavorite' : 'Favorite'}
      aria-label={favorited ? 'Unfavorite' : 'Favorite'}
    >
      <Star
        className={
          'h-4 w-4 ' +
          (favorited
            ? 'fill-rose-500 text-rose-500'
            : 'text-ink-400 hover:text-rose-500')
        }
      />
    </button>
  );
}
