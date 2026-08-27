/**
 * Plaid.
 *
 * The flow, and why it is shaped this way:
 *
 *   1. This server asks Plaid for a link_token.
 *   2. The browser opens Plaid Link with it. The user picks their bank and
 *      signs in *to Plaid*, not to PayHive. Their bank credentials never reach
 *      this server, which is the entire reason for using an aggregator.
 *   3. Link returns a short-lived public_token, which this server exchanges for
 *      a long-lived access_token.
 *   4. For payouts, the access_token is converted into a processor token scoped
 *      to the payment provider — so the money mover gets a reference to the
 *      account without ever seeing the credentials either.
 *
 * Written against Plaid's documented HTTP API rather than their SDK, to avoid a
 * dependency for four calls. Untested against a live Plaid account: PayHive has
 * no Plaid credentials yet, so this must be exercised in their Sandbox before
 * it is relied on.
 */

import type {
  BankLinkProvider,
  ExchangeParams,
  LinkedAccount,
  LinkSession,
  LinkSessionParams,
} from './types.js';

const PLAID_HOSTS: Record<string, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

interface PlaidAccount {
  account_id: string;
  name?: string;
  mask?: string | null;
  balances?: { iso_currency_code?: string | null };
}

export class PlaidProvider implements BankLinkProvider {
  readonly name = 'plaid';
  readonly usesClientSdk = true;

  private readonly host: string;

  constructor(
    private readonly clientId: string,
    private readonly secret: string,
    environment: string,
    /** Which payment provider the processor token should be minted for. */
    private readonly processor: string | null,
  ) {
    const host = PLAID_HOSTS[environment];
    if (!host) {
      throw new Error(`PLAID_ENV must be one of ${Object.keys(PLAID_HOSTS).join(', ')}`);
    }
    this.host = host;
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.host}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, secret: this.secret, ...body }),
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      // Plaid's error_message is written for the end user; display_message even
      // more so. Preferring them over a status code makes "your bank is down
      // for maintenance" reach the person who needs to know it.
      const message =
        (payload.display_message as string) ??
        (payload.error_message as string) ??
        `Plaid ${path} failed with ${response.status}`;
      throw new Error(message);
    }
    return payload as T;
  }

  async createLinkSession(params: LinkSessionParams): Promise<LinkSession> {
    const result = await this.call<{ link_token: string; expiration: string }>(
      '/link/token/create',
      {
        user: { client_user_id: params.userId },
        client_name: 'PayHive',
        products: ['auth'],
        country_codes: [params.country.toUpperCase()],
        language: 'en',
        ...(params.redirectUri ? { redirect_uri: params.redirectUri } : {}),
      },
    );

    return { linkToken: result.link_token, expiresAt: new Date(result.expiration) };
  }

  async exchange(params: ExchangeParams): Promise<LinkedAccount> {
    const exchanged = await this.call<{ access_token: string; item_id: string }>(
      '/item/public_token/exchange',
      { public_token: params.publicToken },
    );

    const auth = await this.call<{
      accounts: PlaidAccount[];
      item: { institution_id?: string | null };
    }>('/accounts/get', { access_token: exchanged.access_token });

    const account =
      auth.accounts.find((a) => a.account_id === params.accountId) ?? auth.accounts[0];
    if (!account) throw new Error('Plaid returned no accounts for that login');

    let institution = account.name ?? 'Bank';
    if (auth.item.institution_id) {
      const found = await this.call<{ institution: { name: string } }>(
        '/institutions/get_by_id',
        {
          institution_id: auth.item.institution_id,
          country_codes: ['US', 'CA', 'GB', 'IE', 'FR', 'ES', 'NL', 'DE'],
        },
      ).catch(() => null);
      if (found) institution = found.institution.name;
    }

    // A processor token is what lets the payment provider pay this account
    // without ever holding the credentials. Not every processor is supported in
    // every region, so a failure here is recorded as "no destination yet"
    // rather than failing the link the user just completed.
    let processorToken: string | null = null;
    if (this.processor) {
      const minted = await this.call<{ processor_token: string }>(
        '/processor/token/create',
        {
          access_token: exchanged.access_token,
          account_id: account.account_id,
          processor: this.processor,
        },
      ).catch(() => null);
      processorToken = minted?.processor_token ?? null;
    }

    return {
      accessToken: exchanged.access_token,
      itemId: exchanged.item_id,
      accountId: account.account_id,
      institution,
      mask: account.mask ?? '0000',
      currency: account.balances?.iso_currency_code ?? 'USD',
      processorToken,
    };
  }
}
