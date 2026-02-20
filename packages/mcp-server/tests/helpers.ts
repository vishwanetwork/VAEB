import { ethers } from "ethers";

export const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f094538eed6e0e9b8d2a1f2a62f1c4a8f7f7e6d0";

export const TEST_ADDRESSES = {
  agentWallet: "0x1111111111111111111111111111111111111111",
  factory: "0x2222222222222222222222222222222222222222",
  usdc: "0x3333333333333333333333333333333333333333",
  owner: "0x4444444444444444444444444444444444444444",
  agent: "0x5555555555555555555555555555555555555555",
};

export class FakeProvider {
  private balances: Map<string, bigint>;
  private receipts: Map<string, any | null>;
  private gasPrice: bigint;

  constructor(opts?: { balances?: Record<string, bigint>; receipts?: Record<string, any | null>; gasPrice?: bigint }) {
    this.balances = new Map(
      Object.entries(opts?.balances || {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    this.receipts = new Map(
      Object.entries(opts?.receipts || {}).map(([k, v]) => [k, v])
    );
    this.gasPrice = opts?.gasPrice ?? ethers.parseUnits("1", "gwei");
  }

  async getBalance(address: string): Promise<bigint> {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }

  async getFeeData(): Promise<{ gasPrice: bigint }> {
    return { gasPrice: this.gasPrice };
  }

  async getTransactionReceipt(hash: string): Promise<any | null> {
    return this.receipts.get(hash) ?? null;
  }
}

export function makeContractFactory(fixtures: {
  usedNonces?: Set<string>;
  usdcBalance?: bigint;
  usdcDecimals?: number;
  usdcSymbol?: string;
  predictedAddress?: string;
  walletsByOwner?: Record<string, string[]>;
  deployedWallets?: Set<string>;
  txHash?: string;
  gasUsed?: bigint;
  blockNumber?: number;
} = {}) {
  const usedNonces = fixtures.usedNonces || new Set<string>();
  const usdcBalance = fixtures.usdcBalance ?? 0n;
  const usdcDecimals = fixtures.usdcDecimals ?? 6;
  const usdcSymbol = fixtures.usdcSymbol ?? "USDC";
  const predictedAddress = fixtures.predictedAddress || TEST_ADDRESSES.agentWallet;
  const walletsByOwner = fixtures.walletsByOwner || {};
  const deployedWallets = fixtures.deployedWallets || new Set<string>();
  const txHash = fixtures.txHash || "0x" + "ab".repeat(32);
  const gasUsed = fixtures.gasUsed ?? 21000n;
  const blockNumber = fixtures.blockNumber ?? 123;

  const tx = {
    hash: txHash,
    wait: async () => ({
      gasUsed,
      logs: [],
      blockNumber,
    }),
  };

  return () => ({
    // Wallet / AgentWallet
    isNonceUsed: async (nonce: string) => usedNonces.has(nonce),
    executeWithProof: async () => tx,
    executeDirectly: async () => tx,

    // ERC20
    balanceOf: async () => usdcBalance,
    decimals: async () => usdcDecimals,
    symbol: async () => usdcSymbol,
    name: async () => "Mock USDC",

    // Factory
    predictWalletAddress: async () => predictedAddress,
    isWallet: async (addr: string) => deployedWallets.has(addr),
    getWallets: async (owner: string) => walletsByOwner[owner] || [],
    createWallet: async () => tx,
  });
}

export function baseConfig(overrides?: Partial<any>) {
  return {
    walletPrivateKey: TEST_PRIVATE_KEY,
    supportedChains: ["base_sepolia"],
    defaultChain: "base_sepolia",
    proverEndpoint: "http://localhost:3001",
    requireManualApproval: false,
    rpcUrl: "http://localhost:8545",
    chainId: 84532,
    contracts: {
      AgentWallet: TEST_ADDRESSES.agentWallet,
      MockUSDC: TEST_ADDRESSES.usdc,
      AgentWalletFactory: TEST_ADDRESSES.factory,
    },
    ...overrides,
  };
}
