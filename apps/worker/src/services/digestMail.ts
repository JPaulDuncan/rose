import { Types } from 'mongoose';
import {
  Page,
  User,
  CalendarEvent,
  type PageDoc,
} from '@rose/db';

/**
 * Render the current digest as plaintext + HTML for delivery via the
 * outbound transport. We deliberately reproduce the digest query
 * shape from the API rather than calling /api/digest — keeps the
 * worker self-contained and avoids HTTP round-trips.
 *
 * Mirrors what the home page shows: top stories, most read, datebook.
 * Spam, quarantined, and (when configured) promotional pages are
 * excluded.
 */
export async function renderDigestEmail(userId: Types.ObjectId): Promise<{
  subject: string;
  text: string;
  html: string;
  hasContent: boolean;
}> {
  const user = await User.findById(userId).select('settings').lean();
  const hidePromotions = user?.settings?.hidePromotions !== false;

  const filter: Record<string, unknown> = {
    userId,
    'flags.hasLikelySpam': { $ne: true },
    'flags.userMarkedSpam': { $ne: true },
    'flags.autoQuarantined': { $ne: true },
  };
  if (hidePromotions) filter['flags.isPromotional'] = { $ne: true };

  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const recent = (await Page.find({ ...filter, updatedAt: { $gte: since } })
    .sort({ updatedAt: -1 })
    .limit(20)
    .select('slug title summary heroImageUrl tags topics priority sourceEmailIds updatedAt flags')
    .lean()) as unknown as PageDoc[];

  // Top stories ranked the same way the digest API does.
  const score = (p: PageDoc) => {
    let s = 0;
    if (p.priority === 'high') s += 100;
    if (p.flags?.isNotificationStream) s += 30;
    s += Math.min((p.sourceEmailIds?.length ?? 0) * 4, 60);
    if (p.heroImageUrl) s += 20;
    return s;
  };
  const ranked = [...recent].sort((a, b) => score(b) - score(a));
  const lead = ranked[0] ?? null;
  const secondaries = ranked.slice(1, 4);
  const mostRead = ranked.slice(4, 10);

  const events = await CalendarEvent.find({
    userId,
    dismissed: { $ne: true },
    start: { $gte: new Date(), $lte: new Date(Date.now() + 7 * 24 * 3600 * 1000) },
  })
    .sort({ start: 1 })
    .limit(8)
    .lean();

  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const subject = `Rose · ${dateLabel}${lead ? ` — ${lead.title}` : ''}`;

  const hasContent = recent.length > 0 || events.length > 0;

  // Plain-text body — keeps the message readable in clients that
  // ignore HTML.
  const text = [
    `Today's Edition · ${dateLabel}`,
    '',
    lead && `TOP STORY\n${lead.title}\n${lead.summary ?? ''}`,
    secondaries.length &&
      `\nALSO TODAY\n${secondaries.map((p) => `- ${p.title}`).join('\n')}`,
    mostRead.length &&
      `\nMOST READ\n${mostRead.map((p, i) => `${String(i + 1).padStart(2, '0')}. ${p.title}`).join('\n')}`,
    events.length &&
      `\nTHIS WEEK\n${events
        .map((e) => {
          const d = new Date(e.start);
          return `- ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}: ${e.title}${e.location ? ` (${e.location})` : ''}`;
        })
        .join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n');

  // HTML render — minimal styling, inline. Keeps deliverability happy.
  const esc = (s: string) =>
    (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const baseStyle =
    'font-family:Georgia,"Times New Roman",serif;color:#181818;line-height:1.5;';
  const html = `<!doctype html><html><body style="${baseStyle}max-width:640px;margin:0 auto;padding:24px;">
  <header style="border-bottom:4px double #181818;padding-bottom:12px;margin-bottom:24px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:#888;">Today's Edition</div>
    <h1 style="font-size:32px;margin:4px 0 0;letter-spacing:-0.02em;">${esc(dateLabel)}</h1>
  </header>
  ${
    lead
      ? `<section style="margin-bottom:24px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:${
            lead.priority === 'high' ? '#c1272d' : '#888'
          };margin-bottom:6px;">${lead.priority === 'high' ? 'Breaking' : 'Top story'}</div>
          <h2 style="font-size:28px;margin:0;line-height:1.15;"><a href="#" style="color:#181818;text-decoration:none;">${esc(lead.title)}</a></h2>
          <p style="font-size:16px;color:#444;margin:8px 0 0;">${esc(lead.summary ?? '')}</p>
        </section>`
      : ''
  }
  ${
    secondaries.length
      ? `<section style="margin-bottom:24px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:#888;border-bottom:1px solid #ddd;padding-bottom:4px;margin-bottom:8px;">Also today</div>
          ${secondaries
            .map(
              (p) =>
                `<div style="margin-bottom:12px;"><div style="font-size:18px;font-weight:bold;line-height:1.2;">${esc(p.title)}</div><div style="font-size:14px;color:#555;margin-top:2px;">${esc((p.summary ?? '').slice(0, 160))}</div></div>`,
            )
            .join('')}
        </section>`
      : ''
  }
  ${
    mostRead.length
      ? `<section style="margin-bottom:24px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:#888;border-bottom:1px solid #ddd;padding-bottom:4px;margin-bottom:8px;">Most read</div>
          <ol style="margin:0;padding-left:24px;font-size:14px;line-height:1.6;">
            ${mostRead.map((p) => `<li>${esc(p.title)}</li>`).join('')}
          </ol>
        </section>`
      : ''
  }
  ${
    events.length
      ? `<section style="margin-bottom:24px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:#888;border-bottom:1px solid #ddd;padding-bottom:4px;margin-bottom:8px;">This week</div>
          <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.6;">
            ${events
              .map((e) => {
                const d = new Date(e.start);
                return `<li><strong>${esc(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))} ${esc(d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</strong>: ${esc(e.title)}${e.location ? ` <em style="color:#888;">(${esc(e.location)})</em>` : ''}</li>`;
              })
              .join('')}
          </ul>
        </section>`
      : ''
  }
  <footer style="font-size:11px;color:#888;border-top:1px solid #ddd;padding-top:12px;">Sent by Rose. Adjust the cadence in Settings → Newsletter.</footer>
  </body></html>`;

  return { subject, text, html, hasContent };
}
