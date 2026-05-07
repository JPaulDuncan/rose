import type { RecipeCreateRequest } from '@rose/shared';

/**
 * Starter recipe gallery. Each entry is a fully-formed
 * RecipeCreateRequest plus presentation metadata — the wizard pulls
 * one in via `?template=<id>`, the user tweaks the placeholders, and
 * saves. Keep the list small and useful: every entry should answer
 * "I want to do X with my mail" out of the box.
 */
export type RecipeTemplate = {
  id: string;
  title: string;
  /** Short newspaper-style dek shown under the title. */
  description: string;
  /** Free-form category for grouping in the gallery. */
  category: 'shipping' | 'spam' | 'productivity' | 'finance' | 'ai' | 'notify';
  /** Lucide icon name surfaced in the UI. Validated client-side. */
  icon: string;
  /** What to fill into the wizard. */
  recipe: Omit<RecipeCreateRequest, 'name' | 'description'> & {
    name: string;
    description?: string;
  };
};

export const RECIPE_TEMPLATES: RecipeTemplate[] = [
  {
    id: 'push-from-boss',
    title: 'Push when my boss emails',
    description: 'Send a push notification the moment a sender you flag as important shows up.',
    category: 'notify',
    icon: 'Bell',
    recipe: {
      name: 'Push: VIP sender',
      description: 'Replace boss@example.com with the address you actually care about.',
      trigger: {
        kind: 'email.ingested',
        config: { senderContains: 'boss@example.com' },
      },
      conditions: [],
      actions: [{ kind: 'notify.push', config: {} }],
      cooldownSeconds: 60,
      fireLimitPerHour: 30,
    },
  },
  {
    id: 'amazon-receipts',
    title: 'File Amazon receipts as Shopping',
    description: 'Auto-tag and categorise every Amazon order receipt so they roll up in one place.',
    category: 'finance',
    icon: 'ShoppingBag',
    recipe: {
      name: 'File: Amazon receipts',
      description: 'Tweak the brand key if you use a different Amazon storefront.',
      trigger: {
        kind: 'page.created',
        config: {},
      },
      conditions: [
        { kind: 'sender.brand', config: { brandKey: 'amazon' } },
      ],
      actions: [
        { kind: 'tag.add', config: { tag: 'shopping' } },
        { kind: 'category.set', config: { name: 'Shopping' } },
      ],
      cooldownSeconds: 0,
      fireLimitPerHour: 200,
    },
  },
  {
    id: 'package-out-for-delivery',
    title: 'Notify when a package is out for delivery',
    description: 'Push the headline the moment a carrier email mentions "out for delivery".',
    category: 'shipping',
    icon: 'Truck',
    recipe: {
      name: 'Notify: out for delivery',
      trigger: {
        kind: 'email.ingested',
        config: { subjectContains: 'out for delivery' },
      },
      conditions: [],
      actions: [
        { kind: 'notify.push', config: { title: 'Package on the way' } },
      ],
      cooldownSeconds: 30 * 60,
      fireLimitPerHour: 20,
    },
  },
  {
    id: 'archive-newsletters',
    title: 'Archive newsletters automatically',
    description: 'Quietly archive any incoming email tagged as a newsletter so the inbox stays clean.',
    category: 'productivity',
    icon: 'Archive',
    recipe: {
      name: 'Archive: newsletters',
      trigger: { kind: 'email.ingested', config: {} },
      conditions: [{ kind: 'tag.contains', config: { tag: 'newsletter' } }],
      actions: [{ kind: 'email.archive', config: {} }],
      cooldownSeconds: 0,
      fireLimitPerHour: 200,
    },
  },
  {
    id: 'block-known-spammer',
    title: 'Block a known spammer outright',
    description: 'Stop a single noisy sender at ingest time and purge what they\'ve already sent.',
    category: 'spam',
    icon: 'Ban',
    recipe: {
      name: 'Block: noisy sender',
      description: 'Replace noisy@example.com before saving. Fires once per matching email.',
      trigger: {
        kind: 'email.ingested',
        config: { senderContains: 'noisy@example.com' },
      },
      conditions: [],
      actions: [
        { kind: 'email.block', config: { removeExisting: true } },
      ],
      cooldownSeconds: 0,
      fireLimitPerHour: 5,
    },
  },
  {
    id: 'llm-summarise-high-priority',
    title: 'LLM-summarise high-priority emails',
    description: 'Run a one-sentence summary through your model and push the result.',
    category: 'ai',
    icon: 'Sparkles',
    recipe: {
      name: 'AI: summarise priority mail',
      trigger: { kind: 'email.ingested', config: {} },
      conditions: [{ kind: 'priority.is', config: { priority: 'high' } }],
      actions: [
        {
          kind: 'llm.run',
          config: {
            prompt:
              'Summarise this email in one sentence (≤140 chars). Subject: {{subject}}\n\nBody:\n{{body}}',
            output: 'push',
            pushTitle: '{{from}}',
            maxTokens: 120,
          },
        },
      ],
      cooldownSeconds: 60,
      fireLimitPerHour: 60,
    },
  },
  {
    id: 'webhook-on-bug-tag',
    title: 'POST to a webhook on the #bug tag',
    description: 'Forward articles tagged #bug to your bug tracker via webhook.',
    category: 'productivity',
    icon: 'Webhook',
    recipe: {
      name: 'Webhook: bug tag',
      description: 'Replace the URL with your tracker\'s inbound webhook before enabling.',
      trigger: { kind: 'tag.applied', config: { tag: 'bug' } },
      conditions: [],
      actions: [
        {
          kind: 'webhook.post',
          config: { url: 'https://example.com/inbox/rose-bugs' },
        },
      ],
      cooldownSeconds: 0,
      fireLimitPerHour: 60,
    },
  },
];
