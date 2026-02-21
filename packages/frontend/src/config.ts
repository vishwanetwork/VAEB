export interface ChainConfig {
  key: string;
  chainId: number;
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  contracts: {
    AgentWallet: string;
    MockUSDC: string;
  };
}

export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  base_sepolia: {
    key: 'base_sepolia',
    chainId: 84532,
    chainIdHex: '0x14a34',
    chainName: 'Base Sepolia',
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    contracts: {
      AgentWallet: '0x99D238c22499e679e9d45578245083FE690C8B5f',
      MockUSDC: '0x93560481FE085E4Fd1A0f0bAb2E625118A67aC1D',
    },
  },
  kite_testnet: {
    key: 'kite_testnet',
    chainId: 2368,
    chainIdHex: '0x940',
    chainName: 'Kite AI Testnet',
    rpcUrl: 'https://rpc-testnet.gokite.ai',
    explorer: 'https://testnet.kitescan.ai',
    nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 },
    contracts: {
      // Filled in after running: node scripts/deploy-kite.js
      AgentWallet: '',
      MockUSDC: '',
    },
  },
};

export const DEFAULT_CHAIN = 'base_sepolia';

// Static config (non-chain-specific)
export const CONFIG = {
  apiUrl: '/api',
};
