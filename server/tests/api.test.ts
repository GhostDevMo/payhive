import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { app } from '../src/index.js';
import { db } from '../src/db/index.js';
import { reconcile } from '../src/lib/ledger.js';

/** Sign up and return an agent that carries the session cookie. */
async function signUp(displayName: string) {
  const agent = request.agent(app);
  const email = `${displayName.toLowerCase()}.${randomUUID().slice(0, 8)}@payhive.test`;
  const response = await agent
    .post('/auth/signup')
    .send({ email, password: 'correct-horse-battery-staple', displayName, currency: 'USD' })
    .expect(201);

  return { agent, email, ...response.body.user as { id: string; payhiveId: string } };
}

async function topUp(agent: request.Agent, amount: string, currency = 'USD') {
  return agent
    .post('/deposits')
    .set('Idempotency-Key', randomUUID())
    .send({ amount, currency })
    .expect(201);
}

describe('auth', () => {
  it('signs a user up, issues a PayHive ID, and opens a wallet', async () => {
    const { agent, payhiveId } = await signUp('Alice');

    expect(payhiveId).toMatch(/^PH[0-9A-HJKMNP-TV-Z]{8}$/);

    const wallets = await agent.get('/wallets').expect(200);
    expect(wallets.body.wallets).toHaveLength(1);
    expect(wallets.body.wallets[0].currency).toBe('USD');
    expect(wallets.body.wallets[0].balance.formatted).toBe('0.00');
  });

  it('rejects a duplicate email', async () => {
    const { email } = await signUp('Alice');
    await request(app)
      .post('/auth/signup')
      .send({ email, password: 'correct-horse-battery-staple', displayName: 'Impostor' })
      .expect(409);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const { email } = await signUp('Alice');

    const wrongPassword = await request(app)
      .post('/auth/login')
      .send({ email, password: 'not-the-password' })
      .expect(401);

    const unknownUser = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@payhive.test', password: 'not-the-password' })
      .expect(401);

    // Identical responses, so this endpoint can't be used to discover which
    // email addresses have PayHive accounts.
    expect(wrongPassword.body).toEqual(unknownUser.body);
  });

  it('refuses unauthenticated access to wallets', async () => {
    await request(app).get('/wallets').expect(401);
  });
});

describe('deposits and transfers', () => {
  it('credits a wallet and sends money to another user by PayHive ID', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');

    await topUp(alice.agent, '100.00');

    const wallets = await alice.agent.get('/wallets').expect(200);
    expect(wallets.body.wallets[0].balance.formatted).toBe('100.00');

    const transfer = await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', randomUUID())
      .send({ to: bob.payhiveId, amount: '30.25', currency: 'USD', note: 'rent' })
      .expect(201);

    expect(transfer.body.transfer.to.payhiveId).toBe(bob.payhiveId);
    expect(transfer.body.transfer.amount.formatted).toBe('30.25');

    const aliceAfter = await alice.agent.get('/wallets').expect(200);
    const bobAfter = await bob.agent.get('/wallets').expect(200);
    expect(aliceAfter.body.wallets[0].balance.formatted).toBe('69.75');
    expect(bobAfter.body.wallets[0].balance.formatted).toBe('30.25');
  });

  it('shows the transaction from each side with the right sign', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');
    await topUp(alice.agent, '50.00');

    await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', randomUUID())
      .send({ to: bob.payhiveId, amount: '20.00', currency: 'USD' })
      .expect(201);

    const aliceHistory = await alice.agent.get('/wallets/transactions').expect(200);
    const bobHistory = await bob.agent.get('/wallets/transactions').expect(200);

    const aliceSend = aliceHistory.body.transactions.find((t: any) => t.type === 'transfer');
    const bobReceive = bobHistory.body.transactions.find((t: any) => t.type === 'transfer');

    expect(aliceSend.amount.formatted).toBe('-20.00');
    expect(aliceSend.counterparty).toBe(bob.payhiveId);
    expect(bobReceive.amount.formatted).toBe('20.00');
    expect(bobReceive.counterparty).toBe(alice.payhiveId);
  });

  it('refuses a transfer larger than the balance', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');
    await topUp(alice.agent, '10.00');

    const response = await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', randomUUID())
      .send({ to: bob.payhiveId, amount: '10.01', currency: 'USD' })
      .expect(422);

    expect(response.body.error.code).toBe('insufficient_funds');
  });

  it('refuses a transfer to a PayHive ID that does not exist', async () => {
    const alice = await signUp('Alice');
    await topUp(alice.agent, '10.00');

    await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', randomUUID())
      .send({ to: 'PH00000000', amount: '1.00', currency: 'USD' })
      .expect(404);
  });

  it('rejects sub-cent precision rather than rounding it', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');
    await topUp(alice.agent, '10.00');

    const response = await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', randomUUID())
      .send({ to: bob.payhiveId, amount: '1.005', currency: 'USD' })
      .expect(400);

    expect(response.body.error.code).toBe('invalid_amount');
  });
});

