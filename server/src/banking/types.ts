/**
 * The bank-linking seam.
 *
 * Linking a bank and moving money are different jobs done by different
 * companies, so they are different interfaces. Plaid establishes that a user
 * owns an account and hands back a token; the PaymentProvider is what actually
 * sends money to it. Putting both on one interface would have tied the choice
 * of aggregator to the choice of payment partner, and PayHive has not signed
 * either yet.
 *
 * The property that matters most here: no method takes an account number or a
 * bank password. The user authenticates inside the aggregator's own UI, and
 * what crosses this boundary is only ever a token.
 */

export interface LinkSession {
  /** Short-lived token the client SDK opens its UI with. */
  linkToken: string;
  expiresAt: Date;
}

export interface LinkSessionParams {
  userId: string;
  /** ISO 4217, used to pick which rails the aggregator should offer. */
  currency: string;
  country: string;
  /** Where the aggregator should send the user back to, for OAuth bank flows. */
  redirectUri?: string;
}

export interface ExchangeParams {
  userId: string;
  /** Returned by the client SDK once the user has authenticated with their bank. */
  publicToken: string;
  /** Which of the accounts behind that login the user picked. */
  accountId?: string;
}

export interface LinkedAccount {
  /**
   * The aggregator's long-lived credential for this login.
   *
   * Treated as a secret everywhere it goes: encrypted before it is stored and
   * never returned to a client. Anyone holding it can read the user's bank
   * data.
   */
  accessToken: string;
  /** The aggregator's id for the login, used for maintenance and de-duplication. */
  itemId: string;
  /** The specific account within that login. */
  accountId: string;
  institution: string;
  /** Display only — the last few digits, as the aggregator reports them. */
  mask: string;
  currency: string;
  /**
   * A token the payment provider can pay out to, when the aggregator can mint
   * one. Null means payouts need a separate step before this destination works.
   */
  processorToken: string | null;
}

export interface BankLinkProvider {
  readonly name: string;
  /** Whether this implementation needs the client to open a real SDK. */
  readonly usesClientSdk: boolean;

  createLinkSession(params: LinkSessionParams): Promise<LinkSession>;

  exchange(params: ExchangeParams): Promise<LinkedAccount>;
}
