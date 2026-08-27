import { randomUUID } from 'node:crypto';
import type {
  BankLinkProvider,
  ExchangeParams,
  LinkedAccount,
  LinkSession,
  LinkSessionParams,
} from './types.js';

/**
 * Local-development aggregator.
 *
 * Stands in for Plaid so the whole add-a-bank flow can be exercised with no
 * Plaid account, no network, and no sandbox credentials — the same bargain the
 * mock payment provider makes.
 *
 * It mimics the shape of the real thing rather than shortcutting it: a link
 * session is still created, a public token is still exchanged, and the client
 * still never sends an account number. Only the bank is imaginary. That way the
 * code path exercised in tests is the code path that runs in production.
 */
export class MockBankLinkProvider implements BankLinkProvider {
  readonly name = 'mock';
  readonly usesClientSdk = false;

  async createLinkSession(params: LinkSessionParams): Promise<LinkSession> {
    return {
      // Carries the currency so exchange() can hand back something consistent
      // with what was asked for, the way a real institution would.
      linkToken: `mock_link_${params.currency}_${randomUUID()}`,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    };
  }

  async exchange(params: ExchangeParams): Promise<LinkedAccount> {
    if (!params.publicToken.startsWith('mock_public_')) {
      throw new Error('Expected a public token from the mock link flow');
    }

    // mock_public_<CURRENCY>_<anything>
    const currency = params.publicToken.split('_')[2]?.toUpperCase() ?? 'USD';
    const id = randomUUID();

    return {
      accessToken: `mock_access_${id}`,
      itemId: `mock_item_${id}`,
      accountId: params.accountId ?? `mock_acct_${id}`,
      institution: 'Mock Federal Savings',
      mask: String(Math.floor(1000 + Math.random() * 9000)),
      currency,
      processorToken: `mock_proc_${id}`,
    };
  }
}
