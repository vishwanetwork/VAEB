"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const wallet_tools_1 = require("../src/tools/wallet-tools");
const helpers_1 = require("./helpers");
(0, node_test_1.test)("walletTools.predict_wallet returns predicted address", async () => {
    const provider = new helpers_1.FakeProvider();
    const contractFactory = (0, helpers_1.makeContractFactory)({
        predictedAddress: "0x9999999999999999999999999999999999999999",
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
    });
    const result = await wallet_tools_1.walletTools.handle("predict_wallet", {
        owner: helpers_1.TEST_ADDRESSES.owner,
        salt_index: 0,
    }, config);
    strict_1.default.equal(result.predicted_address, "0x9999999999999999999999999999999999999999");
    strict_1.default.equal(result.already_deployed, false);
});
(0, node_test_1.test)("walletTools.predict_wallet marks already deployed wallets", async () => {
    const predicted = "0x8888888888888888888888888888888888888888";
    const provider = new helpers_1.FakeProvider();
    const contractFactory = (0, helpers_1.makeContractFactory)({
        predictedAddress: predicted,
        deployedWallets: new Set([predicted]),
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
    });
    const result = await wallet_tools_1.walletTools.handle("predict_wallet", {
        owner: helpers_1.TEST_ADDRESSES.owner,
        salt_index: 1,
    }, config);
    strict_1.default.equal(result.already_deployed, true);
});
(0, node_test_1.test)("walletTools.get_wallets returns wallet list", async () => {
    const wallets = [
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ];
    const provider = new helpers_1.FakeProvider();
    const contractFactory = (0, helpers_1.makeContractFactory)({
        walletsByOwner: { [helpers_1.TEST_ADDRESSES.owner]: wallets },
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
    });
    const result = await wallet_tools_1.walletTools.handle("get_wallets", { owner: helpers_1.TEST_ADDRESSES.owner }, config);
    strict_1.default.equal(result.count, 2);
    strict_1.default.equal(result.wallets[0].address, wallets[0]);
});
(0, node_test_1.test)("walletTools.create_wallet deploys when not already deployed", async () => {
    const predicted = "0x7777777777777777777777777777777777777777";
    const provider = new helpers_1.FakeProvider();
    const contractFactory = (0, helpers_1.makeContractFactory)({
        predictedAddress: predicted,
        deployedWallets: new Set(),
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
    });
    const result = await wallet_tools_1.walletTools.handle("create_wallet", {
        owner: helpers_1.TEST_ADDRESSES.owner,
        salt_index: 99,
    }, config);
    strict_1.default.equal(result.wallet, predicted);
    strict_1.default.equal(result.owner, helpers_1.TEST_ADDRESSES.owner);
});
(0, node_test_1.test)("walletTools.create_wallet throws if already deployed", async () => {
    const predicted = "0x6666666666666666666666666666666666666666";
    const provider = new helpers_1.FakeProvider();
    const contractFactory = (0, helpers_1.makeContractFactory)({
        predictedAddress: predicted,
        deployedWallets: new Set([predicted]),
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
    });
    await strict_1.default.rejects(() => wallet_tools_1.walletTools.handle("create_wallet", { owner: helpers_1.TEST_ADDRESSES.owner, salt_index: 0 }, config), /Wallet already exists/);
});
//# sourceMappingURL=wallet-tools.test.js.map