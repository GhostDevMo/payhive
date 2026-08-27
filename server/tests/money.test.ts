import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  add,
  allocate,
  formatDecimal,
  money,
  parseDecimal,
  subtract,
} from '../src/lib/money.js';

describe('money', () => {
  it('parses decimal input into minor units without floating point', () => {
    expect(parseDecimal('12.34', 'USD').amount).toBe(1234n);
    expect(parseDecimal('0.01', 'USD').amount).toBe(1n);
    expect(parseDecimal('1,250.00', 'USD').amount).toBe(125000n);
    expect(parseDecimal('-5.50', 'USD').amount).toBe(-550n);
  });

  it('respects zero-decimal currencies', () => {
    // XOF has no minor unit. Treating it like USD would inflate every West
    // African CFA amount by 100x — a corridor PayHive explicitly targets.
    expect(parseDecimal('1500', 'XOF').amount).toBe(1500n);
    expect(formatDecimal(money(1500n, 'XOF'))).toBe('1500');
    expect(() => parseDecimal('15.50', 'XOF')).toThrow(MoneyError);
  });

  it('respects three-decimal currencies', () => {
    expect(parseDecimal('1.234', 'KWD').amount).toBe(1234n);
    expect(formatDecimal(money(1234n, 'KWD'))).toBe('1.234');
  });

  it('rejects excess precision instead of silently rounding it away', () => {
    expect(() => parseDecimal('10.005', 'USD')).toThrow(/2 decimal place/);
  });

  it('rejects being handed a float', () => {
    expect(() => money(12.34, 'USD')).toThrow(/non-integer/);
  });

  it('round-trips through format and parse', () => {
    for (const input of ['0.00', '0.01', '9.99', '1000000.00', '123.45']) {
      expect(formatDecimal(parseDecimal(input, 'USD'))).toBe(input);
    }
  });

  it('survives amounts far beyond Number.MAX_SAFE_INTEGER', () => {
    // 90 trillion naira in kobo. A float would have lost precision long ago.
    const huge = money(9_000_000_000_000_000_00n, 'NGN');
    const one = money(1n, 'NGN');
    expect(add(huge, one).amount).toBe(9_000_000_000_000_000_01n);
    expect(subtract(add(huge, one), one).amount).toBe(huge.amount);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(100n, 'USD'), money(100n, 'NGN'))).toThrow(/mismatch/);
  });

  it('allocates without losing or inventing a minor unit', () => {
    const parts = allocate(money(10_00n, 'USD'), [1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([334n, 333n, 333n]);
    expect(parts.reduce((sum, p) => sum + p.amount, 0n)).toBe(10_00n);
  });

  it('allocates uneven ratios exactly', () => {
    const parts = allocate(money(9_99n, 'USD'), [70, 30]);
    expect(parts.reduce((sum, p) => sum + p.amount, 0n)).toBe(9_99n);
  });
});
