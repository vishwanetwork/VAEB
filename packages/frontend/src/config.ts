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
      AgentWallet: '0x24E2942e8E218a6d635d4bFfeE5A79c7aeC11928',
      MockUSDC: '0x43bbC154FCae9F149a9DE92C06548c33e4666788',
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
      AgentWallet: '0x517cbec020c79034cB7F3A2eeA843B17e3744cd3',
      MockUSDC: '0xE6725aAf7E8495a5952B0b89b3D51BCC5aeF4D3a',
    },
  },
};

export const DEFAULT_CHAIN = 'kite_testnet';

// Static config (non-chain-specific)
export const CONFIG = {
  apiUrl: '/api',
};
