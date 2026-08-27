import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { authRouter } from './routes/auth.js';
import { walletRouter } from './routes/wallets.js';
import { depositRouter } from './routes/deposits.js';
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

app.use(
  cors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  }),
);

// Webhooks first: they need the raw body, so they must not meet express.json().
app.use('/webhooks', webhookRouter);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(loadUser);

app.get('/health', async (_req, res) => {
  res.json({ ok: true, provider: getProvider().name });
});

/**
 * Proof that the books balance. Scrape it with a monitor and alert on
 * `ok: false`. Behind ADMIN_TOKEN because it reports every account's position,
 * not the caller's own.
 */
app.get('/admin/reconciliation', requireAdmin, async (_req, res) => {
  const report = await reconcile();
  res.status(report.ok ? 200 : 500).json(report);
});

app.use('/auth', authRouter);
app.use('/wallets', walletRouter);
app.use('/deposits', depositRouter);

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
