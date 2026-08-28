import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { authRouter } from './routes/auth.js';
import { walletRouter } from './routes/wallets.js';
import { depositRouter } from './routes/deposits.js';
import { bankRouter } from './routes/bank.js';
import { webhookRouter } from './routes/webhooks.js';
import { loadUser, requireAdmin } from './middleware/auth.js';
import { reconcile } from './lib/ledger.js';
import { getProvider } from './providers/index.js';
import { pool } from './db/index.js';

export const app = express();

app.set('trust proxy', 1);

// BigInt does not survive JSON.stringify. Money leaves this API as a string in
// minor units plus a formatted form; this guard turns a forgotten conversion
// into a loud error instead of a 500 deep in the response writer.
app.set('json replacer', (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value,
);

/**
 * Allowed origins.
 *
 * A native shell does not have a normal web origin: Capacitor serves the app
 * from capacitor://localhost on iOS and http://localhost on Android, and those
 * are what arrive in the Origin header. They are listed by default because a
 * native client authenticates with a bearer token rather than a cookie, so
 * allowing them does not expose anything a cookie would.
 *
 * WEB_ORIGIN takes a comma-separated list for the deployed front ends.
 */
const ALLOWED_ORIGINS = [
  ...(process.env.WEB_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
];

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header at all: same-origin, curl, or a native HTTP client.
      // There is no browser to protect in that case.
      if (!origin) return callback(null, true);
      callback(null, ALLOWED_ORIGINS.includes(origin));
    },
    credentials: true,
  }),
);

// Webhooks first: they need the raw body, so they must not meet express.json().
app.use('/webhooks', webhookRouter);
app.use('/api/webhooks', webhookRouter);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(loadUser);

/**
 * The API lives on a router rather than directly on the app so it can be
 * mounted twice: at the root, which is how the tests and any direct client
 * call it, and under /api, which is what the browser uses.
 *
 * The browser path matters. The web client asks for /api/... on its own
 * origin, so in a single-service deployment the session cookie is same-origin
 * and never has to be SameSite=None. That is the same reason the Vite dev
 * server proxies /api — this keeps dev and production honest about it.
 */
const api = express.Router();

api.get('/health', async (_req, res) => {
  res.json({ ok: true, provider: getProvider().name });
});

/**
 * Proof that the books balance. Scrape it with a monitor and alert on
 * `ok: false`. Behind ADMIN_TOKEN because it reports every account's position,
 * not the caller's own.
 */
api.get('/admin/reconciliation', requireAdmin, async (_req, res) => {
  const report = await reconcile();
  res.status(report.ok ? 200 : 500).json(report);
});

api.use('/auth', authRouter);
api.use('/wallets', walletRouter);
api.use('/deposits', depositRouter);
api.use('/bank-accounts', bankRouter);

app.use(api);
app.use('/api', api);

/**
 * Serve the built web client when there is one. Gated on the directory
 * existing rather than on NODE_ENV, so a production build can be smoke-tested
 * locally without pretending to be production in every other respect.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = process.env.WEB_DIST ?? path.resolve(here, '../../web/dist');

if (existsSync(webDist)) {
  app.use(express.static(webDist));

  // SPA fallback. Registered after the API mounts, so it can only catch what
  // the API did not — an unknown /api path still has to 404 as JSON below
  // rather than being answered with index.html.
  app.get(/^(?!\/api\/|\/webhooks\/).*/, (_req, res, next) => {
    const index = path.join(webDist, 'index.html');
    if (!existsSync(index)) return next();
    res.sendFile(index);
  });
}

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } });
});

app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[payhive] unhandled error', error);
    res.status(500).json({
      error: {
        code: 'internal_error',
        // Never leak internals to a client that may be hostile.
        message: 'Something went wrong. The error has been logged.',
      },
    });
  },
);

const PORT = Number(process.env.PORT ?? 4000);

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`[payhive] api listening on :${PORT} (provider: ${getProvider().name})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[payhive] ${signal} received, shutting down`);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
