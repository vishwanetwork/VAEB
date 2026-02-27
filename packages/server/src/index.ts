import express from 'express';
import cors from 'cors';
import { CONFIG, CHAIN_CONFIGS, DEFAULT_CHAIN } from './config';
import routes from './routes';
import chatRouter from './chat';

// ─── Global crash protection ──────────────────────────────────
// Prevents the entire process from dying on unexpected async errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
});

const app = express();

app.use(cors());
app.use(express.json());
app.use('/api', routes);
app.use('/api', chatRouter);

// Express error-handling middleware (catches unhandled sync/async errors in routes)
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Server] Express error:', err?.message || err);
  if (!res.headersSent) {
    res.status(500).json({ error: err?.message || 'Internal server error' });
  }
});

app.listen(CONFIG.port, () => {
  const chains = Object.values(CHAIN_CONFIGS);
  console.log(`\n  VAEB Server`);
  console.log(`  Port:         ${CONFIG.port}`);
  console.log(`  Default:      ${DEFAULT_CHAIN}`);
  console.log(`  Chains:       ${chains.map(c => `${c.chainName} (${c.chainId})`).join(', ')}`);
  for (const c of chains) {
    console.log(`  [${c.key}] AgentWallet: ${c.contracts.AgentWallet}`);
  }
  console.log();
});
