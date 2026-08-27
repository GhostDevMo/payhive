import { MockBankLinkProvider } from './mock.js';
import { PlaidProvider } from './plaid.js';
import type { BankLinkProvider } from './types.js';

export * from './types.js';
export { MockBankLinkProvider } from './mock.js';
export { PlaidProvider } from './plaid.js';

let cached: BankLinkProvider | null = null;

/**
 * Choose the aggregator from config.
 *
 * Defaults to mock. BANK_LINK_PROVIDER=plaid without credentials is a hard
 * failure rather than a quiet fall back, for the same reason the payment
 * provider works that way: a deployment that thinks it is linking real banks
 * and is not should stop, not carry on.
 */
export function getBankLinkProvider(): BankLinkProvider {
  if (cached) return cached;

  const choice = (process.env.BANK_LINK_PROVIDER ?? 'mock').toLowerCase();

  if (choice === 'plaid') {
    const clientId = process.env.PLAID_CLIENT_ID;
    const secret = process.env.PLAID_SECRET;
    if (!clientId || !secret) {
      throw new Error('BANK_LINK_PROVIDER=plaid requires PLAID_CLIENT_ID and PLAID_SECRET.');
    }
    cached = new PlaidProvider(
      clientId,
      secret,
      (process.env.PLAID_ENV ?? 'sandbox').toLowerCase(),
      process.env.PLAID_PROCESSOR ?? null,
    );
    return cached;
  }

  if (choice !== 'mock') {
    throw new Error(`Unknown BANK_LINK_PROVIDER: ${choice}. Expected "mock" or "plaid".`);
  }

  cached = new MockBankLinkProvider();
  return cached;
}

/** Test hook: drop the memoised provider so env changes take effect. */
export function resetBankLinkProvider(): void {
  cached = null;
}