describe('idempotency', () => {
  it('replays the original response instead of sending twice', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');
    await topUp(alice.agent, '100.00');

    const key = randomUUID();
    const body = { to: bob.payhiveId, amount: '25.00', currency: 'USD' };

    const first = await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    // The client never saw the first response and retries.
    const replay = await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.transfer.transactionId).toBe(first.body.transfer.transactionId);

    // The money moved exactly once.
    const wallets = await alice.agent.get('/wallets').expect(200);
    expect(wallets.body.wallets[0].balance.formatted).toBe('75.00');

    const count = await db.execute(sql`SELECT COUNT(*)::int AS n FROM transactions WHERE type = 'transfer'`);
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it('rejects the same key used with a different body', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');
    await topUp(alice.agent, '100.00');

    const key = randomUUID();
    await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', key)
      .send({ to: bob.payhiveId, amount: '10.00', currency: 'USD' })
      .expect(201);

    const conflict = await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', key)
      .send({ to: bob.payhiveId, amount: '9999.00', currency: 'USD' })
      .expect(422);

    expect(conflict.body.error.code).toBe('idempotency_key_reused');
  });

  it('requires an idempotency key on money-moving endpoints', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');

    const response = await alice.agent
      .post('/wallets/transfers')
      .send({ to: bob.payhiveId, amount: '1.00', currency: 'USD' })
      .expect(400);

    expect(response.body.error.code).toBe('idempotency_key_required');
  });
});

describe('recipient lookup', () => {
  it('confirms a payee by display name only', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');

    const response = await alice.agent.get(`/wallets/recipients/${bob.payhiveId}`).expect(200);
    expect(response.body.recipient.displayName).toBe('Bob');
    // A PayHive ID must not be a way to look up someone's email address.
    expect(response.body.recipient.email).toBeUndefined();
  });

  it('is case-insensitive, because people retype these by hand', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');
    await alice.agent.get(`/wallets/recipients/${bob.payhiveId.toLowerCase()}`).expect(200);
  });
});

describe('books', () => {
  it('reconciles after a full session of activity', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');
    const carol = await signUp('Carol');

    await topUp(alice.agent, '250.00');
    await topUp(bob.agent, '80.00');

    for (const [from, to, amount] of [
      [alice, bob, '33.33'],
      [alice, carol, '19.99'],
      [bob, carol, '12.50'],
      [carol, alice, '5.00'],
    ] as const) {
      await from.agent
        .post('/wallets/transfers')
        .set('Idempotency-Key', randomUUID())
        .send({ to: to.payhiveId, amount, currency: 'USD' })
        .expect(201);
    }

    await alice.agent
      .post('/wallets/withdrawals')
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '40.00', currency: 'USD' })
      .expect(201);

    const report = await reconcile();
    expect(report.ok).toBe(true);
    expect(report.drift).toEqual([]);
    expect(report.unbalanced).toEqual([]);
    expect(report.currencyTotals).toEqual([{ currency: 'USD', total: 0n }]);
  });
});
