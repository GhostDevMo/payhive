import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { app } from '../src/index.js';
import { db } from '../src/db/index.js';
import { accounts, postings } from '../src/db/schema.js';
import { FeeError, feeRule, quote } from '../src/lib/fees.js';
import { money } from '../src/lib/money.js';
import { reconcile } from '../src/lib/ledger.js';
import { fund } from './helpers.js';

async function signUp(displayName: string) {
  const agent = request.agent(app);
  const email = `${displayName.toLowerCase()}.${randomUUID().slice(0, 8)}@payhive.test`;
  const response = await agent
    .post('/auth/signup')
    .send({ email, password: 'correct-horse-battery-staple', displayName, currency: 'USD' })
    .expect(201);
  return { agent, ...(response.body.user as { id: string; payhiveId: string }) };
}

async function linkBank(agent: request.Agent) {
  await agent.post('/bank-accounts/link-token').send({ currency: 'USD', country: 'US' }).expect(200);
  await agent
    .post('/bank-accounts')
    .send({ publicToken: `mock_public_USD_${randomUUID()}`, country: 'US' })
    .expect(201);
}

/** What PayHive has actually earned in a currency. */
async function feeBalance(currency = 'USD'): Promise<bigint> {
  const [row] = await db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(and(eq(accounts.kind, 'system_fee'), eq(accounts.currency, currency)))
    .limit(1);
  return row?.balance ?? 0n;
}

describe('pricing', () => {
  it('takes a percentage in basis points, with no float anywhere', () => {
    // 1% of 500.00 is 5.00, and the rule caps at 10.00.
    expect(quote('withdrawal', money(500_00n, 'USD')).fee.amount).toBe(5_00n);
  });

  it('applies the minimum on small amounts', () => {
    // 1% of 10.00 is 0.10, below the 0.30 minimum.
    expect(quote('withdrawal', money(10_00n, 'USD')).fee.amount).toBe(30n);
  });

  it('applies the maximum on large ones', () => {
    // 1% of 5,000.00 would be 50.00; the cap is 10.00.
    expect(quote('withdrawal', money(5_000_00n, 'USD')).fee.amount).toBe(10_00n);
  });

  it('rounds the proportional part down, in the customer’s favour', () => {
    // 1% of 33.33 is 0.3333 -> 0.33, not 0.34. A stated 1% must never bill more.
    const rule = feeRule('withdrawal', 'USD');
    expect(rule.bps).toBe(100);
    expect(quote('withdrawal', money(33_33n, 'USD')).fee.amount).toBe(33n);
  });

  it('never lets the fee swallow the whole amount', () => {
    // 0.20 with a 0.30 minimum would leave nothing to send.
    expect(() => quote('withdrawal', money(20n, 'USD'))).toThrowError(FeeError);
  });

  it('leaves a wallet-to-wallet send free', () => {
    // Not a configuration accident: the product promises this on screen.
    const priced = quote('transfer', money(1_000_00n, 'USD'));
    expect(priced.fee.amount).toBe(0n);
    expect(priced.net.amount).toBe(1_000_00n);
  });

  it('nets out to exactly the amount', () => {
    for (const amount of [1_00n, 7_77n, 100_00n, 12_345_67n]) {
      const priced = quote('withdrawal', money(amount, 'USD'));
      // The invariant that keeps the ledger balanced.
      expect(priced.fee.amount + priced.net.amount).toBe(amount);
    }
  });

  it('scales the flat parts for zero-decimal currencies', () => {
    // XOF has no minor unit, so a 0.30-shaped minimum would be 30 francs.
    expect(feeRule('withdrawal', 'XOF').minimum).toBe(100n);
  });
});

describe('the quote endpoint', () => {
  it('prices an operation without moving anything', async () => {
    const alice = await signUp('Alice');
    const response = await alice.agent
      .get('/wallets/quote')
      .query({ operation: 'withdrawal', amount: '200.00', currency: 'USD' })
      .expect(200);

    expect(response.body.quote.fee.formatted).toBe('2.00');
    expect(response.body.quote.net.formatted).toBe('198.00');
    expect(await feeBalance()).toBe(0n);
  });

  it('refuses an amount too small to survive the fee', async () => {
    const alice = await signUp('Alice');
    const response = await alice.agent
      .get('/wallets/quote')
      .query({ operation: 'withdrawal', amount: '0.20', currency: 'USD' })
      .expect(422);

    expect(response.body.error.code).toBe('amount_below_minimum');
  });
});

