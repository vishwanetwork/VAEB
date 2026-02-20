import { test } from "node:test";
import assert from "node:assert/strict";
import { walletTools } from "../src/tools/wallet-tools";
import { baseConfig, makeContractFactory, TEST_ADDRESSES, FakeProvider } from "./helpers";

test("walletTools.predict_wallet returns predicted address", async () => {
  const provider = new FakeProvider();
  const contractFactory = makeContractFactory({
    predictedAddress: "0x9999999999999999999999999999999999999999",
  });
  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
  });

  const result = await walletTools.handle("predict_wallet", {
    owner: TEST_ADDRESSES.owner,
    salt_index: 0,
  }, config);

  assert.equal(result.predicted_address, "0x9999999999999999999999999999999999999999");
  assert.equal(result.already_deployed, false);
});

test("walletTools.predict_wallet marks already deployed wallets", async () => {
  const predicted = "0x8888888888888888888888888888888888888888";
  const provider = new FakeProvider();
  const contractFactory = makeContractFactory({
    predictedAddress: predicted,
    deployedWallets: new Set([predicted]),
  });
  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
  });

  const result = await walletTools.handle("predict_wallet", {
    owner: TEST_ADDRESSES.owner,
    salt_index: 1,
  }, config);

  assert.equal(result.already_deployed, true);
});

test("walletTools.get_wallets returns wallet list", async () => {
  const wallets = [
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ];
  const provider = new FakeProvider();
  const contractFactory = makeContractFactory({
    walletsByOwner: { [TEST_ADDRESSES.owner]: wallets },
  });
  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
  });

  const result = await walletTools.handle("get_wallets", { owner: TEST_ADDRESSES.owner }, config);
  assert.equal(result.count, 2);
  assert.equal(result.wallets[0].address, wallets[0]);
});

test("walletTools.create_wallet deploys when not already deployed", async () => {
  const predicted = "0x7777777777777777777777777777777777777777";
  const provider = new FakeProvider();
  const contractFactory = makeContractFactory({
    predictedAddress: predicted,
    deployedWallets: new Set(),
  });
  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
  });

  const result = await walletTools.handle("create_wallet", {
    owner: TEST_ADDRESSES.owner,
    salt_index: 99,
  }, config);

  assert.equal(result.wallet, predicted);
  assert.equal(result.owner, TEST_ADDRESSES.owner);
});

test("walletTools.create_wallet throws if already deployed", async () => {
  const predicted = "0x6666666666666666666666666666666666666666";
  const provider = new FakeProvider();
  const contractFactory = makeContractFactory({
    predictedAddress: predicted,
    deployedWallets: new Set([predicted]),
  });
  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
  });

  await assert.rejects(
    () => walletTools.handle("create_wallet", { owner: TEST_ADDRESSES.owner, salt_index: 0 }, config),
    /Wallet already exists/
  );
});
