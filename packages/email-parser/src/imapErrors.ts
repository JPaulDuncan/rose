/**
 * imapflow throws errors whose `.message` is generic ("Command failed") while
 * the useful detail lives on sibling properties. Build a single line that
 * captures what actually went wrong, and tack on provider-specific hints.
 */
export function formatImapError(err: unknown, host?: string): string {
  if (!err) return 'Unknown error';
  const e = err as {
    message?: string;
    code?: string;
    responseStatus?: string;
    responseText?: string;
    authenticationFailed?: boolean;
    serverResponseCode?: string;
  };

  const parts: string[] = [];
  if (e.responseStatus && e.responseText) parts.push(`${e.responseStatus} ${e.responseText}`);
  else if (e.responseText) parts.push(e.responseText);
  else if (e.code) parts.push(e.code);
  else if (e.message) parts.push(e.message);

  // Gmail: regular passwords are rejected; only app passwords work over IMAP.
  const lower = (host ?? '').toLowerCase();
  const isGmail = lower.includes('gmail') || lower.includes('googlemail');
  const isAuthFail =
    e.authenticationFailed ||
    e.serverResponseCode === 'AUTHENTICATIONFAILED' ||
    /AUTHENTICATIONFAILED|invalid credentials|535/i.test(parts.join(' '));

  if (isGmail && isAuthFail) {
    parts.push(
      'Hint: Gmail requires an App Password — generate one at https://myaccount.google.com/apppasswords (2-Step Verification must be on). Your regular Google password will always fail. Also confirm IMAP is enabled in Gmail → Settings → Forwarding and POP/IMAP.',
    );
  }

  // ECONNREFUSED / ENOTFOUND / ETIMEDOUT — surface the syscall code prominently.
  if (e.code && !parts[0]?.includes(e.code)) parts.unshift(e.code);

  return parts.join(' — ') || 'Unknown error';
}
