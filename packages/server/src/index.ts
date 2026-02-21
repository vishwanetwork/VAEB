import express from 'express';
import cors from 'cors';
import { CONFIG, CHAIN_CONFIGS, DEFAULT_CHAIN } from './config';
import routes from './routes';
import chatRouter from './chat';

const app = express();

app.use(cors());
app.use(express.json());
app.use('/api', routes);
app.use('/api', chatRouter);

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
