import express from 'express';
import cors from 'cors';
import { CONFIG } from './config';
import routes from './routes';

const app = express();

app.use(cors());
app.use(express.json());
app.use('/api', routes);

app.listen(CONFIG.port, () => {
  console.log(`\n  VAEB Server`);
  console.log(`  Port:         ${CONFIG.port}`);
  console.log(`  Chain:        Base Sepolia (${CONFIG.chainId})`);
  console.log(`  AgentWallet:  ${CONFIG.contracts.AgentWallet}`);
  console.log(`  Explorer:     ${CONFIG.explorer}\n`);
});
