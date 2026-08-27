import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { app } from '../src/index.js';
import { db } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { normalizeHandle, skeleton, HandleError } from '../src/lib/handle.js';
import { createUser, fund } from './helpers.js';

/** Sign up through the API and keep the session cookie. */
async function signUp(displayName: string) {
  const agent = request.agent(app);
  const email = `${displayName.toLowerCase()}.${randomUUID().slice(0, 8)}@payhive.test`;
  const response = await agent
    .post('/auth/signup')
    .send({ email, password: 'correct-horse-battery-staple', displayName, currency: 'USD' })
    .expect(201);
  return { agent, ...(response.body.user as { id: string; payhiveId: string }) };
}

const claim = (agent: request.Agent, handle: string) =>
  agent.put('/auth/me/handle').send({ handle });

describe('handle rules', () => {
  it('lowercases what the user typed and keeps it as written', () => {
    expect(normalizeHandle('Alice.Dev')).toEqual({ handle: 'alice.dev', skeleton: 'a11cedev' });
  });

  it('folds lookalikes onto one skeleton, so they cannot coexist', () => {
    // The whole point: these are the same name to someone reading a phone screen.
    expect(skeleton('alice')).toBe(skeleton('a1ice'));
    expect(skeleton('alice')).toBe(skeleton('AL.ICE'));
    expect(skeleton('bob')).toBe(skeleton('8ob'));
  });

  it('does not fold names that merely resemble each other', () => {
    // rn -> m is a real confusable but folding it would collide honest names.
    expect(skeleton('corner')).not.toBe(skeleton('comer'));
  });

  it.each([
    ['ab', 'handle_length'],
    ['a'.repeat(21), 'handle_length'],
    ['1alice', 'handle_start'],
    ['alice_', 'handle_end'],
    ['al__ice', 'handle_separators'],
    ['ali ce', 'handle_charset'],
    ['ali$ce', 'handle_charset'],
    ['payhive', 'handle_reserved'],
    ['pay.hive', 'handle_reserved'],
    ['support', 'handle_reserved'],
    ['ph90pgcxd6', 'handle_reserved'],
  ])('rejects %s', (input, code) => {
    expect(() => normalizeHandle(input)).toThrowError(
      expect.objectContaining({ code }) as unknown as HandleError,
    );
  });
});

describe('claiming a handle', () => {
  it('claims a handle and reports it on the session', async () => {
    const alice = await signUp('Alice');
    await claim(alice.agent, 'alice.pay').expect(200);

    const me = await alice.agent.get('/auth/me').expect(200);
    expect(me.body.user.handle).toBe('alice.pay');
    // The generated ID is untouched: it is the permanent address.
    expect(me.body.user.payhiveId).toBe(alice.payhiveId);
  });

  it('refuses a handle that merely looks like one already taken', async () => {
    const alice = await signUp('Alice');
    await claim(alice.agent, 'alice').expect(200);

    const mallory = await signUp('Mallory');
    const response = await claim(mallory.agent, 'a1ice').expect(409);
    expect(response.body.error.code).toBe('handle_taken');
  });

  it('lets a user re-submit their own handle without complaint', async () => {
    const alice = await signUp('Alice');
    await claim(alice.agent, 'alice').expect(200);
    await claim(alice.agent, 'Alice').expect(200);
  });

  it('requires a session', async () => {
    await request(app).put('/auth/me/handle').send({ handle: 'nobody' }).expect(401);
  });
});

