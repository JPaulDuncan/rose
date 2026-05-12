import type { Trigger, Condition, RecipeEvent } from '../schemas/recipe.js';

/**
 * Pure trigger/condition matchers. Lives in @rose/shared so both the
 * dispatcher (worker) and the dry-run endpoint (API) can call the
 * same logic — they have to agree exactly, otherwise "would it fire?"
 * answers diverge from "did it fire?".
 *
 * The matchers do not touch the database or the queue. They take a
 * fully-realised RecipeEvent (subject + denormalised metadata) and
 * return a boolean. A recipe fires when triggerMatches AND every
 * condition matches.
 */

export function triggerMatches(trigger: Trigger, event: RecipeEvent): boolean {
  if (trigger.kind !== event.kind) return false;
  if (trigger.kind === 'email.ingested' && event.kind === 'email.ingested') {
    const cfg = trigger.config;
    if (
      cfg.senderContains &&
      !(event.from ?? '').toLowerCase().includes(cfg.senderContains.toLowerCase())
    ) {
      return false;
    }
    if (cfg.brandKey && event.brandKey !== cfg.brandKey.toLowerCase()) {
      return false;
    }
    if (
      cfg.subjectContains &&
      !event.subject.toLowerCase().includes(cfg.subjectContains.toLowerCase())
    ) {
      return false;
    }
    return true;
  }
  if (trigger.kind === 'tag.applied' && event.kind === 'tag.applied') {
    return trigger.config.tag.toLowerCase() === event.tag.toLowerCase();
  }
  if (
    (trigger.kind === 'subscription.created' &&
      event.kind === 'subscription.created') ||
    (trigger.kind === 'subscription.renewed' &&
      event.kind === 'subscription.renewed')
  ) {
    const cfg = trigger.config;
    if (
      cfg.serviceContains &&
      !event.serviceName
        .toLowerCase()
        .includes(cfg.serviceContains.toLowerCase())
    ) {
      return false;
    }
    if (cfg.categories && cfg.categories.length > 0) {
      if (!event.category || !cfg.categories.includes(event.category)) {
        return false;
      }
    }
    return true;
  }
  if (
    trigger.kind === 'attachment.received' &&
    event.kind === 'attachment.received'
  ) {
    const cfg = trigger.config;
    if (cfg.minCount && event.attachmentCount < cfg.minCount) return false;
    if (cfg.contentTypeContains) {
      const want = cfg.contentTypeContains.toLowerCase();
      if (!event.contentTypes.some((ct) => ct.toLowerCase().includes(want))) {
        return false;
      }
    }
    if (cfg.filenameMatches) {
      try {
        const re = new RegExp(cfg.filenameMatches, 'i');
        if (!event.filenames.some((f) => re.test(f))) return false;
      } catch {
        // Bad regex — fail closed; user can fix in the wizard.
        return false;
      }
    }
    return true;
  }
  if (
    (trigger.kind === 'shipment.detected' && event.kind === 'shipment.detected') ||
    (trigger.kind === 'promo.detected' && event.kind === 'promo.detected')
  ) {
    const cfg = trigger.config;
    if (cfg.minCount && event.count < cfg.minCount) return false;
    return true;
  }
  if (trigger.kind === 'sender.blocked' && event.kind === 'sender.blocked') {
    const cfg = trigger.config;
    if (cfg.brandKey && (event.brandKey ?? '') !== cfg.brandKey.toLowerCase()) {
      return false;
    }
    return true;
  }
  if (trigger.kind === 'website.fetched' && event.kind === 'website.fetched') {
    const cfg = trigger.config;
    if (cfg.viaIs && event.via !== cfg.viaIs) return false;
    if (
      cfg.urlContains &&
      !event.url.toLowerCase().includes(cfg.urlContains.toLowerCase())
    ) {
      return false;
    }
    return true;
  }
  return true;
}

export function conditionMatches(condition: Condition, event: RecipeEvent): boolean {
  switch (condition.kind) {
    case 'tag.contains': {
      const target = condition.config.tag.toLowerCase();
      const tags = 'tags' in event ? event.tags.map((t) => t.toLowerCase()) : [];
      return tags.includes(target);
    }
    case 'sender.brand': {
      const want = condition.config.brandKey.toLowerCase();
      const has =
        event.kind === 'email.ingested'
          ? (event.brandKey ?? '').toLowerCase()
          : event.kind === 'page.created' || event.kind === 'tag.applied'
            ? event.brandKeys.map((k) => k.toLowerCase()).join(',')
            : '';
      return has.split(',').includes(want);
    }
    case 'priority.is': {
      if (
        event.kind === 'email.ingested' ||
        event.kind === 'page.created' ||
        event.kind === 'tag.applied'
      ) {
        return event.priority === condition.config.priority;
      }
      return false;
    }
    case 'subject.matches': {
      if (event.kind !== 'email.ingested') return false;
      try {
        const re = new RegExp(condition.config.pattern, 'i');
        return re.test(event.subject);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

/**
 * Composite "would this fire?" check. Returns the gate that would
 * have stopped it (when applicable) so the dry-run UI can show
 * `condition-mismatch:tag.contains` rather than just a thumbs-down.
 */
export function evaluateRecipe(
  trigger: Trigger,
  conditions: Condition[],
  event: RecipeEvent,
):
  | { match: true }
  | { match: false; reason: 'trigger-mismatch' | 'condition-mismatch'; conditionKind?: string } {
  if (!triggerMatches(trigger, event)) {
    return { match: false, reason: 'trigger-mismatch' };
  }
  for (const c of conditions) {
    if (!conditionMatches(c, event)) {
      return {
        match: false,
        reason: 'condition-mismatch',
        conditionKind: c.kind,
      };
    }
  }
  return { match: true };
}
