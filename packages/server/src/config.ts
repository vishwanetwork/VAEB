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
    MockUSDC: '0x93560481FE085E4Fd1A0f0bAb2E625118A67aC1D',
    Verifier: '0x83E59e879E1Ccf7bAd76FE9aeedBC1e5e3B50AcD',
    Adapter: '0x7206d80BA38EDFd439951339eEAd95E3f301d8C8',
  },
  explorer: 'https://sepolia.basescan.org',
};
