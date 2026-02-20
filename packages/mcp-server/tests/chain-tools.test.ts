import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { chainTools } from "../src/tools/chain-tools";
import { FakeProvider, baseConfig, makeContractFactory, TEST_ADDRESSES } from "./helpers";

test("chainTools.get_wallet_balance returns ETH + USDC", async () => {
  const provider = new FakeProvider({
    balances: { [TEST_ADDRESSES.agentWallet]: ethers.parseEther("0.5") },
  });
  const contractFactory = makeContractFactory({
    usdcBalance: 1_230_000n,
  });

  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
  });

  const result = await chainTools.handle("get_wallet_balance", {}, config);
  assert.equal(result.agentWallet, TEST_ADDRESSES.agentWallet);
  assert.equal(result.eth, "0.5");
  assert.equal(result.usdc, "1.23");
  assert.equal(result.chain, "base_sepolia");
});

test("chainTools.check_nonce returns used=false for fresh nonce", async () => {
  const provider = new FakeProvider();
  const contractFactory = makeContractFactory({ usedNonces: new Set() });
  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
  });

  const nonce = "0x" + "01".repeat(32);
  const result = await chainTools.handle("check_nonce", { nonce }, config);
  assert.equal(result.used, false);
  assert.equal(result.safe_to_use, true);
});

test("chainTools.read_balance returns ETH balance", async () => {
  const provider = new FakeProvider({
    balances: { [TEST_ADDRESSES.agentWallet]: ethers.parseEther("2.0") },
  });
  const config = baseConfig({
    providerFactory: () => provider,
  });

  const result = await chainTools.handle("read_balance", {
    chain: "base_sepolia",
    token: "ETH",
    wallet: TEST_ADDRESSES.agentWallet,
  }, config);

  assert.equal(result.balance, "2.0");
  assert.equal(result.token, "ETH");
});

test("chainTools.read_balance returns ERC20 balance", async () => {
  const provider = new FakeProvider();
  const contractFactory = makeContractFactory({
    usdcBalance: 5_000_000n,
    usdcDecimals: 6,
    usdcSymbol: "USDC",
  });
  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
  });

  const result = await chainTools.handle("read_balance", {
    chain: "base_sepolia",
    token: "USDC",
    wallet: TEST_ADDRESSES.agentWallet,
  }, config);

  assert.equal(result.balance, "5.0");
  assert.equal(result.token, "USDC");
  assert.equal(result.decimals, 6);
});

test("chainTools.get_price returns simulated prices", async () => {
  const config = baseConfig();
  const result = await chainTools.handle("get_price", {
    pair: "ETH/USDC",
    chains: ["base_sepolia"],
  }, config);

  assert.equal(result.pair, "ETH/USDC");
  assert.ok(result.prices.base_sepolia.price > 0);
  assert.equal(result.bestPrice, "base_sepolia");
});

test("chainTools.estimate_gas uses fee data when available", async () => {
  const provider = new FakeProvider({ gasPrice: ethers.parseUnits("1", "gwei") });
  const config = baseConfig({
    providerFactory: () => provider,
  });

  const result = await chainTools.handle("estimate_gas", {
    chain: "base_sepolia",
    operation: "swap",
  }, config);

  assert.equal(result.estimatedGas, 250000);
  assert.equal(result.gasCostETH, "0.00025");
});

test("chainTools.get_receipt returns confirmed receipt", async () => {
  const receipt = {
    blockNumber: 123,
    status: 1,
    gasUsed: 21_000n,
    logs: [{ address: TEST_ADDRESSES.agentWallet, topics: [], data: "0x" }],
  };
  const provider = new FakeProvider({
    receipts: { ["0x" + "aa".repeat(32)]: receipt },
  });
  const config = baseConfig({
    providerFactory: () => provider,
  });

  const result = await chainTools.handle("get_receipt", {
    chain: "base_sepolia",
    tx_hash: "0x" + "aa".repeat(32),
  }, config);

  assert.equal(result.confirmed, true);
  assert.equal(result.status, "success");
  assert.equal(result.block, 123);
});
