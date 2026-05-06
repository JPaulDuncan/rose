import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useApi } from './api';

/**
 * Plan 13 (D4) — shared mutation hook for the Settings → Tags and
 * Settings → Entities edit panels. Both surfaces have four near-
 * identical mutations (save / merge / rename / delete) that
 * previously copy-pasted ~80 lines per page; this hook factors them
 * into one place.
 *
 * The two API contracts differ in two small ways that the hook
 * absorbs:
 *
 *  1. **Key field naming.** `/api/tags/canonicals` accepts
 *     `{canonical: …}` on rename and PATCH alias updates;
 *     `/api/entities` accepts `{key: …}`. The `keyField` prop on
 *     each mutation tells the hook which name to send.
 *  2. **Response key naming.** Tag-merge response carries
 *     `{ok, affectedPages}`; tag-rename has `{canonical, …}`;
 *     entity-rename has `{key, …}`. The merge / rename success
 *     toasts read whichever field is present so each surface gets
 *     the right "Renamed to <X>" copy.
 *
 * Per-row inline JSX (the type select for entities, the placeholder
 * copy, the canonical-key helper tip) stays in each settings page —
 * the differences there are real and forcing them into one component
 * would cost more than it saves.
 */
type Mutator = ReturnType<typeof useMutation<unknown, Error, never, unknown>>;
type RenameResp = {
  ok: true;
  affectedPages: number;
  // Tag rename returns `canonical`; entity rename returns `key`.
  canonical?: string;
  key?: string;
};
type MergeResp = { ok: true; affectedPages: number };
type RemoveResp = { ok: true; affectedPages: number };

export function useCanonicalMutations(opts: {
  /** Base url, e.g. `/api/tags/canonicals` or `/api/entities`. */
  apiBase: string;
  /** Stable canonical key for THIS row — used to build the URL. */
  rowKey: string;
  /** Field name the patch / rename body uses. Tags = "canonical",
   *  entities = "key". */
  keyField: 'canonical' | 'key';
  /** Query key to invalidate on success. */
  queryKey: readonly unknown[];
  /** Called after every successful mutation so callers can close
   *  inline-edit panels, etc. */
  onSaved: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { apiBase, rowKey, keyField, queryKey, onSaved } = opts;
  const url = (suffix = '') => `${apiBase}/${encodeURIComponent(rowKey)}${suffix}`;

  const save = useMutation({
    mutationFn: async (vals: {
      displayName: string;
      aliases: string[];
      extraPatch?: Record<string, unknown>;
    }) =>
      api.patch<unknown>(url(), {
        displayName: vals.displayName.trim(),
        aliases: vals.aliases,
        ...(vals.extraPatch ?? {}),
      }),
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey });
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const merge = useMutation({
    mutationFn: async (into: string) =>
      api.post<MergeResp>(url('/merge'), { into }),
    onSuccess: (resp) => {
      toast.success(
        `Merged — ${resp.affectedPages} page${resp.affectedPages === 1 ? '' : 's'} updated`,
      );
      qc.invalidateQueries({ queryKey });
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rename = useMutation({
    mutationFn: async (next: string) =>
      api.post<RenameResp>(url('/rename'), { [keyField]: next }),
    onSuccess: (resp) => {
      const renamed = resp.key ?? resp.canonical ?? '';
      toast.success(
        `Renamed to "${renamed}" — ${resp.affectedPages} page${resp.affectedPages === 1 ? '' : 's'} updated`,
      );
      qc.invalidateQueries({ queryKey });
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (purge: boolean) =>
      api.del<RemoveResp>(`${url()}?purgeFromPages=${purge}`),
    onSuccess: (resp) => {
      toast.success(
        resp.affectedPages > 0
          ? `Deleted — purged from ${resp.affectedPages} page${resp.affectedPages === 1 ? '' : 's'}`
          : 'Deleted',
      );
      qc.invalidateQueries({ queryKey });
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return { save, merge, rename, remove };
}

export type CanonicalMutations = ReturnType<typeof useCanonicalMutations>;
// Re-export the Mutator type as ergonomic alias if any callers want
// to type-narrow against it; not strictly required.
export type { Mutator };
