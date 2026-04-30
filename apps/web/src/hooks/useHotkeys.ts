import { useEffect, useRef } from 'react';

type Handler = (e: KeyboardEvent) => void;
type Map = Record<string, Handler>;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function matches(combo: string, e: KeyboardEvent): boolean {
  // single-key (e.g. "/", "n")
  if (combo.length === 1) return e.key === combo && !e.metaKey && !e.ctrlKey && !e.altKey;
  if (combo === 'mod+k') return (isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'k';
  return false;
}

export function useHotkeys(map: Map): void {
  const ref = useRef(map);
  ref.current = map;

  useEffect(() => {
    let buffer: string[] = [];
    let timer: number | null = null;

    function clearBuffer() {
      buffer = [];
      if (timer) window.clearTimeout(timer);
      timer = null;
    }

    function onKey(e: KeyboardEvent) {
      // Direct combos
      for (const combo of Object.keys(ref.current)) {
        if (combo.includes(' ')) continue;
        if (matches(combo, e)) {
          ref.current[combo]!(e);
          return;
        }
      }
      // Sequenced (e.g. "g h")
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      buffer.push(e.key);
      if (buffer.length > 2) buffer.shift();
      const combo = buffer.join(' ');
      if (ref.current[combo]) {
        ref.current[combo]!(e);
        clearBuffer();
        return;
      }
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(clearBuffer, 800);
    }

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (timer) window.clearTimeout(timer);
    };
  }, []);
}
