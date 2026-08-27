import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { postings, transactions } from '../src/db/schema.js';
import {
  InsufficientFunds,
  LedgerError,
  derivedBalance,
  getOrCreateAccount,
  post,
  reconcile,
} from '../src/lib/ledger.js';
import { money } from '../src/lib/money.js';
import { deposit, transfer, withdraw, WalletError } from '../src/lib/wallet.js';
import { balanceOf, createUser, fund } from './helpers.js';

describe('ledger invariants', () => {
  it('credits a wallet on deposit and keeps the entry balanced', async () => {
    const user = await createUser();
    await fund(user.id, 100_00n);

    expect(await balanceOf(user.id)).toBe(100_00n);

    const report = await reconcile();
    expect(report.ok).toBe(true);
    // The single most important number in the system: every currency nets to
    // zero across all accounts, because money is only ever moved, never made.
    expect(report.currencyTotals).toEqual([{ currency: 'USD', total: 0n }]);
  });

  it('moves money between users on transfer', async () => {
    const alice = await createUser('Alice');
    const bob = await createUser('Bob');
    await fund(alice.id, 100_00n);

    await transfer({
      fromUserId: alice.id,
      to: bob.payhiveId,
      amount: money(25_50n, 'USD'),
      note: 'lunch',
    });

    expect(await balanceOf(alice.id)).toBe(74_50n);
    expect(await balanceOf(bob.id)).toBe(25_50n);
    expect((await reconcile()).ok).toBe(true);
  });

  it('opens a wallet for a recipient who has never held that currency', async () => {
    const alice = await createUser('Alice');
    const bob = await createUser('Bob');
    await fund(alice.id, 50_00n, 'EUR');

    await transfer({
      fromUserId: alice.id,
      to: bob.payhiveId,
      amount: money(10_00n, 'EUR'),
    });

    expect(await balanceOf(bob.id, 'EUR')).toBe(10_00n);
  });

  it('refuses to overdraw a wallet', async () => {
    const alice = await createUser('Alice');
    const bob = await createUser('Bob');
    await fund(alice.id, 10_00n);

    await expect(
      transfer({
        fromUserId: alice.id,
        to: bob.payhiveId,
        amount: money(10_01n, 'USD'),
      }),
    ).rejects.toThrow(WalletError);

    // And nothing partial was left behind.
    expect(await balanceOf(alice.id)).toBe(10_00n);
    expect(await balanceOf(bob.id)).toBe(0n);
    expect((await reconcile()).ok).toBe(true);
  });

  it('refuses to send money to yourself', async () => {
    const alice = await createUser('Alice');
    await fund(alice.id, 10_00n);
    await expect(
      transfer({ fromUserId: alice.id, to: alice.payhiveId, amount: money(1_00n, 'USD') }),
    ).rejects.toThrow(/yourself/);
  });

  it('rejects an unbalanced entry at the application layer', async () => {
    const user = await createUser();
    const wallet = await getOrCreateAccount(db, {
      kind: 'user_wallet',
      currency: 'USD',
      userId: user.id,
    });
    const funding = await getOrCreateAccount(db, { kind: 'system_funding', currency: 'USD' });

    await expect(
      db.transaction((tx) =>
        post(tx, {
          type: 'deposit',
          entries: [
            { accountId: funding.id, amount: -100n, currency: 'USD' },
            { accountId: wallet.id, amount: 99n, currency: 'USD' }, // one cent short
          ],
        }),
      ),
    ).rejects.toThrow(LedgerError);
  });

  it('rejects an unbalanced entry at the database layer even when the app is bypassed', async () => {
    const user = await createUser();
    const wallet = await getOrCreateAccount(db, {
      kind: 'user_wallet',
      currency: 'USD',
      userId: user.id,
    });

    // Write straight to the tables, skipping every application check. The
    // deferred constraint trigger must still refuse this at COMMIT.
    await expect(
      db.transaction(async (tx) => {
        const [created] = await tx
          .insert(transactions)
          .values({ type: 'deposit', status: 'posted' })
          .returning({ id: transactions.id });
        await tx.insert(postings).values({
          transactionId: created!.id,
          accountId: wallet.id,
          currency: 'USD',
          amount: 500n, // single-sided: money from nowhere
        });
      }),
    ).rejects.toThrow(/Unbalanced transaction/);

    expect((await reconcile()).ok).toBe(true);
  });

  it('rejects a posting whose currency does not match its account', async () => {
    const user = await createUser();
    const usdWallet = await getOrCreateAccount(db, {
      kind: 'user_wallet',
      currency: 'USD',
      userId: user.id,
    });
    const ngnFunding = await getOrCreateAccount(db, { kind: 'system_funding', currency: 'NGN' });

    await expect(
      db.transaction(async (tx) => {
        const [created] = await tx
          .insert(transactions)
          .values({ type: 'deposit', status: 'posted' })
          .returning({ id: transactions.id });
        await tx.insert(postings).values([
          { transactionId: created!.id, accountId: ngnFunding.id, currency: 'NGN', amount: -500n },
          { transactionId: created!.id, accountId: usdWallet.id, currency: 'NGN', amount: 500n },
        ]);
      }),
    ).rejects.toThrow(/does not match account currency/);
  });

  it('keeps the cached balance identical to the derived balance', async () => {
    const alice = await createUser('Alice');
    const bob = await createUser('Bob');
    await fund(alice.id, 500_00n);

    for (let i = 0; i < 10; i += 1) {
      await transfer({
        fromUserId: alice.id,
        to: bob.payhiveId,
        amount: money(7_13n, 'USD'), // deliberately not a round number
      });
    }

    const rows = await db.execute(sql`SELECT id FROM accounts`);
    for (const row of rows.rows as Array<{ id: string }>) {
      const cached = await db.execute(sql`SELECT balance FROM accounts WHERE id = ${row.id}`);
      const derived = await derivedBalance(db, row.id);
      expect(BigInt(String((cached.rows[0] as { balance: unknown }).balance))).toBe(derived);
    }

    expect(await balanceOf(alice.id)).toBe(500_00n - 71_30n);
    expect(await balanceOf(bob.id)).toBe(71_30n);
  });

  it('debits the wallet on withdrawal and will not let it go negative', async () => {
    const user = await createUser();
    await fund(user.id, 20_00n);

    await withdraw({ userId: user.id, amount: money(15_00n, 'USD') });
    expect(await balanceOf(user.id)).toBe(5_00n);

    await expect(withdraw({ userId: user.id, amount: money(5_01n, 'USD') })).rejects.toThrow(
      WalletError,
    );
    expect(await balanceOf(user.id)).toBe(5_00n);
    expect((await reconcile()).ok).toBe(true);
  });

  it('cannot credit the same provider reference twice', async () => {
    const user = await createUser();
    const ref = 'pi_duplicate_delivery';

    await deposit({ userId: user.id, amount: money(10_00n, 'USD'), providerRef: ref });
    // A webhook replay. Stripe does this routinely.
    await expect(
      deposit({ userId: user.id, amount: money(10_00n, 'USD'), providerRef: ref }),
    ).rejects.toThrow();

    expect(await balanceOf(user.id)).toBe(10_00n);
  });
});

