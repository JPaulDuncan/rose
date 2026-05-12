import { describe, it, expect } from 'vitest';
import {
  triggerMatches,
  conditionMatches,
  evaluateRecipe,
  type Trigger,
  type Condition,
  type RecipeEvent,
} from '@rose/shared';

/**
 * Recipe trigger/condition matcher tests. The matcher is shared
 * between the worker dispatcher and the API dry-run endpoint; they
 * have to agree exactly or "would it fire?" answers diverge from
 * what actually fires. These tests pin the kinds we care about
 * most (email + subscription) at the boundaries that bit us before.
 */

const SUB_CREATED_EVENT: RecipeEvent = {
  kind: 'subscription.created',
  userId: 'u1',
  subscriptionId: 's1',
  serviceKey: 'spotify',
  serviceName: 'Spotify Premium',
  brandKey: 'spotify',
  amount: 11.99,
  currency: 'USD',
  cadence: 'monthly',
  category: 'media',
  pageId: 'p1',
  slug: 'spotify',
  title: 'Spotify receipt',
};

const SUB_RENEWED_EVENT: RecipeEvent = {
  ...SUB_CREATED_EVENT,
  kind: 'subscription.renewed',
};

describe('triggerMatches — subscription.*', () => {
  it('subscription.created trigger fires on created event', () => {
    const t: Trigger = { kind: 'subscription.created', config: {} };
    expect(triggerMatches(t, SUB_CREATED_EVENT)).toBe(true);
  });

  it('does not fire when the event kind is renewed', () => {
    const t: Trigger = { kind: 'subscription.created', config: {} };
    expect(triggerMatches(t, SUB_RENEWED_EVENT)).toBe(false);
  });

  it('serviceContains narrows by service-name substring (case-insensitive)', () => {
    const t: Trigger = {
      kind: 'subscription.created',
      config: { serviceContains: 'spot' },
    };
    expect(triggerMatches(t, SUB_CREATED_EVENT)).toBe(true);

    const t2: Trigger = {
      kind: 'subscription.created',
      config: { serviceContains: 'netflix' },
    };
    expect(triggerMatches(t2, SUB_CREATED_EVENT)).toBe(false);
  });

  it('categories array narrows by category', () => {
    const t: Trigger = {
      kind: 'subscription.created',
      config: { categories: ['media', 'news'] },
    };
    expect(triggerMatches(t, SUB_CREATED_EVENT)).toBe(true);

    const t2: Trigger = {
      kind: 'subscription.created',
      config: { categories: ['cloud'] },
    };
    expect(triggerMatches(t2, SUB_CREATED_EVENT)).toBe(false);
  });

  it('null event category never matches a categories filter', () => {
    const t: Trigger = {
      kind: 'subscription.created',
      config: { categories: ['media'] },
    };
    const eventWithoutCategory: RecipeEvent = {
      ...SUB_CREATED_EVENT,
      category: null,
    };
    expect(triggerMatches(t, eventWithoutCategory)).toBe(false);
  });

  it('renewal trigger fires on renewal event with same filter shape', () => {
    const t: Trigger = {
      kind: 'subscription.renewed',
      config: { serviceContains: 'spotify' },
    };
    expect(triggerMatches(t, SUB_RENEWED_EVENT)).toBe(true);
  });
});

describe('triggerMatches — email.ingested regression', () => {
  const event: RecipeEvent = {
    kind: 'email.ingested',
    userId: 'u1',
    emailId: 'e1',
    from: 'noreply@stripe.com',
    subject: 'Your receipt for $42.00',
    brandKey: 'stripe',
    priority: 'normal',
    tags: ['receipt'],
  };

  it('senderContains is case-insensitive', () => {
    const t: Trigger = {
      kind: 'email.ingested',
      config: { senderContains: 'STRIPE' },
    };
    expect(triggerMatches(t, event)).toBe(true);
  });

  it('brandKey matches exact lowercase', () => {
    const t: Trigger = {
      kind: 'email.ingested',
      config: { brandKey: 'stripe' },
    };
    expect(triggerMatches(t, event)).toBe(true);
  });

  it('brandKey mismatch blocks fire', () => {
    const t: Trigger = {
      kind: 'email.ingested',
      config: { brandKey: 'paypal' },
    };
    expect(triggerMatches(t, event)).toBe(false);
  });
});

describe('conditionMatches', () => {
  const pageEvent: RecipeEvent = {
    kind: 'page.created',
    userId: 'u1',
    pageId: 'p1',
    slug: 'a-page',
    title: 'A page',
    tags: ['budget', 'monthly'],
    categoryId: null,
    brandKeys: ['stripe', 'amazon'],
    priority: 'high',
  };

  it('tag.contains matches a tag on the event (case-insensitive)', () => {
    const c: Condition = { kind: 'tag.contains', config: { tag: 'Monthly' } };
    expect(conditionMatches(c, pageEvent)).toBe(true);
  });

  it('tag.contains misses when the tag is not present', () => {
    const c: Condition = { kind: 'tag.contains', config: { tag: 'weekly' } };
    expect(conditionMatches(c, pageEvent)).toBe(false);
  });

  it('sender.brand matches an entry in brandKeys for a page event', () => {
    const c: Condition = {
      kind: 'sender.brand',
      config: { brandKey: 'amazon' },
    };
    expect(conditionMatches(c, pageEvent)).toBe(true);
  });

  it('priority.is matches the event priority', () => {
    const c: Condition = {
      kind: 'priority.is',
      config: { priority: 'high' },
    };
    expect(conditionMatches(c, pageEvent)).toBe(true);
  });

  it('subject.matches only applies to email events', () => {
    const c: Condition = {
      kind: 'subject.matches',
      config: { pattern: '^receipt' },
    };
    expect(conditionMatches(c, pageEvent)).toBe(false);
  });
});

describe('evaluateRecipe', () => {
  const event: RecipeEvent = SUB_CREATED_EVENT;

  it('returns match: true when trigger + conditions all pass', () => {
    const r = evaluateRecipe(
      { kind: 'subscription.created', config: {} },
      [],
      event,
    );
    expect(r.match).toBe(true);
  });

  it('explains trigger-mismatch when the kinds disagree', () => {
    const r = evaluateRecipe(
      { kind: 'page.created', config: {} },
      [],
      event,
    );
    expect(r.match).toBe(false);
    if (!r.match) expect(r.reason).toBe('trigger-mismatch');
  });

  it('explains condition-mismatch and names the failing kind', () => {
    const r = evaluateRecipe(
      { kind: 'subscription.created', config: {} },
      [{ kind: 'tag.contains', config: { tag: 'nope' } }],
      event,
    );
    expect(r.match).toBe(false);
    if (!r.match) {
      expect(r.reason).toBe('condition-mismatch');
      expect(r.conditionKind).toBe('tag.contains');
    }
  });
});
