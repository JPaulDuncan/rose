import { describe, it, expect } from 'vitest';
import { assertSafeHttpUrl, UnsafeUrlError } from '@rose/llm';

/**
 * The SSRF guard is on the critical security path — every external
 * fetch (Daydream adapters, weather, library crawler) routes through
 * it. Tests that cover the obvious failure modes so a regression
 * shows up loudly.
 */
describe('assertSafeHttpUrl', () => {
  it('accepts public hostnames', async () => {
    // example.com resolves to a public IP. We don't pin to a specific
    // address because the docs RFC range can change, just assert the
    // call doesn't throw.
    await expect(assertSafeHttpUrl('https://example.com/foo')).resolves.toBeInstanceOf(URL);
  });

  it('rejects loopback hostname', async () => {
    await expect(assertSafeHttpUrl('http://localhost/')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('rejects literal private IPs', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/', // AWS IMDS
      'http://172.16.0.1/',
    ]) {
      await expect(assertSafeHttpUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it('rejects non-HTTP schemes', async () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/',
      'gopher://example.com/',
      'javascript:alert(1)',
    ]) {
      await expect(assertSafeHttpUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it('rejects malformed URLs', async () => {
    await expect(assertSafeHttpUrl('not a url')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeHttpUrl('')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects IPv6 loopback', async () => {
    await expect(assertSafeHttpUrl('http://[::1]/')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });
});
