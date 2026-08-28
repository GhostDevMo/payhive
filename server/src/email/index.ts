import { ConsoleEmailProvider } from './console.js';
import { ResendEmailProvider } from './resend.js';
import type { EmailProvider } from './types.js';

export * from './types.js';
export { ConsoleEmailProvider } from './console.js';
export { ResendEmailProvider } from './resend.js';

let cached: EmailProvider | null = null;

/**
 * Choose the provider from config.
 *
 * Defaults to console. EMAIL_PROVIDER=resend without credentials is a hard
 * failure rather than a silent fall back to printing: a deployment that thinks
 * it is sending password resets and is only writing them to a log is worse
 * than one that refuses to start.
 */
export function getEmailProvider(): EmailProvider {
  if (cached) return cached;

  const choice = (process.env.EMAIL_PROVIDER ?? 'console').toLowerCase();

  if (choice === 'resend') {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey || !from) {
      throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM.');
    }
    cached = new ResendEmailProvider(apiKey, from);
    return cached;
  }

  if (choice !== 'console') {
    throw new Error(`Unknown EMAIL_PROVIDER: ${choice}. Expected "console" or "resend".`);
  }

  cached = new ConsoleEmailProvider();
  return cached;
}

/** Test hook: drop the memoised provider so env changes take effect. */
export function resetEmailProvider(): void {
  cached = null;
}
