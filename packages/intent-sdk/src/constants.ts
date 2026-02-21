/**
 * VAEB Constants — Chain configs, contract addresses, and EIP-712 type definitions
 */

// ─── Chain Configuration ────────────────────────────────────────

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  blockExplorer: string;
  nativeCurrency: string;
  isEVM: boolean;
  avgGasCost: string;
  avgFinality: string;
  // Well-known token addresses
  tokens: Record<string, string>;
  // Well-known DEX routers
  dexRouters: Record<string, string>;
}

export const CHAINS: Record<string, ChainConfig> = {
  base_sepolia: {
    chainId: 84532,
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    blockExplorer: "https://sepolia.basescan.org",
    nativeCurrency: "ETH",
    isEVM: true,
    avgGasCost: "$0.001",
    avgFinality: "~2s",
    tokens: {
      USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia USDC
      WETH: "0x4200000000000000000000000000000000000006",
      ETH: "0x0000000000000000000000000000000000000000",
    },
    dexRouters: {
      uniswap_v3: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4", // Uniswap V3 SwapRouter on Base Sepolia
    },
  },
  base: {
    chainId: 8453,
    name: "Base",
    rpcUrl: "https://mainnet.base.org",
    blockExplorer: "https://basescan.org",
    nativeCurrency: "ETH",
    isEVM: true,
    avgGasCost: "$0.001",
    avgFinality: "~2s",
    tokens: {
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      WETH: "0x4200000000000000000000000000000000000006",
      ETH: "0x0000000000000000000000000000000000000000",
    },
    dexRouters: {
      uniswap_v3: "0x2626664c2603336E57B271c5C0b26F421741e481",
    },
  },
  ethereum_sepolia: {
    chainId: 11155111,
    name: "Ethereum Sepolia",
    rpcUrl: "https://rpc.sepolia.org",
    blockExplorer: "https://sepolia.etherscan.io",
    nativeCurrency: "ETH",
    isEVM: true,
    avgGasCost: "$2.50",
    avgFinality: "~12s",
    tokens: {
      USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
      ETH: "0x0000000000000000000000000000000000000000",
    },
    dexRouters: {
      uniswap_v3: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    },
  },
  kite_testnet: {
    chainId: 2368,
    name: "Kite AI Testnet",
    rpcUrl: "https://rpc-testnet.gokite.ai",
    blockExplorer: "https://testnet.kitescan.ai",
    nativeCurrency: "KITE",
    isEVM: true,
    avgGasCost: "$0.0001",
    avgFinality: "~1s",
    tokens: {
      // MockUSDC deployed by deploy-kite.js — updated in deployments.json after deploy
      USDC: "",
      ETH: "0x0000000000000000000000000000000000000000",
    },
    dexRouters: {},
  },
};

// ─── ERC-8004 Deployed Contract Addresses ───────────────────────

export const ERC8004_ADDRESSES: Record<string, {
  identityRegistry: string;
  reputationRegistry: string;
  validationRegistry: string | null;
}> = {
  base_sepolia: {
    identityRegistry:   "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validationRegistry: null,
  },
  ethereum_sepolia: {
    identityRegistry:   "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validationRegistry: null,
  },
  ethereum_mainnet: {
    identityRegistry:   "0x8004A169FB4a3325136EB29fA0ceB6D2e539a4320",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    validationRegistry: null,
  },
};

// ─── EIP-712 Type Definitions for IntentBundle ──────────────────

export const EIP712_DOMAIN_TYPE = {
  name: "VAEB AgentWallet",
  version: "1",
};

export const EIP712_TYPES = {
  IntentBundle: [
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint256" },
    { name: "payer", type: "address" },
    { name: "actions", type: "ActionEntry[]" },
  ],
  ActionEntry: [
    { name: "actionType", type: "string" },
    { name: "token", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

export const EIP712_ZK_INTENT_TYPES = {
  ZKIntent: [
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint256" },
    { name: "commitment", type: "bytes32" },
  ],
} as const;

// ─── Default Configuration ──────────────────────────────────────

export const DEFAULTS = {
  INTENT_VERSION: "1.0",
  EXPIRY_MINUTES: 10,
  DEFAULT_CHAIN: "base_sepolia",
  MAX_SERVICE_FEE_PER_TX: "0.10",    // USDC
  MAX_DAILY_SPEND: "5.00",            // USDC
  PROVER_ENDPOINT: "https://prover.vaeb.xyz",
  X402_FACILITATOR: "https://x402.coinbase.com",
  SERVICE_FEE_USDC: "0.02",           // Per proof generation
};

// ─── Uniswap V3 Function Selectors ─────────────────────────────

export const UNISWAP_V3_SELECTORS = {
  exactInputSingle: "0x414bf389",
  exactInput: "0xc04b8d59",
  exactOutputSingle: "0xdb3e2198",
  exactOutput: "0xf28c0498",
};

// ─── ERC-20 Function Selectors ──────────────────────────────────

export const ERC20_SELECTORS = {
  approve: "0x095ea7b3",
  transfer: "0xa9059cbb",
  transferFrom: "0x23b872dd",
  balanceOf: "0x70a08231",
};
