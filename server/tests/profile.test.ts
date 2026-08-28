import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';

const PASSWORD = 'correct-horse-battery-staple';

async function signUp(displayName: string) {
  const agent = request.agent(app);
  const email = `${displayName.toLowerCase()}.${randomUUID().slice(0, 8)}@payhive.test`;
  const response = await agent
    .post('/auth/signup')
    .send({ email, password: PASSWORD, displayName, currency: 'USD' })
    .expect(201);
  return { agent, email, ...(response.body.user as { id: string; payhiveId: string }) };
}

describe('editing a profile', () => {
  it('changes the display name', async () => {
    const alice = await signUp('Alice');
    const response = await alice.agent
      .patch('/auth/me')
      .send({ displayName: 'Alice Ojo' })
      .expect(200);

    expect(response.body.user.displayName).toBe('Alice Ojo');
    const me = await alice.agent.get('/auth/me').expect(200);
    expect(me.body.user.displayName).toBe('Alice Ojo');
  });

  it('will not change the email without the current password', async () => {
    const alice = await signUp('Alice');
    const response = await alice.agent
      .patch('/auth/me')
      .send({ email: 'somewhere.else@payhive.test' })
      .expect(403);

    expect(response.body.error.code).toBe('password_required');
  });

  it('will not change the email with the wrong password', async () => {
    const alice = await signUp('Alice');
    await alice.agent
      .patch('/auth/me')
      .send({ email: 'somewhere.else@payhive.test', currentPassword: 'not-it' })
      .expect(403);
  });

  it('does not move the account until the new address is confirmed', async () => {
    const alice = await signUp('Alice');
    const next = `moved.${randomUUID().slice(0, 8)}@payhive.test`;

    const response = await alice.agent
      .patch('/auth/me')
      .send({ email: next, currentPassword: PASSWORD })
      .expect(200);

    expect(response.body.pendingEmail).toBeDefined();

    // The old address still signs in, and the new one does not: a typo here
    // must cost an undelivered email, not an account. Confirming the link is
    // covered in reset.test.ts.
    await request(app)
      .post('/auth/login')
      .send({ email: alice.email, password: PASSWORD })
      .expect(200);
    await request(app).post('/auth/login').send({ email: next, password: PASSWORD }).expect(401);
  });

  it('does not reveal whether an email already has an account', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');

    // Indistinguishable from a free address: same status, same body shape. The
    // difference is that no link is ever sent, so the change cannot complete.
    const taken = await alice.agent
      .patch('/auth/me')
      .send({ email: bob.email, currentPassword: PASSWORD })
      .expect(200);
    const free = await alice.agent
      .patch('/auth/me')
      .send({ email: `free.${randomUUID().slice(0, 8)}@payhive.test`, currentPassword: PASSWORD })
      .expect(200);

    expect(Object.keys(taken.body).sort()).toEqual(Object.keys(free.body).sort());

    // Bob still owns his address.
    await request(app).post('/auth/login').send({ email: bob.email, password: PASSWORD }).expect(200);
  });

  it('rejects an update that changes nothing', async () => {
    const alice = await signUp('Alice');
    await alice.agent.patch('/auth/me').send({}).expect(400);
  });

  it('requires a session', async () => {
    await request(app).patch('/auth/me').send({ displayName: 'Nobody' }).expect(401);
  });
});

describe('changing a password', () => {
  it('requires the current one', async () => {
    const alice = await signUp('Alice');
    const response = await alice.agent
      .put('/auth/me/password')
      .send({ currentPassword: 'wrong-password', newPassword: 'a-brand-new-password' })
      .expect(403);

    expect(response.body.error.code).toBe('invalid_credentials');
  });

  it('holds the new password to a minimum length', async () => {
    const alice = await signUp('Alice');
    await alice.agent
      .put('/auth/me/password')
      .send({ currentPassword: PASSWORD, newPassword: 'short' })
      .expect(400);
  });

  it('changes it and signs the other sessions out', async () => {
    const alice = await signUp('Alice');

    // A second signed-in session, as though on another device.
    const other = request.agent(app);
    await other.post('/auth/login').send({ email: alice.email, password: PASSWORD }).expect(200);
    await other.get('/auth/me').expect(200);

    await alice.agent
      .put('/auth/me/password')
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' })
      .expect(204);

    // If the reason for changing a password is that somebody else has it,
    // leaving their session alive defeats the change.
    await other.get('/auth/me').expect(401);
    // The session that made the change stays signed in.
    await alice.agent.get('/auth/me').expect(200);

    await request(app)
      .post('/auth/login')
      .send({ email: alice.email, password: 'a-brand-new-password' })
      .expect(200);
    await request(app).post('/auth/login').send({ email: alice.email, password: PASSWORD }).expect(401);
  });
});
