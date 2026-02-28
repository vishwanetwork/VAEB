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

// Only Base Mainnet - production network
export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  base: {
    key: 'base',
    chainId: 8453,
    chainIdHex: '0x2105',
    chainName: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    contracts: {
      // Update these with your deployed contracts on Base mainnet
      AgentWallet: '0x0000000000000000000000000000000000000000',
      MockUSDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
    },
  },
};

export const DEFAULT_CHAIN = 'base';

// Static config (non-chain-specific)
export const CONFIG = {
  apiUrl: '/api',
};
