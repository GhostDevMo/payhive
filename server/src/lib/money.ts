/**
 * Money handling.
 *
 * There is exactly one rule here and everything else follows from it:
 * money is a BigInt count of minor units plus a currency code. No floats,
 * ever, anywhere. `0.1 + 0.2 !== 0.3` is not a quirk you can be careful
 * around at scale; it is a slow leak in a ledger.
 */

export type Currency = string; // ISO-4217 alpha-3, uppercase.

export interface Money {
  readonly amount: bigint; // minor units, signed
  readonly currency: Currency;
}

/**
 * Minor-unit exponents for the currencies PayHive cares about first.
 * Most are 2. The zero-decimal ones matter: treating JPY like USD
 * silently inflates every amount by 100x.
 */
const MINOR_UNITS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  NGN: 2, // Nigerian Naira
  GHS: 2, // Ghanaian Cedi
  KES: 2, // Kenyan Shilling
  ZAR: 2, // South African Rand
  XOF: 0, // West African CFA franc — zero decimal
  XAF: 0, // Central African CFA franc — zero decimal
  RWF: 0,
  UGX: 0,
  JPY: 0,
  KRW: 0,
  BHD: 3,
  KWD: 3,
  TND: 3,
};

export const SUPPORTED_CURRENCIES = Object.keys(MINOR_UNITS);

export function isSupportedCurrency(currency: string): boolean {
  return Object.prototype.hasOwnProperty.call(MINOR_UNITS, currency.toUpperCase());
}

export function minorUnitExponent(currency: Currency): number {
  const exp = MINOR_UNITS[currency.toUpperCase()];
  if (exp === undefined) throw new MoneyError(`Unsupported currency: ${currency}`);
  return exp;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function money(amount: bigint | number | string, currency: Currency): Money {
  const cur = currency.toUpperCase();
  if (!isSupportedCurrency(cur)) throw new MoneyError(`Unsupported currency: ${currency}`);
  let value: bigint;
  if (typeof amount === 'bigint') {
    value = amount;
  } else if (typeof amount === 'number') {
    if (!Number.isInteger(amount)) {
      throw new MoneyError(
        `Refusing to build Money from non-integer ${amount}. Pass minor units, not a decimal.`,
      );
    }
    value = BigInt(amount);
  } else {
    if (!/^-?\d+$/.test(amount)) throw new MoneyError(`Invalid minor-unit string: ${amount}`);
    value = BigInt(amount);
  }
  return { amount: value, currency: cur };
}

/**
 * Parse user-facing decimal input ("12.34", "1,250.00") into minor units.
 * Rejects excess precision rather than rounding it away silently — if a user
 * types 10.005 USD we want a validation error, not a half-cent that vanishes.
 */
export function parseDecimal(input: string, currency: Currency): Money {
  const cur = currency.toUpperCase();
  const exponent = minorUnitExponent(cur);
  const cleaned = input.trim().replace(/,/g, '');

  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) throw new MoneyError(`Invalid amount: "${input}"`);

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new MoneyError(
      `${cur} supports ${exponent} decimal place(s); "${input}" has ${fraction.length}.`,
    );
  }

  const padded = fraction.padEnd(exponent, '0');
  const minor = BigInt((whole ?? '0') + padded);
  return { amount: sign === '-' ? -minor : minor, currency: cur };
}

/** Render minor units as a decimal string, e.g. 1234n USD -> "12.34". */
export function formatDecimal(value: Money): string {
  const exponent = minorUnitExponent(value.currency);
  const negative = value.amount < 0n;
  const abs = negative ? -value.amount : value.amount;

  if (exponent === 0) return `${negative ? '-' : ''}${abs.toString()}`;

  const divisor = 10n ** BigInt(exponent);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function negate(a: Money): Money {
  return { amount: -a.amount, currency: a.currency };
}

export function isPositive(a: Money): boolean {
  return a.amount > 0n;
}

export function isZero(a: Money): boolean {
  return a.amount === 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

/**
 * Split an amount into n parts without losing or inventing a single minor unit.
 * The remainder is distributed one unit at a time across the leading parts,
 * so sum(split(x, n)) === x always. Used for fee splitting and, later, for
 * dividing a marketplace payout between seller and platform.
 */
export function allocate(value: Money, ratios: number[]): Money[] {
  if (ratios.length === 0) throw new MoneyError('allocate() needs at least one ratio');
  if (ratios.some((r) => r < 0)) throw new MoneyError('allocate() ratios must be non-negative');

  const total = ratios.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new MoneyError('allocate() ratios must sum to more than zero');

  const negative = value.amount < 0n;
  const abs = negative ? -value.amount : value.amount;

  const shares: bigint[] = [];
  let allocated = 0n;
  for (const ratio of ratios) {
    // Scale through BigInt to avoid float drift on the ratio itself.
    const share = (abs * BigInt(Math.round(ratio * 1e9))) / BigInt(Math.round(total * 1e9));
    shares.push(share);
    allocated += share;
  }

  let remainder = abs - allocated;
  for (let i = 0; remainder > 0n; i = (i + 1) % shares.length) {
    shares[i] = (shares[i] ?? 0n) + 1n;
    remainder -= 1n;
  }

  return shares.map((s) => ({ amount: negative ? -s : s, currency: value.currency }));
}

/** Serialise for JSON responses: the client gets both forms and never has to guess. */
export function toJSON(value: Money): {
  amount: string;
  currency: string;
  formatted: string;
  exponent: number;
} {
  return {
    amount: value.amount.toString(),
    currency: value.currency,
    formatted: formatDecimal(value),
    exponent: minorUnitExponent(value.currency),
  };
}
