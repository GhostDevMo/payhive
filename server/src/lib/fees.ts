/**
 * What PayHive charges, and how it is calculated.
 *
 * Two rules the rest of the system depends on:
 *
 *  1. **Money in and out is where fees live. A PayHive-to-PayHive send is
 *     free.** That is not an accident of configuration — the product says so
 *     on the send screen, and it is true because an internal transfer is two
 *     rows in our own ledger with no third party to pay. Putting a fee there
 *     would mean charging for something that costs nothing.
 *  2. **The arithmetic is integer, like every other amount in this system.**
 *     Rates are basis points, not percentages, so a rate is a whole number and
 *     nothing is ever a float.
 *
 * THE RATES BELOW ARE PLACEHOLDERS. They are shaped like real ones so the code
 * can be exercised, but what PayHive actually charges is a commercial decision
 * that has not been made, and it must be set deliberately before anyone is
 * billed.
 */

import { money, MoneyError, toJSON, type Currency, type Money } from './money.js';

export type FeeableOperation = 'deposit' | 'withdrawal' | 'transfer';

export interface FeeRule {
  /** Basis points of the amount. 100 bps = 1%. An integer, always. */
  bps: number;
  /** Flat component, in minor units. */
  fixed: bigint;
  /** Never charge less than this, when a fee is charged at all. */
  minimum?: bigint;
  /** Never charge more than this, however large the amount. */
  maximum?: bigint;
}

const FREE: FeeRule = { bps: 0, fixed: 0n };

/**
 * The default schedule, per currency, falling back to `default`.
 *
 * Deposits are free here because the cost of funding is currently absorbed;
 * withdrawals carry a rate because paying out to a bank costs PayHive money on
 * every one. Both are placeholders — see the note above.
 */
const SCHEDULE: Record<string, Partial<Record<FeeableOperation, FeeRule>>> = {
  default: {
    // Free between wallets, permanently and by design. Changing this breaks a
    // promise the product makes on screen, not just a config value.
    transfer: FREE,
    deposit: FREE,
    withdrawal: { bps: 100, fixed: 0n, minimum: 30n, maximum: 1000n },
  },
  // Zero-decimal currencies: minor units are whole units, so the flat parts
  // are a hundred times smaller in magnitude than their USD equivalents.
  XOF: {
    transfer: FREE,
    deposit: FREE,
    withdrawal: { bps: 100, fixed: 0n, minimum: 100n, maximum: 5000n },
  },
  XAF: {
    transfer: FREE,
    deposit: FREE,
    withdrawal: { bps: 100, fixed: 0n, minimum: 100n, maximum: 5000n },
  },
};

export function feeRule(operation: FeeableOperation, currency: Currency): FeeRule {
  const forCurrency = SCHEDULE[currency.toUpperCase()]?.[operation];
  if (forCurrency) return forCurrency;
  return SCHEDULE.default?.[operation] ?? FREE;
}

export class FeeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'FeeError';
  }
}

export interface Quote {
  /** What the user asked to move. */
  amount: Money;
  /** What PayHive keeps. */
  fee: Money;
  /**
   * What actually arrives: the wallet on a deposit, the bank on a withdrawal.
   * The fee is taken out of the amount rather than added on top, so a request
   * to move 100 always moves exactly 100 out of the source.
   */
  net: Money;
}

/**
 * Price one operation.
 *
 * Rounds the proportional part DOWN. Over a large number of small transactions
 * the difference is a rounding decision worth a few units either way, and it
 * should fall on the customer's side: a stated rate of 1% should never turn
 * out to have charged 1.4%.
 */
export function quote(operation: FeeableOperation, amount: Money): Quote {
  if (amount.amount <= 0n) {
    throw new MoneyError('Cannot price a non-positive amount');
  }

  const rule = feeRule(operation, amount.currency);

  // Whether this rule charges at all, which is a property of the rule and not
  // of the result. A small amount can floor to zero under a real rate, and that
  // must still attract the minimum rather than slipping through free.
  const charges = rule.bps > 0 || rule.fixed > 0n;

  let fee = (amount.amount * BigInt(rule.bps)) / 10_000n + rule.fixed;

  if (charges && rule.minimum !== undefined && fee < rule.minimum) fee = rule.minimum;
  if (rule.maximum !== undefined && fee > rule.maximum) fee = rule.maximum;

  if (fee < 0n) fee = 0n;

  if (fee >= amount.amount) {
    // Nothing would arrive. Refusing is the only honest answer: taking the
    // whole amount as a fee is not a transaction anyone meant to make.
    throw new FeeError(
      'That amount is too small once the fee is taken.',
      'amount_below_minimum',
    );
  }

  return {
    amount,
    fee: money(fee, amount.currency),
    net: money(amount.amount - fee, amount.currency),
  };
}

/** Serialisable form for the API, so a client can show the fee before confirming. */
export function quoteToJSON(q: Quote): {
  amount: ReturnType<typeof toJSON>;
  fee: ReturnType<typeof toJSON>;
  net: ReturnType<typeof toJSON>;
} {
  return { amount: toJSON(q.amount), fee: toJSON(q.fee), net: toJSON(q.net) };
}
