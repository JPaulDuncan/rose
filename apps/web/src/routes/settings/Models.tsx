import { useState } from 'react';
import toast from 'react-hot-toast';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/api';

export default function ModelsSettings() {
  const api = useApi();
  const { user, setSession, token } = useAuth();
  const [gen, setGen] = useState(user?.settings?.defaultGenerationModel ?? 'llama3.1:8b-instruct');
  const [emb, setEmb] = useState(user?.settings?.defaultEmbeddingModel ?? 'nomic-embed-text');

  async function save() {
    try {
      const r = await api.patch<{ user: typeof user }>(`/api/me`, {
        settings: {
          ...user?.settings,
          defaultGenerationModel: gen,
          defaultEmbeddingModel: emb,
        },
      });
      if (r.user && token) setSession({ token, user: r.user });
      toast.success('Saved');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="card space-y-4">
      <div>
        <label className="mb-1 block text-sm text-ink-600 dark:text-ink-300">
          Generation model
        </label>
        <input className="input" value={gen} onChange={(e) => setGen(e.target.value)} />
        <p className="mt-1 text-xs text-ink-500">
          Any locally-pulled Ollama model. Default: <code>llama3.1:8b-instruct</code>.
        </p>
      </div>
      <div>
        <label className="mb-1 block text-sm text-ink-600 dark:text-ink-300">
          Embedding model
        </label>
        <input className="input" value={emb} onChange={(e) => setEmb(e.target.value)} />
        <p className="mt-1 text-xs text-ink-500">
          Used for semantic search. Default: <code>nomic-embed-text</code>.
        </p>
      </div>
      <button className="btn-primary" onClick={save}>
        Save
      </button>
    </div>
  );
}
