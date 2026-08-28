import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { ConsoleEmailProvider } from '../src/email/console.js';
import { getEmailProvider, resetEmailProvider } from '../src/email/index.js';

const PASSWORD = 'correct-horse-battery-staple';

/** The console provider records what was sent; nothing else can see a token. */
function outbox(): ConsoleEmailProvider {
  return getEmailProvider() as ConsoleEmailProvider;
}

/** Pull the link out of the most recent message to an address. */
function linkTo(address: string, param: 'reset' | 'verify'): string {
  const message = [...outbox().sent].reverse().find((m) => m.to === address);
  if (!message) throw new Error(`no email was sent to ${address}`);
  const found = message.text.match(new RegExp(`[?&]${param}=([^\\s]+)`));
  if (!found) throw new Error(`no ${param} link in the email to ${address}`);
  return decodeURIComponent(found[1]!);
}

async function signUp(displayName: string) {
  const agent = request.agent(app);
  const email = `${displayName.toLowerCase()}.${randomUUID().slice(0, 8)}@payhive.test`;
  await agent
    .post('/auth/signup')
    .send({ email, password: PASSWORD, displayName, currency: 'USD' })
    .expect(201);
  return { agent, email };
}

beforeEach(() => {
  resetEmailProvider();
  outbox().sent.length = 0;
});

describe('asking for a password reset', () => {
  it('sends a link and lets it set a new password', async () => {
    const alice = await signUp('Alice');

    await request(app)
      .post('/auth/password-reset/request')
      .send({ email: alice.email })
      .expect(204);

    await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token: linkTo(alice.email, 'reset'), password: 'a-brand-new-password' })
      .expect(204);

    await request(app)
      .post('/auth/login')
      .send({ email: alice.email, password: 'a-brand-new-password' })
      .expect(200);
    await request(app)
      .post('/auth/login')
      .send({ email: alice.email, password: PASSWORD })
      .expect(401);
  });

  it('answers the same for an address with no account, and sends nothing', async () => {
    await request(app)
      .post('/auth/password-reset/request')
      .send({ email: 'nobody.at.all@payhive.test' })
      .expect(204);

    // Identical status, and no mail: the endpoint must not reveal who banks here.
    expect(outbox().sent).toHaveLength(0);
  });

  it('is case-insensitive about the address', async () => {
    const alice = await signUp('Alice');
    await request(app)
      .post('/auth/password-reset/request')
      .send({ email: alice.email.toUpperCase() })
      .expect(204);

    expect(outbox().sent).toHaveLength(1);
  });

  it('stops sending after too many requests', async () => {
    const alice = await signUp('Alice');
    for (let i = 0; i < 8; i += 1) {
      await request(app)
        .post('/auth/password-reset/request')
        .send({ email: alice.email })
        .expect(204);
    }
    // Still 204 every time, but the mailbox is not a weapon.
    expect(outbox().sent.length).toBeLessThanOrEqual(5);
  });

  it('never puts the token in the response', async () => {
    const alice = await signUp('Alice');
    const response = await request(app)
      .post('/auth/password-reset/request')
      .send({ email: alice.email })
      .expect(204);

    expect(response.text).toBe('');
    const token = linkTo(alice.email, 'reset');
    expect(JSON.stringify(response.headers)).not.toContain(token);
  });
});

describe('redeeming a reset link', () => {
  it('works once and not twice', async () => {
    const alice = await signUp('Alice');
    await request(app).post('/auth/password-reset/request').send({ email: alice.email });
    const token = linkTo(alice.email, 'reset');

    await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token, password: 'first-new-password' })
      .expect(204);

    const second = await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token, password: 'second-new-password' })
      .expect(400);
    expect(second.body.error.code).toBe('invalid_token');

    // The second attempt changed nothing.
    await request(app)
      .post('/auth/login')
      .send({ email: alice.email, password: 'first-new-password' })
      .expect(200);
  });

  it('refuses a made-up link', async () => {
    await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token: 'not-a-real-token', password: 'a-brand-new-password' })
      .expect(400);
  });

  it('holds the new password to a minimum length', async () => {
    const alice = await signUp('Alice');
    await request(app).post('/auth/password-reset/request').send({ email: alice.email });

    await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token: linkTo(alice.email, 'reset'), password: 'short' })
      .expect(400);
  });

  it('signs out every existing session', async () => {
    const alice = await signUp('Alice');
    await alice.agent.get('/auth/me').expect(200);

    await request(app).post('/auth/password-reset/request').send({ email: alice.email });
    await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token: linkTo(alice.email, 'reset'), password: 'a-brand-new-password' })
      .expect(204);

    // If the reason for the reset is that somebody else was signed in, leaving
    // their session alive defeats the whole exercise.
    await alice.agent.get('/auth/me').expect(401);
  });

  it('invalidates other outstanding links for the same account', async () => {
    const alice = await signUp('Alice');
    await request(app).post('/auth/password-reset/request').send({ email: alice.email });
    const first = linkTo(alice.email, 'reset');
    await request(app).post('/auth/password-reset/request').send({ email: alice.email });
    const second = linkTo(alice.email, 'reset');

    await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token: second, password: 'a-brand-new-password' })
      .expect(204);

    await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token: first, password: 'yet-another-password' })
      .expect(400);
  });
});

describe('changing an email address', () => {
  it('does not change anything until the link is opened', async () => {
    const alice = await signUp('Alice');
    const next = `moved.${randomUUID().slice(0, 8)}@payhive.test`;

    await alice.agent
      .patch('/auth/me')
      .send({ email: next, currentPassword: PASSWORD })
      .expect(200);

    // Still the old address until confirmed — a typo must not cost an account.
    const me = await alice.agent.get('/auth/me').expect(200);
    expect(me.body.user.email).toBe(alice.email);

    await request(app)
      .post('/auth/email/confirm')
      .send({ token: linkTo(next, 'verify') })
      .expect(200);

    const after = await alice.agent.get('/auth/me').expect(200);
    expect(after.body.user.email).toBe(next);
  });

  it('sends the link to the new address and a warning to the old one', async () => {
    const alice = await signUp('Alice');
    const next = `moved.${randomUUID().slice(0, 8)}@payhive.test`;

    await alice.agent
      .patch('/auth/me')
      .send({ email: next, currentPassword: PASSWORD })
      .expect(200);

    const recipients = outbox().sent.map((m) => m.to);
    expect(recipients).toContain(next);
    // Losing an account should never be silent.
    expect(recipients).toContain(alice.email);
  });

  it('still requires the current password', async () => {
    const alice = await signUp('Alice');
    await alice.agent
      .patch('/auth/me')
      .send({ email: 'elsewhere@payhive.test' })
      .expect(403);

    expect(outbox().sent).toHaveLength(0);
  });

  it('sends nothing when the address belongs to someone else', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');

    // Reports success either way: varying the answer would make this a way to
    // test which addresses are registered.
    await alice.agent
      .patch('/auth/me')
      .send({ email: bob.email, currentPassword: PASSWORD })
      .expect(200);

    expect(outbox().sent.map((m) => m.to)).not.toContain(bob.email);
  });

  it('refuses a used or invented link', async () => {
    await request(app).post('/auth/email/confirm').send({ token: 'nope' }).expect(400);
  });
});
