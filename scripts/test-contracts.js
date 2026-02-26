#!/usr/bin/env node
/**
 * VAEB Smart Contract Tests
 *
 * Tests AgentWallet and AgentWalletFactory by deploying fresh instances
 * on Base Sepolia and exercising all key paths.
 *
 * Covers:
 *   AgentWallet.executeDirectly    — happy path + all revert cases
 *   AgentWallet.executeWithProof   — MockZKVerifier path + revert cases
 *   AgentWallet.nonce management   — invalidate, replay protection
 *   AgentWallet.admin              — setAgent, setZkVerifier
 *   AgentWalletFactory             — createWallet, predictAddress, registry
 *
 * Run:
 *   node scripts/test-contracts.js
 *
 * Requirements:
 *   OWNER_PRIVATE_KEY and AGENT_PRIVATE_KEY in .env
 *   Both wallets funded with Base Sepolia ETH (faucet: https://faucet.base.org)
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

// ─── Setup ───────────────────────────────────────────────────────

const OWNER_KEY = process.env.OWNER_PRIVATE_KEY;
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY;
const RPC_URL   = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const CHAIN_ID  = 84532;

const outDir = path.join(__dirname, "..", "contracts", "out");

if (!OWNER_KEY || !AGENT_KEY) {
  console.error("❌ OWNER_PRIVATE_KEY and AGENT_PRIVATE_KEY required in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const owner    = new ethers.Wallet(OWNER_KEY, provider);
const agent    = new ethers.Wallet(AGENT_KEY, provider);
const stranger = ethers.Wallet.createRandom().connect(provider);

// ─── Artifact loader ─────────────────────────────────────────────

function loadArtifact(contractName) {
  const files      = fs.readdirSync(outDir);
  const candidates = files
    .filter(f => f.endsWith(".abi") && f.includes(`${contractName}_sol_${contractName}`))
    .sort((a, b) => a.length - b.length);
  if (candidates.length === 0)
    throw new Error(`No compiled artifact for ${contractName} in contracts/out/`);
  const base = candidates[0];
  return {
    abi:      JSON.parse(fs.readFileSync(path.join(outDir, base), "utf8")),
    bytecode: "0x" + fs.readFileSync(path.join(outDir, base.replace(".abi", ".bin")), "utf8").trim(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label, fn) {
  process.stdout.write(`  ${label.padEnd(52)}`);
  try {
    await fn();
    console.log("✅");
    passed++;
  } catch (err) {
    console.log(`❌  ${err.message.split("\n")[0].slice(0, 80)}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(64));
}

/** Fresh random bytes32 nonce (31 bytes padded, fits BN254 scalar field) */
function freshNonce() {
  return ethers.zeroPadValue(ethers.hexlify(ethers.randomBytes(31)), 32);
}

/** Expiry 10 minutes from now */
function freshExpiry() {
  return Math.floor(Date.now() / 1000) + 600;
}

/** EIP-712 signature for executeDirectly */
async function signDirectExecution(wallet, agentWalletAddress, nonce, expiry, callsHash) {
  return wallet.signTypedData(
    { name: "VAEB AgentWallet", version: "1", chainId: CHAIN_ID, verifyingContract: agentWalletAddress },
    { DirectExecution: [
        { name: "nonce",     type: "bytes32" },
        { name: "expiry",    type: "uint256" },
        { name: "callsHash", type: "bytes32" },
      ],
    },
    { nonce, expiry, callsHash }
  );
}

/** EIP-712 signature for executeWithProof (signs the commitment directly) */
async function signCommitment(wallet, domainSeparator, commitment) {
  const digest = ethers.keccak256(
    ethers.concat([
      "0x1901",
      domainSeparator,
      commitment,
    ])
  );
  const signingKey = new ethers.SigningKey(wallet.privateKey);
  return ethers.Signature.from(signingKey.sign(digest)).serialized;
}

/** keccak256(abi.encode(calls)) — matches AgentWallet._hashCalls() */
function hashCalls(calls) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["tuple(address target, uint256 value, bytes data)[]"],
      [calls]
    )
  );
}

