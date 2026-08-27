import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { app } from '../src/index.js';
import { db } from '../src/db/index.js';
import { bankAccounts } from '../src/db/schema.js';
import { decryptSecret, encryptSecret } from '../src/lib/secrets.js';
import { reverseWithdrawal } from '../src/lib/wallet.js';
import { money } from '../src/lib/money.js';
import { fund } from './helpers.js';

async function signUp(displayName: string) {
  const agent = request.agent(app);
  const email = `${displayName.toLowerCase()}.${randomUUID().slice(0, 8)}@payhive.test`;
  const response = await agent
    .post('/auth/signup')
    .send({ email, password: 'correct-horse-battery-staple', displayName, currency: 'USD' })
    .expect(201);
  return { agent, email, ...(response.body.user as { id: string; payhiveId: string }) };
}

/**
 * Walk the same two-step link the browser does: ask for a session, then hand
 * back a public token. The mock aggregator stands in for Plaid, but the shape
 * of the exchange is the real one.
 */
async function linkBank(agent: request.Agent, currency = 'USD') {
  await agent.post('/bank-accounts/link-token').send({ currency, country: 'US' }).expect(200);
  const response = await agent
    .post('/bank-accounts')
    .send({ publicToken: `mock_public_${currency}_${randomUUID()}`, country: 'US' })
    .expect(201);
  return response.body.bankAccount as {
    id: string;
    institution: string;
    last4: string;
    isDefault: boolean;
    payoutReady: boolean;
  };
}

describe('secret storage', () => {
  it('round-trips a token', () => {
    const token = 'access-sandbox-not-a-real-one';
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it('produces a different ciphertext each time', () => {
    // A fresh nonce per encryption: identical tokens must not look identical
    // in the database.
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const stored = encryptSecret('access-token');
    const [nonce, body, tag] = stored.split('.');
    const flipped = Buffer.from(body!, 'base64url');
    flipped[0] ^= 0xff;
    expect(() => decryptSecret(`${nonce}.${flipped.toString('base64url')}.${tag}`)).toThrow();
  });
});

describe('linking a bank account', () => {
  it('opens a link session for the client SDK', async () => {
    const alice = await signUp('Alice');
    const response = await alice.agent
      .post('/bank-accounts/link-token')
      .send({ currency: 'USD', country: 'US' })
      .expect(200);

    expect(response.body.linkToken).toBeTruthy();
    expect(response.body.provider).toBe('mock');
  });

  it('links an account and makes the first one the default', async () => {
    const alice = await signUp('Alice');
    const account = await linkBank(alice.agent);

    expect(account.isDefault).toBe(true);
    expect(account.payoutReady).toBe(true);
    expect(account.last4).toMatch(/^\d{4}$/);
  });

  it('never returns the stored credentials to a client', async () => {
    const alice = await signUp('Alice');
    await linkBank(alice.agent);

    const listed = await alice.agent.get('/bank-accounts').expect(200);
    const [account] = listed.body.bankAccounts;

    // The access token is the key to somebody's bank data. It must not appear
    // in any response, under any field name.
    expect(JSON.stringify(listed.body)).not.toMatch(/mock_access|accessToken|access_token/);
    expect(account).not.toHaveProperty('destinationRef');
    expect(account).not.toHaveProperty('itemId');
  });

  it('encrypts the credential at rest', async () => {
    const alice = await signUp('Alice');
    await linkBank(alice.agent);

    const [row] = await db
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.userId, alice.id))
      .limit(1);

    expect(row!.accessTokenEncrypted).not.toContain('mock_access');
    expect(decryptSecret(row!.accessTokenEncrypted)).toMatch(/^mock_access_/);
  });

  it('requires a session', async () => {
    await request(app).get('/bank-accounts').expect(401);
    await request(app).post('/bank-accounts').send({ publicToken: 'x' }).expect(401);
  });

  it('rejects a public token that did not come from a link session', async () => {
    const alice = await signUp('Alice');
    await alice.agent.post('/bank-accounts').send({ publicToken: 'not-a-token' }).expect(400);
  });

  it('does not let one user see or touch another user’s accounts', async () => {
    const alice = await signUp('Alice');
    const mallory = await signUp('Mallory');
    const account = await linkBank(alice.agent);

    await mallory.agent.get('/bank-accounts').expect(200).expect({ bankAccounts: [] });
    await mallory.agent.post(`/bank-accounts/${account.id}/default`).expect(404);
    await mallory.agent.delete(`/bank-accounts/${account.id}`).expect(404);
  });
});

