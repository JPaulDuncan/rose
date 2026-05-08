import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, X } from 'lucide-react';

/**
 * App-wide replacement for `window.confirm` and `window.prompt`.
 * Browser-native dialogs collapse multi-line copy, render without
 * typography, and on some platforms steal focus from the SPA in
 * ways that make destructive flows feel unsafe. The audit in
 * .devlogs/UX-Review-1.md has the broader case.
 *
 * Usage:
 *
 *   const confirm = useConfirm();
 *   const ok = await confirm({
 *     title: 'Block sender?',
 *     body: 'Future mail from this sender is dropped at ingest.',
 *     confirmLabel: 'Block',
 *     destructive: true,
 *   });
 *
 * Returns true when the user clicks the confirm button, false on
 * cancel / Escape / backdrop click. Single-instance — opening a
 * second confirm while one is already pending replaces the first
 * (unlikely in practice, but protects against double-fire bugs).
 *
 * For text-prompt cases (Save search, etc.) use `prompt` from the
 * same hook — same pattern, returns string | null.
 */

type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** When set, the confirm button stays disabled until the user
   *  types this exact string into a verification input. Used for
   *  high-stakes actions like deleting a wiki page. */
  typeToConfirm?: string;
};

type PromptOptions = {
  title: string;
  body?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type ConfirmContextValue = {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
};

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

type ConfirmRequest =
  | ({ kind: 'confirm'; resolve: (v: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; resolve: (v: string | null) => void } & PromptOptions);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const pendingRef = useRef<ConfirmRequest | null>(null);

  // Keep the ref in sync so the imperative confirm()/prompt() can
  // resolve a stale request when a new one arrives.
  pendingRef.current = request;

  const close = useCallback((value: boolean | string | null) => {
    setRequest((cur) => {
      if (!cur) return null;
      if (cur.kind === 'confirm') cur.resolve(typeof value === 'boolean' ? value : false);
      else cur.resolve(typeof value === 'string' ? value : null);
      return null;
    });
  }, []);

  const value = useMemo<ConfirmContextValue>(
    () => ({
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          // If a confirm is already open, cancel it before showing
          // the new one — the second call is the one the user is
          // currently engaging with.
          const prev = pendingRef.current;
          if (prev) {
            if (prev.kind === 'confirm') prev.resolve(false);
            else prev.resolve(null);
          }
          setRequest({ kind: 'confirm', resolve, ...opts });
        }),
      prompt: (opts) =>
        new Promise<string | null>((resolve) => {
          const prev = pendingRef.current;
          if (prev) {
            if (prev.kind === 'confirm') prev.resolve(false);
            else prev.resolve(null);
          }
          setRequest({ kind: 'prompt', resolve, ...opts });
        }),
    }),
    [],
  );

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {request && <ConfirmDialog request={request} onClose={close} />}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}

function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest;
  onClose: (value: boolean | string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [verifyText, setVerifyText] = useState('');
  const [promptValue, setPromptValue] = useState(
    request.kind === 'prompt' ? request.defaultValue ?? '' : '',
  );

  // Focus the cancel button by default for confirms (safer default
  // for destructive actions) and the input for prompts.
  useEffect(() => {
    if (request.kind === 'prompt') inputRef.current?.focus();
    else cancelRef.current?.focus();
  }, [request]);

  // Keyboard support: Escape cancels, Enter confirms when valid.
  // Plain Enter submits prompts and non-destructive confirms (the
  // common "yes, continue" reflex). Destructive confirms require
  // ⌘/Ctrl+Enter so a stray keystroke can't fire a Block / Delete
  // button the user hasn't deliberately focused. UX-Review-2 §7.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose(request.kind === 'confirm' ? false : null);
        return;
      }
      if (e.key !== 'Enter') return;
      const destructive =
        request.kind === 'confirm' && request.destructive === true;
      const requiresModifier = destructive;
      const hasModifier = e.metaKey || e.ctrlKey;
      if (requiresModifier && !hasModifier) return;
      e.preventDefault();
      if (request.kind === 'prompt') onClose(promptValue);
      else if (canSubmit) onClose(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const canSubmit =
    request.kind === 'prompt'
      ? promptValue.trim().length > 0
      : !request.typeToConfirm || verifyText === request.typeToConfirm;

  const confirmLabel =
    request.kind === 'prompt'
      ? request.confirmLabel ?? 'Save'
      : request.confirmLabel ?? (request.destructive ? 'Confirm' : 'OK');
  const cancelLabel = request.cancelLabel ?? 'Cancel';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <div
        className="absolute inset-0 bg-ink-950/40 backdrop-blur-sm"
        onClick={() => onClose(request.kind === 'confirm' ? false : null)}
      />
      <div className="relative w-full max-w-md rounded-xl border border-ink-200 bg-white p-5 shadow-xl dark:border-ink-800 dark:bg-ink-950">
        <button
          type="button"
          onClick={() => onClose(request.kind === 'confirm' ? false : null)}
          aria-label="Close"
          className="absolute right-3 top-3 text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-start gap-3">
          {request.kind === 'confirm' && request.destructive && (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          )}
          <div className="min-w-0 flex-1">
            <h2 id="confirm-title" className="text-base font-semibold">
              {request.title}
            </h2>
            {request.body && (
              <div className="mt-2 text-sm text-ink-600 dark:text-ink-300">
                {request.body}
              </div>
            )}
            {request.kind === 'prompt' && (
              <input
                ref={inputRef}
                type="text"
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                placeholder={request.placeholder}
                className="mt-3 w-full rounded-md border border-ink-300 bg-white px-2 py-1.5 text-sm focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500 dark:border-ink-700 dark:bg-ink-900"
              />
            )}
            {request.kind === 'confirm' && request.typeToConfirm && (
              <div className="mt-3">
                <label className="text-xs text-ink-500">
                  Type{' '}
                  <span className="font-mono font-semibold text-ink-700 dark:text-ink-200">
                    {request.typeToConfirm}
                  </span>{' '}
                  to confirm:
                </label>
                <input
                  type="text"
                  value={verifyText}
                  onChange={(e) => setVerifyText(e.target.value)}
                  className="mt-1 w-full rounded-md border border-ink-300 bg-white px-2 py-1.5 text-sm font-mono focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500 dark:border-ink-700 dark:bg-ink-900"
                />
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onClose(request.kind === 'confirm' ? false : null)}
            className="rounded-md border border-ink-300 bg-white px-3 py-1.5 text-sm hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-900 dark:hover:bg-ink-800"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() =>
              onClose(request.kind === 'prompt' ? promptValue : true)
            }
            disabled={!canSubmit}
            className={
              'rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 ' +
              (request.kind === 'confirm' && request.destructive
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-rose-600 hover:bg-rose-700')
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