describe('concurrency', () => {
  it('cannot be raced into an overdraft', async () => {
    const alice = await createUser('Alice');
    const bob = await createUser('Bob');

    // Exactly enough for 10 sends of 10.00.
    await fund(alice.id, 100_00n);

    const attempts = 25;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        transfer({
          fromUserId: alice.id,
          to: bob.payhiveId,
          amount: money(10_00n, 'USD'),
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    expect(succeeded).toBe(10);
    expect(failed).toBe(attempts - 10);
    expect(await balanceOf(alice.id)).toBe(0n);
    expect(await balanceOf(bob.id)).toBe(100_00n);
    expect((await reconcile()).ok).toBe(true);
  });

  it('does not deadlock when two users pay each other simultaneously', async () => {
    // Without a deterministic lock order this is the classic deadlock: A locks
    // its own wallet then waits for B's, while B does the mirror image.
    const alice = await createUser('Alice');
    const bob = await createUser('Bob');
    await fund(alice.id, 100_00n);
    await fund(bob.id, 100_00n);

    const rounds = 20;
    const results = await Promise.allSettled([
      ...Array.from({ length: rounds }, () =>
        transfer({ fromUserId: alice.id, to: bob.payhiveId, amount: money(1_00n, 'USD') }),
      ),
      ...Array.from({ length: rounds }, () =>
        transfer({ fromUserId: bob.id, to: alice.payhiveId, amount: money(1_00n, 'USD') }),
      ),
    ]);

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await balanceOf(alice.id)).toBe(100_00n);
    expect(await balanceOf(bob.id)).toBe(100_00n);
    expect((await reconcile()).ok).toBe(true);
  });
});