describe('charging a fee', () => {
  it('debits the wallet in full and splits it three ways', async () => {
    const alice = await signUp('Alice');
    await fund(alice.id, 500_00n);
    await linkBank(alice.agent);

    const response = await alice.agent
      .post('/wallets/withdrawals')
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '100.00', currency: 'USD' })
      .expect(201);

    expect(response.body.withdrawal.fee.formatted).toBe('1.00');
    expect(response.body.withdrawal.net.formatted).toBe('99.00');

    // The wallet loses the whole 100.00 — the fee is taken out of it, not
    // added on top, so a request to move 100 always moves exactly 100.
    const wallets = await alice.agent.get('/wallets').expect(200);
    expect(wallets.body.wallets[0].balance.formatted).toBe('400.00');

    expect(await feeBalance()).toBe(1_00n);

    // The first three-posting entry in the ledger: wallet out, payout in,
    // fee in.
    const rows = await db
      .select({ id: postings.id })
      .from(postings)
      .where(eq(postings.transactionId, response.body.withdrawal.transactionId));
    expect(rows).toHaveLength(3);
  });

  it('keeps the books balanced', async () => {
    const alice = await signUp('Alice');
    await fund(alice.id, 300_00n);
    await linkBank(alice.agent);

    for (const amount of ['25.00', '10.00', '150.00']) {
      await alice.agent
        .post('/wallets/withdrawals')
        .set('Idempotency-Key', randomUUID())
        .send({ amount, currency: 'USD' })
        .expect(201);
    }

    const report = await reconcile();
    expect(report.ok).toBe(true);
    expect(report.currencyTotals).toEqual([{ currency: 'USD', total: 0n }]);
    expect(await feeBalance()).toBeGreaterThan(0n);
  });

  it('sends money between users with no fee at all', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');
    await fund(alice.id, 100_00n);

    await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', randomUUID())
      .send({ to: bob.payhiveId, amount: '40.00', currency: 'USD' })
      .expect(201);

    const wallets = await bob.agent.get('/wallets').expect(200);
    // Bob receives every unit Alice sent.
    expect(wallets.body.wallets[0].balance.formatted).toBe('40.00');
    expect(await feeBalance()).toBe(0n);

    const report = await reconcile();
    expect(report.ok).toBe(true);
  });

  it('refuses a withdrawal too small to survive its fee', async () => {
    const alice = await signUp('Alice');
    await fund(alice.id, 100_00n);
    await linkBank(alice.agent);

    const response = await alice.agent
      .post('/wallets/withdrawals')
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '0.20', currency: 'USD' })
      .expect(422);

    expect(response.body.error.code).toBe('amount_below_minimum');

    // Nothing moved.
    const wallets = await alice.agent.get('/wallets').expect(200);
    expect(wallets.body.wallets[0].balance.formatted).toBe('100.00');
  });

  it('does not keep the fee when the payout is reversed', async () => {
    const alice = await signUp('Alice');
    await fund(alice.id, 100_00n);
    await linkBank(alice.agent);

    const sent = await alice.agent
      .post('/wallets/withdrawals')
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '50.00', currency: 'USD' })
      .expect(201);

    const { reverseWithdrawal } = await import('../src/lib/wallet.js');
    await reverseWithdrawal({
      userId: alice.id,
      amount: money(50_00n, 'USD'),
      reversesTransactionId: sent.body.withdrawal.transactionId,
      reason: 'provider refused',
      fee: money(50n, 'USD'),
    });

    // The customer is whole again, and PayHive kept nothing for work that did
    // not happen.
    const wallets = await alice.agent.get('/wallets').expect(200);
    expect(wallets.body.wallets[0].balance.formatted).toBe('100.00');
    expect(await feeBalance()).toBe(0n);

    const report = await reconcile();
    expect(report.ok).toBe(true);
  });
});
