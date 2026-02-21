"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const ethers_1 = require("ethers");
const chain_tools_1 = require("../src/tools/chain-tools");
const helpers_1 = require("./helpers");
(0, node_test_1.test)("chainTools.get_wallet_balance returns ETH + USDC", async () => {
    const provider = new helpers_1.FakeProvider({
        balances: { [helpers_1.TEST_ADDRESSES.agentWallet]: ethers_1.ethers.parseEther("0.5") },
    });
    const contractFactory = (0, helpers_1.makeContractFactory)({
        usdcBalance: 1230000n,
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
    });
    const result = await chain_tools_1.chainTools.handle("get_wallet_balance", {}, config);
    strict_1.default.equal(result.agentWallet, helpers_1.TEST_ADDRESSES.agentWallet);
    strict_1.default.equal(result.eth, "0.5");
    strict_1.default.equal(result.usdc, "1.23");
    strict_1.default.equal(result.chain, "base_sepolia");
});
(0, node_test_1.test)("chainTools.check_nonce returns used=false for fresh nonce", async () => {
    const provider = new helpers_1.FakeProvider();
    const contractFactory = (0, helpers_1.makeContractFactory)({ usedNonces: new Set() });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
    });
    const nonce = "0x" + "01".repeat(32);
    const result = await chain_tools_1.chainTools.handle("check_nonce", { nonce }, config);
    strict_1.default.equal(result.used, false);
    strict_1.default.equal(result.safe_to_use, true);
});
(0, node_test_1.test)("chainTools.read_balance returns ETH balance", async () => {
    const provider = new helpers_1.FakeProvider({
        balances: { [helpers_1.TEST_ADDRESSES.agentWallet]: ethers_1.ethers.parseEther("2.0") },
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
    });
    const result = await chain_tools_1.chainTools.handle("read_balance", {
        chain: "base_sepolia",
        token: "ETH",
        wallet: helpers_1.TEST_ADDRESSES.agentWallet,
    }, config);
    strict_1.default.equal(result.balance, "2.0");
    strict_1.default.equal(result.token, "ETH");
});
(0, node_test_1.test)("chainTools.read_balance returns ERC20 balance", async () => {
    const provider = new helpers_1.FakeProvider();
    const contractFactory = (0, helpers_1.makeContractFactory)({
        usdcBalance: 5000000n,
        usdcDecimals: 6,
        usdcSymbol: "USDC",
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
    });
    const result = await chain_tools_1.chainTools.handle("read_balance", {
        chain: "base_sepolia",
        token: "USDC",
        wallet: helpers_1.TEST_ADDRESSES.agentWallet,
    }, config);
    strict_1.default.equal(result.balance, "5.0");
    strict_1.default.equal(result.token, "USDC");
    strict_1.default.equal(result.decimals, 6);
});
(0, node_test_1.test)("chainTools.get_price returns simulated prices", async () => {
    const config = (0, helpers_1.baseConfig)();
    const result = await chain_tools_1.chainTools.handle("get_price", {
        pair: "ETH/USDC",
        chains: ["base_sepolia"],
    }, config);
    strict_1.default.equal(result.pair, "ETH/USDC");
    strict_1.default.ok(result.prices.base_sepolia.price > 0);
    strict_1.default.equal(result.bestPrice, "base_sepolia");
});
(0, node_test_1.test)("chainTools.estimate_gas uses fee data when available", async () => {
    const provider = new helpers_1.FakeProvider({ gasPrice: ethers_1.ethers.parseUnits("1", "gwei") });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
    });
    const result = await chain_tools_1.chainTools.handle("estimate_gas", {
        chain: "base_sepolia",
        operation: "swap",
    }, config);
    strict_1.default.equal(result.estimatedGas, 250000);
    strict_1.default.equal(result.gasCostETH, "0.00025");
});
(0, node_test_1.test)("chainTools.get_receipt returns confirmed receipt", async () => {
    const receipt = {
        blockNumber: 123,
        status: 1,
        gasUsed: 21000n,
        logs: [{ address: helpers_1.TEST_ADDRESSES.agentWallet, topics: [], data: "0x" }],
    };
    const provider = new helpers_1.FakeProvider({
        receipts: { ["0x" + "aa".repeat(32)]: receipt },
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
    });
    const result = await chain_tools_1.chainTools.handle("get_receipt", {
        chain: "base_sepolia",
        tx_hash: "0x" + "aa".repeat(32),
    }, config);
    strict_1.default.equal(result.confirmed, true);
    strict_1.default.equal(result.status, "success");
    strict_1.default.equal(result.block, 123);
});
//# sourceMappingURL=chain-tools.test.js.map