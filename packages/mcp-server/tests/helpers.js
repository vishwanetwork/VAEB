"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FakeProvider = exports.TEST_ADDRESSES = exports.TEST_PRIVATE_KEY = void 0;
exports.makeContractFactory = makeContractFactory;
exports.baseConfig = baseConfig;
const ethers_1 = require("ethers");
exports.TEST_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f094538eed6e0e9b8d2a1f2a62f1c4a8f7f7e6d0";
exports.TEST_ADDRESSES = {
    agentWallet: "0x1111111111111111111111111111111111111111",
    factory: "0x2222222222222222222222222222222222222222",
    usdc: "0x3333333333333333333333333333333333333333",
    owner: "0x4444444444444444444444444444444444444444",
    agent: "0x5555555555555555555555555555555555555555",
};
class FakeProvider {
    balances;
    receipts;
    gasPrice;
    constructor(opts) {
        this.balances = new Map(Object.entries(opts?.balances || {}).map(([k, v]) => [k.toLowerCase(), v]));
        this.receipts = new Map(Object.entries(opts?.receipts || {}).map(([k, v]) => [k, v]));
        this.gasPrice = opts?.gasPrice ?? ethers_1.ethers.parseUnits("1", "gwei");
    }
    async getBalance(address) {
        return this.balances.get(address.toLowerCase()) ?? 0n;
    }
    async getFeeData() {
        return { gasPrice: this.gasPrice };
    }
    async getTransactionReceipt(hash) {
        return this.receipts.get(hash) ?? null;
    }
}
exports.FakeProvider = FakeProvider;
function makeContractFactory(fixtures = {}) {
    const usedNonces = fixtures.usedNonces || new Set();
    const usdcBalance = fixtures.usdcBalance ?? 0n;
    const usdcDecimals = fixtures.usdcDecimals ?? 6;
    const usdcSymbol = fixtures.usdcSymbol ?? "USDC";
    const predictedAddress = fixtures.predictedAddress || exports.TEST_ADDRESSES.agentWallet;
    const walletsByOwner = fixtures.walletsByOwner || {};
    const deployedWallets = fixtures.deployedWallets || new Set();
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
        isNonceUsed: async (nonce) => usedNonces.has(nonce),
        executeWithProof: async () => tx,
        executeDirectly: async () => tx,
        // ERC20
        balanceOf: async () => usdcBalance,
        decimals: async () => usdcDecimals,
        symbol: async () => usdcSymbol,
        name: async () => "Mock USDC",
        // Factory
        predictWalletAddress: async () => predictedAddress,
        isWallet: async (addr) => deployedWallets.has(addr),
        getWallets: async (owner) => walletsByOwner[owner] || [],
        createWallet: async () => tx,
    });
}
function baseConfig(overrides) {
    return {
        walletPrivateKey: exports.TEST_PRIVATE_KEY,
        supportedChains: ["base_sepolia"],
        defaultChain: "base_sepolia",
        proverEndpoint: "http://localhost:3001",
        requireManualApproval: false,
        rpcUrl: "http://localhost:8545",
        chainId: 84532,
        contracts: {
            AgentWallet: exports.TEST_ADDRESSES.agentWallet,
            MockUSDC: exports.TEST_ADDRESSES.usdc,
            AgentWalletFactory: exports.TEST_ADDRESSES.factory,
        },
        ...overrides,
    };
}
//# sourceMappingURL=helpers.js.map