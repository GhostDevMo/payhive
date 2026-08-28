import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';

const PASSWORD = 'correct-horse-battery-staple';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

/** Sign up the way a native client would: no cookie jar, tokens in the body. */
async function signUpMobile(displayName = 'Mobile') {
  const email = `${displayName.toLowerCase()}.${randomUUID().slice(0, 8)}@payhive.test`;
  const response = await request(app)
    .post('/auth/signup')
    .send({ email, password: PASSWORD, displayName, currency: 'USD', client: 'mobile' })
    .expect(201);

  return {
    email,
    user: response.body.user as { id: string; payhiveId: string },
    tokens: response.body.tokens as Tokens,
    headers: response.headers as Record<string, string | string[]>,
  };
}

const asMobile = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('native client sessions', () => {
  it('returns tokens and sets no cookie', async () => {
    const mobile = await signUpMobile();

    expect(mobile.tokens.accessToken).toBeTruthy();
    expect(mobile.tokens.refreshToken).toBeTruthy();
    // A token in the body AND a cookie would put a readable copy of the
    // session in a browser that did not ask for one.
    expect(mobile.headers['set-cookie']).toBeUndefined();
  });

  it('authenticates with a bearer token', async () => {
    const mobile = await signUpMobile();

    const me = await request(app)
      .get('/auth/me')
      .set(asMobile(mobile.tokens.accessToken))
      .expect(200);

    expect(me.body.user.payhiveId).toBe(mobile.user.payhiveId);
  });

  it('gives a browser a cookie and no tokens', async () => {
    const email = `web.${randomUUID().slice(0, 8)}@payhive.test`;
    const response = await request(app)
      .post('/auth/signup')
      .send({ email, password: PASSWORD, displayName: 'Web', currency: 'USD' })
      .expect(201);

    expect(response.body.tokens).toBeUndefined();
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('refuses a made-up bearer token', async () => {
    await request(app).get('/auth/me').set(asMobile('not-a-real-token')).expect(401);
  });

  it('moves money with a bearer token, like any other session', async () => {
    const alice = await signUpMobile('Alice');
    const bob = await signUpMobile('Bob');

    await request(app)
      .post('/deposits')
      .set(asMobile(alice.tokens.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '50.00', currency: 'USD' })
      .expect(201);

    await request(app)
      .post('/wallets/transfers')
      .set(asMobile(alice.tokens.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ to: bob.user.payhiveId, amount: '20.00', currency: 'USD' })
      .expect(201);

    const wallets = await request(app)
      .get('/wallets')
      .set(asMobile(bob.tokens.accessToken))
      .expect(200);

    expect(wallets.body.wallets[0].balance.formatted).toBe('20.00');
  });
});

describe('refreshing', () => {
  it('exchanges a refresh token for a working new pair', async () => {
    const mobile = await signUpMobile();

    const refreshed = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: mobile.tokens.refreshToken })
      .expect(200);

    const next = refreshed.body.tokens as Tokens;
    expect(next.accessToken).not.toBe(mobile.tokens.accessToken);
    expect(next.refreshToken).not.toBe(mobile.tokens.refreshToken);

    await request(app).get('/auth/me').set(asMobile(next.accessToken)).expect(200);
  });

  it('refuses a refresh token that does not exist', async () => {
    await request(app).post('/auth/refresh').send({ refreshToken: 'nope' }).expect(401);
  });

  it('revokes the whole family when a refresh token is used twice', async () => {
    const mobile = await signUpMobile();

    // First use is legitimate and yields a new pair.
    const first = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: mobile.tokens.refreshToken })
      .expect(200);
    const second = first.body.tokens as Tokens;

    // Replaying the old one means two parties hold it. There is no way to tell
    // which is the real user, so both are cut off.
    const replay = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: mobile.tokens.refreshToken })
      .expect(401);
    expect(replay.body.error.code).toBe('refresh_token_reused');

    // The token the thief would have obtained is dead...
    await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: second.refreshToken })
      .expect(401);

    // ...and so is every access token from that login.
    await request(app).get('/auth/me').set(asMobile(second.accessToken)).expect(401);

    // The real user signs back in with a password the thief does not have.
    await request(app)
      .post('/auth/login')
      .send({ email: mobile.email, password: PASSWORD, client: 'mobile' })
      .expect(200);
  });

  it('signs a native client out completely', async () => {
    const mobile = await signUpMobile();

    await request(app)
      .post('/auth/logout')
      .set(asMobile(mobile.tokens.accessToken))
      .send({ refreshToken: mobile.tokens.refreshToken })
      .expect(204);

    // Both halves are gone: revoking only the access token would leave
    // something that can mint a new one.
    await request(app).get('/auth/me').set(asMobile(mobile.tokens.accessToken)).expect(401);
    await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: mobile.tokens.refreshToken })
      .expect(401);
  });

  it('does not let one user refresh into another account', async () => {
    const alice = await signUpMobile('Alice');
    const mallory = await signUpMobile('Mallory');

    const refreshed = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: mallory.tokens.refreshToken })
      .expect(200);

    const me = await request(app)
      .get('/auth/me')
      .set(asMobile((refreshed.body.tokens as Tokens).accessToken))
      .expect(200);

    expect(me.body.user.payhiveId).toBe(mallory.user.payhiveId);
    expect(me.body.user.payhiveId).not.toBe(alice.user.payhiveId);
  });
});

describe('origins a native shell actually sends', () => {
  /**
   * These are asserted because getting them wrong is invisible from a browser.
   * Capacitor serves the app from its own origin, and the mismatch only ever
   * appears as a CORS failure on a device — which is exactly how the missing
   * https://localhost entry was found, after the web app had been working
   * fine for days.
   */
  it.each([
    'https://localhost', // Android, androidScheme 'https' (the default)
    'capacitor://localhost', // iOS
    'http://localhost', // Android, androidScheme 'http'
  ])('allows %s', async (origin) => {
    const response = await request(app).get('/health').set('Origin', origin).expect(200);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
  });

  it('does not allow an origin nobody configured', async () => {
    const response = await request(app)
      .get('/health')
      .set('Origin', 'https://payhive.example.attacker')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