describe('changing a handle', () => {
  /** Pretend the last change was long enough ago to be allowed another. */
  const ageOutCooldown = (userId: string) =>
    db
      .update(users)
      .set({ handleUpdatedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(users.id, userId));

  it('holds the user to the cooldown', async () => {
    const alice = await signUp('Alice');
    await claim(alice.agent, 'alice.one').expect(200);

    const response = await claim(alice.agent, 'alice.two').expect(429);
    expect(response.body.error.code).toBe('handle_cooldown');
  });

  it('burns the old handle so it can never point at someone else', async () => {
    const alice = await signUp('Alice');
    await claim(alice.agent, 'alice.one').expect(200);
    await ageOutCooldown(alice.id);
    await claim(alice.agent, 'alice.two').expect(200);

    // The old handle resolves to nobody rather than to Alice...
    await alice.agent.get('/wallets/recipients/alice.one').expect(404);

    // ...and nobody else may pick it up. This is the property that stops a
    // payment aimed at an old address reaching a stranger.
    const mallory = await signUp('Mallory');
    const stolen = await claim(mallory.agent, 'alice.one').expect(409);
    expect(stolen.body.error.code).toBe('handle_taken');

    // A lookalike of the retired handle is refused too.
    await claim(mallory.agent, 'a1ice.0ne').expect(409);
  });
});

describe('paying by handle', () => {
  // Lookups go through a signed-in agent because /wallets is behind
  // requireAuth: confirming a payee must not be an anonymous directory of
  // every handle on the platform.

  it('resolves a recipient by handle or by PayHive ID', async () => {
    const alice = await signUp('Alice');
    await claim(alice.agent, 'alice.pay').expect(200);

    const byHandle = await alice.agent.get('/wallets/recipients/alice.pay').expect(200);
    const byId = await alice.agent.get(`/wallets/recipients/${alice.payhiveId}`).expect(200);

    expect(byHandle.body.recipient.payhiveId).toBe(alice.payhiveId);
    expect(byId.body.recipient.handle).toBe('alice.pay');
    // Still only public fields.
    expect(byHandle.body.recipient).not.toHaveProperty('email');
    expect(byHandle.body.recipient).not.toHaveProperty('id');
  });

  it('is forgiving about how the payer typed it', async () => {
    const alice = await signUp('Alice');
    await claim(alice.agent, 'alice').expect(200);

    for (const typed of ['alice', 'ALICE', 'al.ice', 'a1ice']) {
      const found = await alice.agent.get(`/wallets/recipients/${typed}`).expect(200);
      expect(found.body.recipient.payhiveId).toBe(alice.payhiveId);
    }
  });

  it('sends money to a handle and records the permanent ID in history', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');
    await claim(bob.agent, 'bob.pay').expect(200);
    await fund(alice.id, 50_00n);

    const sent = await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', randomUUID())
      .send({ to: 'bob.pay', amount: '12.50', currency: 'USD' })
      .expect(201);

    expect(sent.body.transfer.to.payhiveId).toBe(bob.payhiveId);

    const wallets = await bob.agent.get('/wallets').expect(200);
    expect(wallets.body.wallets[0].balance.formatted).toBe('12.50');

    // History stores the resolved PayHive ID, not the handle, so a later
    // handle change cannot rewrite what a past transaction says.
    const history = await alice.agent.get('/wallets/transactions').expect(200);
    const entry = history.body.transactions.find((t: { counterparty?: string }) => t.counterparty);
    if (entry) expect(entry.counterparty).toBe(bob.payhiveId);
  });

  it('will not send to a handle nobody has claimed', async () => {
    const alice = await signUp('Alice');
    await fund(alice.id, 20_00n);

    const response = await alice.agent
      .post('/wallets/transfers')
      .set('Idempotency-Key', randomUUID())
      .send({ to: 'ghost.account', amount: '1.00', currency: 'USD' })
      .expect(404);

    expect(response.body.error.code).toBe('recipient_not_found');
  });

  it('does not let a handle shadow someone elses PayHive ID', async () => {
    // A PayHive ID must always win, so a handle can never intercept payments
    // addressed to the permanent identifier of another account.
    const victim = await createUser('Victim');
    const alice = await signUp('Alice');

    // Handles cannot take the shape of a PayHive ID at all.
    const response = await claim(alice.agent, victim.payhiveId.toLowerCase());
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('handle_reserved');

    const found = await alice.agent.get(`/wallets/recipients/${victim.payhiveId}`).expect(200);
    expect(found.body.recipient.payhiveId).toBe(victim.payhiveId);
  });
});