describe('managing linked accounts', () => {
  it('switches the default without ever having two', async () => {
    const alice = await signUp('Alice');
    const first = await linkBank(alice.agent);
    const second = await linkBank(alice.agent);

    expect(second.isDefault).toBe(false);
    await alice.agent.post(`/bank-accounts/${second.id}/default`).expect(200);

    const listed = await alice.agent.get('/bank-accounts').expect(200);
    const defaults = listed.body.bankAccounts.filter((a: { isDefault: boolean }) => a.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.id);
    expect(listed.body.bankAccounts.find((a: { id: string }) => a.id === first.id).isDefault).toBe(
      false,
    );
  });

  it('promotes another account when the default is removed', async () => {
    const alice = await signUp('Alice');
    const first = await linkBank(alice.agent);
    const second = await linkBank(alice.agent);

    await alice.agent.delete(`/bank-accounts/${first.id}`).expect(204);

    const listed = await alice.agent.get('/bank-accounts').expect(200);
    expect(listed.body.bankAccounts).toHaveLength(1);
    expect(listed.body.bankAccounts[0].id).toBe(second.id);
    expect(listed.body.bankAccounts[0].isDefault).toBe(true);
  });

  it('keeps a removed account out of sight but not out of the database', async () => {
    const alice = await signUp('Alice');
    const account = await linkBank(alice.agent);
    await alice.agent.delete(`/bank-accounts/${account.id}`).expect(204);

    // The row survives because a past withdrawal refers to it...
    const [row] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, account.id));
    expect(row!.status).toBe('removed');
    // ...but the credential is not kept for an account nobody is using.
    expect(row!.accessTokenEncrypted).toBe('');
    expect(row!.destinationRef).toBeNull();
  });
});

describe('withdrawing to a linked account', () => {
  it('refuses to withdraw with no bank account linked', async () => {
    const alice = await signUp('Alice');
    await fund(alice.id, 100_00n);

    const response = await alice.agent
      .post('/wallets/withdrawals')
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '10.00', currency: 'USD' })
      .expect(409);

    expect(response.body.error.code).toBe('no_bank_account');
  });

  it('pays out to the default account and debits the wallet once', async () => {
    const alice = await signUp('Alice');
    await fund(alice.id, 100_00n);
    const account = await linkBank(alice.agent);

    const response = await alice.agent
      .post('/wallets/withdrawals')
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '40.00', currency: 'USD' })
      .expect(201);

    expect(response.body.withdrawal.to.last4).toBe(account.last4);

    const wallets = await alice.agent.get('/wallets').expect(200);
    expect(wallets.body.wallets[0].balance.formatted).toBe('60.00');
  });

  it('will not send to an account belonging to somebody else', async () => {
    const alice = await signUp('Alice');
    const mallory = await signUp('Mallory');
    await fund(mallory.id, 100_00n);
    const aliceAccount = await linkBank(alice.agent);
    await linkBank(mallory.agent);

    // Naming Alice's account must not redirect Mallory's money to it.
    const response = await mallory.agent
      .post('/wallets/withdrawals')
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '10.00', currency: 'USD', bankAccountId: aliceAccount.id })
      .expect(409);

    expect(response.body.error.code).toBe('no_bank_account');
  });

  it('gives the money back when a payout is reversed', async () => {
    const alice = await signUp('Alice');
    await fund(alice.id, 100_00n);
    await linkBank(alice.agent);

    const sent = await alice.agent
      .post('/wallets/withdrawals')
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '25.00', currency: 'USD' })
      .expect(201);

    await reverseWithdrawal({
      userId: alice.id,
      amount: money(25_00n, 'USD'),
      reversesTransactionId: sent.body.withdrawal.transactionId,
      reason: 'provider refused',
    });

    const wallets = await alice.agent.get('/wallets').expect(200);
    expect(wallets.body.wallets[0].balance.formatted).toBe('100.00');
  });
});
