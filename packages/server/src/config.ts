import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// ─── Chain Configuration ─────────────────────────────────────

export interface ChainConfig {
  key: string;
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  contracts: {
    AgentWallet: string;
    MockUSDC: string;
    Verifier: string;
    [key: string]: string;
  };
}

export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  base_sepolia: {
    key: 'base_sepolia',
    chainId: 84532,
    chainName: 'Base Sepolia',
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    contracts: {
      AgentWallet: process.env.AGENT_WALLET_ADDRESS || '0x6Ed542D19aeE41F50a31F2e84db3bB25e0B85C77',
      MockUSDC: '0xbff8F4E34c275ba115FCaeAF6EC515649f93ceA8',
      Verifier: '0x53d8DcaCc2cEC2293d33F9B4460c77233a41d058',
    },
  },
  kite_testnet: {
    key: 'kite_testnet',
    chainId: 2368,
    chainName: 'Kite AI Testnet',
    rpcUrl: process.env.KITE_TESTNET_RPC_URL || 'https://rpc-testnet.gokite.ai',
    explorer: 'https://testnet.kitescan.ai',
    contracts: {
      AgentWallet: process.env.KITE_AGENT_WALLET_ADDRESS || '0x517cbec020c79034cB7F3A2eeA843B17e3744cd3',
      MockUSDC: process.env.KITE_MOCK_USDC_ADDRESS || '0xE6725aAf7E8495a5952B0b89b3D51BCC5aeF4D3a',
      Verifier: '0x1ACE1d583fA07e67728C6Bab7091bc2954ab2308',
    },
  },
};

export const DEFAULT_CHAIN = process.env.DEFAULT_CHAIN || 'base_sepolia';

export function getChainConfig(chainKey?: string): ChainConfig {
  const key = chainKey || DEFAULT_CHAIN;
  const config = CHAIN_CONFIGS[key];
  if (!config) throw new Error(`Unknown chain: ${key}. Available: ${Object.keys(CHAIN_CONFIGS).join(', ')}`);
  return config;
}

// ─── Static config (non-chain-specific) ──────────────────────

const defaultChain = getChainConfig();

export const CONFIG = {
  port: parseInt(process.env.PORT || '3002'),
  agentPrivateKey: process.env.AGENT_PRIVATE_KEY || '',
  ownerAddress: process.env.OWNER_ADDRESS || '',
  // Default chain values (backward compat for legacy routes)
  rpcUrl: defaultChain.rpcUrl,
  chainId: defaultChain.chainId,
  contracts: defaultChain.contracts,
  explorer: defaultChain.explorer,
};