/** Deploy a fresh AgentWallet(owner, agent, mockVerifier) */
async function deployAgentWallet(mockVerifierAddress) {
  const art = loadArtifact("AgentWallet");
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, owner);
  const wallet = await factory.deploy(owner.address, agent.address, mockVerifierAddress);
  await wallet.waitForDeployment();
  return wallet;
}

/** Deploy a fresh MockZKVerifier */
async function deployMockVerifier() {
  const art = loadArtifact("MockZKVerifier");
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, owner);
  const v = await factory.deploy();
  await v.waitForDeployment();
  return v;
}

/** Deploy a fresh MockERC20 (for transfer call tests) */
async function deployMockUSDC() {
  const art = loadArtifact("MockERC20");
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, owner);
  const token = await factory.deploy("MockUSDC", "USDC", 6);
  await token.waitForDeployment();
  return token;
}

/** Build a simple ERC-20 transfer call */
function buildTransferCall(tokenAddress, recipient, amount) {
  const iface = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
  return {
    target: tokenAddress,
    value: 0n,
    data: iface.encodeFunctionData("transfer", [recipient, amount]),
  };
}

// ─── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(64));
  console.log("  VAEB Smart Contract Tests");
  console.log("═".repeat(64));
  console.log(`  Owner:    ${owner.address}`);
  console.log(`  Agent:    ${agent.address}`);
  console.log(`  RPC:      ${RPC_URL}`);

  // Check balances
  const ownerBal = await provider.getBalance(owner.address);
  const agentBal = await provider.getBalance(agent.address);
  console.log(`  Owner ETH:  ${ethers.formatEther(ownerBal)}`);
  console.log(`  Agent ETH:  ${ethers.formatEther(agentBal)}`);
  if (ownerBal < ethers.parseEther("0.005") || agentBal < ethers.parseEther("0.001")) {
    console.error("\n❌ Insufficient ETH. Fund wallets via https://faucet.base.org");
    process.exit(1);
  }

  // ── Shared fixtures ──────────────────────────────────────────
  const mockVerifier = await deployMockVerifier();
  const mockUSDC     = await deployMockUSDC();
  const agentWallet  = await deployAgentWallet(await mockVerifier.getAddress());
  const walletAddr   = await agentWallet.getAddress();

  // Mint USDC to AgentWallet for transfer tests
  await (await mockUSDC.mint(walletAddr, ethers.parseUnits("1000", 6))).wait();

  const NO_CALLS  = [];
  const ONE_CALL  = [buildTransferCall(await mockUSDC.getAddress(), owner.address, ethers.parseUnits("1", 6))];
  const domainSep = await agentWallet.domainSeparator();

  // ══ executeDirectly ══════════════════════════════════════════

  section("AgentWallet — executeDirectly");

  await test("happy path: owner signs, agent submits", async () => {
    const nonce    = freshNonce();
    const expiry   = freshExpiry();
    const callsH   = hashCalls(ONE_CALL);
    const sig      = await signDirectExecution(owner, walletAddr, nonce, expiry, callsH);
    const agentConn = agentWallet.connect(agent);
    const tx = await agentConn.executeDirectly(sig, nonce, expiry, ONE_CALL, { gasLimit: 200000 });
    await tx.wait();
  });

  await test("happy path: owner signs AND submits", async () => {
    const nonce  = freshNonce();
    const expiry = freshExpiry();
    const callsH = hashCalls(ONE_CALL);
    const sig    = await signDirectExecution(owner, walletAddr, nonce, expiry, callsH);
    const tx = await agentWallet.executeDirectly(sig, nonce, expiry, ONE_CALL, { gasLimit: 200000 });
    await tx.wait();
  });

  await test("reverts: InvalidSignature (stranger signs)", async () => {
    const nonce  = freshNonce();
    const expiry = freshExpiry();
    const callsH = hashCalls(ONE_CALL);
    const sig    = await signDirectExecution(stranger, walletAddr, nonce, expiry, callsH);
    const agentConn = agentWallet.connect(agent);
    try {
      await agentConn.executeDirectly(sig, nonce, expiry, ONE_CALL, { gasLimit: 200000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("InvalidSignature")) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await test("reverts: IntentExpired (expiry in the past)", async () => {
    const nonce  = freshNonce();
    const expiry = Math.floor(Date.now() / 1000) - 60; // 1 min ago
    const callsH = hashCalls(ONE_CALL);
    const sig    = await signDirectExecution(owner, walletAddr, nonce, expiry, callsH);
    try {
      await agentWallet.executeDirectly(sig, nonce, expiry, ONE_CALL, { gasLimit: 200000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("IntentExpired")) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await test("reverts: NonceAlreadyUsed (replay attack)", async () => {
    const nonce  = freshNonce();
    const expiry = freshExpiry();
    const callsH = hashCalls(ONE_CALL);
    const sig    = await signDirectExecution(owner, walletAddr, nonce, expiry, callsH);
    // First call succeeds
    await (await agentWallet.executeDirectly(sig, nonce, expiry, ONE_CALL, { gasLimit: 200000 })).wait();
    // Second call with same nonce must fail
    try {
      await agentWallet.executeDirectly(sig, nonce, expiry, ONE_CALL, { gasLimit: 200000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("NonceAlreadyUsed")) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await test("reverts: EmptyCalls", async () => {
    const nonce  = freshNonce();
    const expiry = freshExpiry();
    const callsH = hashCalls(NO_CALLS);
    const sig    = await signDirectExecution(owner, walletAddr, nonce, expiry, callsH);
    try {
      await agentWallet.executeDirectly(sig, nonce, expiry, NO_CALLS, { gasLimit: 200000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("EmptyCalls")) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await test("reverts: NotOwnerOrAgent (stranger submits)", async () => {
    // Fund stranger enough for gas
    await (await owner.sendTransaction({ to: stranger.address, value: ethers.parseEther("0.002") })).wait();
    const nonce  = freshNonce();
    const expiry = freshExpiry();
    const callsH = hashCalls(ONE_CALL);
    const sig    = await signDirectExecution(owner, walletAddr, nonce, expiry, callsH);
    try {
      await agentWallet.connect(stranger).executeDirectly(sig, nonce, expiry, ONE_CALL, { gasLimit: 200000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("NotOwnerOrAgent")) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  // ══ executeWithProof ════════════════════════════════════════

  section("AgentWallet — executeWithProof");

  await test("happy path: MockZKVerifier accepts any proof", async () => {
    const nonce      = freshNonce();
    const expiry     = freshExpiry();
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("test-commitment-" + Date.now()));
    const sig        = await signCommitment(owner, domainSep, commitment);
    const publicInputs = {
      commitment,
      chainId:            CHAIN_ID,
      signerAddress:      owner.address,
      multicallDataHash:  ethers.keccak256(ethers.toUtf8Bytes("calls")),
      nonce,
      expiry,
    };
    const proof = "0x" + "00".repeat(32); // MockZKVerifier ignores proof content
    const tx = await agentWallet.connect(agent).executeWithProof(
      proof, sig, publicInputs, ONE_CALL, { gasLimit: 300000 }
    );
    await tx.wait();
  });

  await test("reverts: WrongChain (chainId mismatch)", async () => {
    const nonce = freshNonce();
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("commitment-" + Date.now()));
    const sig = await signCommitment(owner, domainSep, commitment);
    const publicInputs = {
      commitment,
      chainId:           1, // Ethereum mainnet ≠ Base Sepolia
      signerAddress:     owner.address,
      multicallDataHash: ethers.keccak256(ethers.toUtf8Bytes("calls")),
      nonce,
      expiry:            freshExpiry(),
    };
    try {
      await agentWallet.connect(agent).executeWithProof("0x", sig, publicInputs, ONE_CALL, { gasLimit: 300000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("WrongChain")) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await test("reverts: SignerMismatch (wrong signerAddress in publicInputs)", async () => {
    const nonce = freshNonce();
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("commitment-" + Date.now()));
    const sig = await signCommitment(owner, domainSep, commitment);
    const publicInputs = {
      commitment,
      chainId:           CHAIN_ID,
      signerAddress:     agent.address, // ≠ owner
      multicallDataHash: ethers.keccak256(ethers.toUtf8Bytes("calls")),
      nonce,
      expiry:            freshExpiry(),
    };
    try {
      await agentWallet.connect(agent).executeWithProof("0x", sig, publicInputs, ONE_CALL, { gasLimit: 300000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("SignerMismatch") && !e.message.includes("InvalidSignature"))
        throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await test("reverts: InvalidSignature (stranger signed commitment)", async () => {
    const nonce = freshNonce();
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("commitment-" + Date.now()));
    const sig = await signCommitment(stranger, domainSep, commitment); // wrong signer
    const publicInputs = {
      commitment,
      chainId:           CHAIN_ID,
      signerAddress:     owner.address,
      multicallDataHash: ethers.keccak256(ethers.toUtf8Bytes("calls")),
      nonce,
      expiry:            freshExpiry(),
    };
    try {
      await agentWallet.connect(agent).executeWithProof("0x", sig, publicInputs, ONE_CALL, { gasLimit: 300000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("InvalidSignature")) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  // ══ Nonce management ═════════════════════════════════════════

  section("AgentWallet — Nonce Management");

  await test("isNonceUsed returns false for fresh nonce", async () => {
    const nonce = freshNonce();
    const used = await agentWallet.isNonceUsed(nonce);
    if (used) throw new Error("fresh nonce reported as used");
  });

  await test("isNonceUsed returns true after executeDirectly", async () => {
    const nonce  = freshNonce();
    const expiry = freshExpiry();
    const callsH = hashCalls(ONE_CALL);
    const sig    = await signDirectExecution(owner, walletAddr, nonce, expiry, callsH);
    await (await agentWallet.executeDirectly(sig, nonce, expiry, ONE_CALL, { gasLimit: 200000 })).wait();
    const used = await agentWallet.isNonceUsed(nonce);
    if (!used) throw new Error("nonce not marked as used after execution");
  });

  await test("invalidateNonce: owner can invalidate", async () => {
    const nonce = freshNonce();
    if (await agentWallet.isNonceUsed(nonce)) throw new Error("should be fresh");
    await (await agentWallet.invalidateNonce(nonce)).wait();
    if (!(await agentWallet.isNonceUsed(nonce))) throw new Error("nonce not invalidated");
  });

  await test("invalidateNonce: reverts for non-owner", async () => {
    const nonce = freshNonce();
    try {
      await agentWallet.connect(agent).invalidateNonce(nonce, { gasLimit: 100000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("NotOwner")) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await test("invalidateNonceRange: bulk invalidation", async () => {
    const nonces = [freshNonce(), freshNonce(), freshNonce()];
    await (await agentWallet.invalidateNonceRange(nonces)).wait();
    for (const n of nonces) {
      if (!(await agentWallet.isNonceUsed(n))) throw new Error(`Nonce ${n} not invalidated`);
    }
  });

  // ══ Admin ════════════════════════════════════════════════════

  section("AgentWallet — Admin");

  await test("setAgent: owner can update agent", async () => {
    const newAgent = ethers.Wallet.createRandom().address;
    await (await agentWallet.setAgent(newAgent)).wait();
    const current = await agentWallet.agent();
    if (current !== newAgent) throw new Error("agent not updated");
    // Restore original agent
    await (await agentWallet.setAgent(agent.address)).wait();
  });

  await test("setAgent: reverts for non-owner", async () => {
    try {
      await agentWallet.connect(agent).setAgent(agent.address, { gasLimit: 100000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("NotOwner")) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await test("setZkVerifier: owner can update verifier", async () => {
    const newVerifier = ethers.Wallet.createRandom().address;
    await (await agentWallet.setZkVerifier(newVerifier)).wait();
    const current = await agentWallet.zkVerifier();
    if (current !== newVerifier) throw new Error("verifier not updated");
    // Restore mock verifier
    await (await agentWallet.setZkVerifier(await mockVerifier.getAddress())).wait();
  });

  await test("setZkVerifier: reverts for non-owner", async () => {
    try {
      await agentWallet.connect(agent).setZkVerifier(agent.address, { gasLimit: 100000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("NotOwner")) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await test("receive() ETH: AgentWallet accepts ETH", async () => {
    const tx = await owner.sendTransaction({ to: walletAddr, value: ethers.parseEther("0.001") });
    await tx.wait();
    const bal = await provider.getBalance(walletAddr);
    if (bal < ethers.parseEther("0.001")) throw new Error("ETH not received");
  });

  // ══ AgentWalletFactory ═══════════════════════════════════════

  section("AgentWalletFactory");

  const factoryArt = loadArtifact("AgentWalletFactory");
  const FactoryContract = new ethers.ContractFactory(factoryArt.abi, factoryArt.bytecode, owner);
  const factory = await FactoryContract.deploy(await mockVerifier.getAddress());
  await factory.waitForDeployment();

  let deployedWalletAddr;

  await test("createWallet: deploys AgentWallet with correct owner/agent", async () => {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const tx = await factory.createWallet(owner.address, agent.address, salt);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => {
      try { return factory.interface.parseLog(l)?.name === "WalletCreated"; } catch { return false; }
    });
    if (!event) throw new Error("WalletCreated event not emitted");
    const parsed = factory.interface.parseLog(event);
    deployedWalletAddr = parsed.args.wallet;

    const deployedWallet = new ethers.Contract(deployedWalletAddr, loadArtifact("AgentWallet").abi, provider);
    const walletOwner = await deployedWallet.owner();
    const walletAgent = await deployedWallet.agent();
    if (walletOwner !== owner.address) throw new Error(`Wrong owner: ${walletOwner}`);
    if (walletAgent !== agent.address) throw new Error(`Wrong agent: ${walletAgent}`);
  });

  await test("predictWalletAddress: matches deployed address", async () => {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const predicted = await factory.predictWalletAddress(owner.address, agent.address, salt);
    const tx = await factory.createWallet(owner.address, agent.address, salt);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => {
      try { return factory.interface.parseLog(l)?.name === "WalletCreated"; } catch { return false; }
    });
    const parsed = factory.interface.parseLog(event);
    const actual = parsed.args.wallet;
    if (predicted.toLowerCase() !== actual.toLowerCase())
      throw new Error(`Predicted ${predicted} ≠ actual ${actual}`);
  });

  await test("isWallet: true for factory-deployed wallet", async () => {
    if (!deployedWalletAddr) throw new Error("no deployed wallet from earlier test");
    const isWallet = await factory.isWallet(deployedWalletAddr);
    if (!isWallet) throw new Error("isWallet returned false");
  });

  await test("isWallet: false for non-factory wallet", async () => {
    const isWallet = await factory.isWallet(walletAddr); // our test wallet, not from factory
    if (isWallet) throw new Error("isWallet should be false for externally deployed wallet");
  });

  await test("getWallets: returns all wallets for owner", async () => {
    const wallets = await factory.getWallets(owner.address);
    if (wallets.length < 2) throw new Error(`Expected ≥2 wallets, got ${wallets.length}`);
  });

  await test("walletCount: returns correct count", async () => {
    const count = await factory.walletCount(owner.address);
    if (count < 2n) throw new Error(`Expected ≥2, got ${count}`);
  });

  await test("setDefaultZkVerifier: factory owner can update", async () => {
    const newV = ethers.Wallet.createRandom().address;
    await (await factory.setDefaultZkVerifier(newV)).wait();
    const current = await factory.defaultZkVerifier();
    if (current !== newV) throw new Error("verifier not updated");
  });

  await test("setDefaultZkVerifier: non-owner reverts", async () => {
    try {
      await factory.connect(agent).setDefaultZkVerifier(agent.address, { gasLimit: 100000 });
      throw new Error("expected revert");
    } catch (e) {
      if (!e.message.includes("NotFactoryOwner")) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  // ── Summary ──────────────────────────────────────────────────
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log("═".repeat(64) + "\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("\n❌ Test runner crashed:", err.message);
  process.exit(1);
});
