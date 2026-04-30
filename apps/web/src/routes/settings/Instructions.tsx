import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Trash2, Star } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

type Instruction = {
  _id: string;
  name: string;
  scope: 'parse' | 'categorize' | 'generate' | 'link' | 'dedupe';
  description: string;
  template: string;
  variables: string[];
  isSystem: boolean;
  isDefault: boolean;
};

const SCOPES = ['parse', 'categorize', 'generate', 'link', 'dedupe'] as const;

export default function InstructionsSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['instructions'],
    queryFn: () => api.get<{ instructions: Instruction[] }>('/api/instructions'),
  });
  const [editing, setEditing] = useState<Instruction | null>(null);

  const save = useMutation({
    mutationFn: async (inst: Instruction) => {
      const body = {
        name: inst.name,
        scope: inst.scope,
        description: inst.description,
        template: inst.template,
        isDefault: inst.isDefault,
      };
      return api.patch<Instruction>(`/api/instructions/${inst._id}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['instructions'] });
      toast.success('Saved');
      setEditing(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const clone = useMutation({
    mutationFn: async (id: string) => api.post<Instruction>(`/api/instructions/${id}/clone`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['instructions'] });
      toast.success('Cloned');
    },
  });

  const setDefault = useMutation({
    mutationFn: async (inst: Instruction) =>
      api.patch<Instruction>(`/api/instructions/${inst._id}`, { isDefault: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instructions'] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => api.del<{ ok: true }>(`/api/instructions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instructions'] }),
  });

  return (
    <div className="space-y-6">
      {SCOPES.map((scope) => {
        const list = (data?.instructions ?? []).filter((i) => i.scope === scope);
        if (!list.length) return null;
        return (
          <div key={scope} className="card">
            <h2 className="mb-3 font-semibold capitalize">{scope}</h2>
            <ul className="space-y-2">
              {list.map((i) => (
                <li
                  key={i._id}
                  className="flex items-center justify-between rounded-lg border border-ink-200 px-3 py-2 text-sm dark:border-ink-800"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      {i.name}
                      {i.isSystem && <span className="pill text-[10px]">system</span>}
                      {i.isDefault && (
                        <span className="pill !bg-rose-100 !text-rose-800 text-[10px]">default</span>
                      )}
                    </div>
                    <div className="truncate text-xs text-ink-500">{i.description}</div>
                  </div>
                  <div className="flex gap-1">
                    {!i.isDefault && (
                      <button
                        className="btn-ghost"
                        onClick={() => setDefault.mutate(i)}
                        title="Make default"
                      >
                        <Star className="h-4 w-4" />
                      </button>
                    )}
                    <button className="btn-ghost" onClick={() => clone.mutate(i._id)} title="Clone">
                      <Copy className="h-4 w-4" />
                    </button>
                    {!i.isSystem && (
                      <button
                        className="btn-ghost text-red-600"
                        onClick={() => remove.mutate(i._id)}
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                    {!i.isSystem && (
                      <button className="btn-secondary text-xs" onClick={() => setEditing(i)}>
                        Edit
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {editing && (
        <div className="card space-y-3">
          <h3 className="font-semibold">Edit “{editing.name}”</h3>
          <input
            className="input"
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
          <textarea
            className="input min-h-[280px] font-mono text-xs"
            value={editing.template}
            onChange={(e) => setEditing({ ...editing, template: e.target.value })}
          />
          <div className="text-xs text-ink-500">
            Variables: {editing.variables.map((v) => `{{${v}}}`).join(', ')}
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn-primary" onClick={() => save.mutate(editing)}>
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
