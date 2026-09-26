import express from 'express';
import { usersRouter } from './routes/users';
import { billingRouter } from './routes/billing';

export function createApp() {
  const app = express();
  app.use('/users', usersRouter);
  app.use('/billing', billingRouter);
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}
