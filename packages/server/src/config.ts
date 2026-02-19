import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const CONFIG = {
  port: parseInt(process.env.PORT || '3002'),
  agentPrivateKey: process.env.AGENT_PRIVATE_KEY || '',
  ownerAddress: process.env.OWNER_ADDRESS || '',
  rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
  chainId: parseInt(process.env.CHAIN_ID || '84532'),
  contracts: {
    AgentWallet: process.env.AGENT_WALLET_ADDRESS || '0x4D7c95c0dd8840CD597DF7D75fb2D7ADc08bA0AA',
    MockUSDC: '0xE66D20A340e3F45C55d3A7cfB6b25458d9b0d193',
    Verifier: '0xE004ff1dE5009b12c11DE00616Ac7a28437e3475',
    Adapter: '0x7206d80BA38EDFd439951339eEAd95E3f301d8C8',
  },
  explorer: 'https://sepolia.basescan.org',
};
