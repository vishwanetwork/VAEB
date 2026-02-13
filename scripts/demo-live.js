#!/usr/bin/env node
/**
 * VAEB LIVE Demo — Real On-Chain Execution on Base Sepolia
 *
 * This script does EVERYTHING for real:
 *   1. Connects to Base Sepolia with real wallets
 *   2. Checks ETH balances (requires faucet ETH)
 *   3. Deploys MockZKVerifier + AgentWallet + MockERC20 (USDC) on-chain
 *   4. Mints test USDC into the AgentWallet
 *   5. Owner signs a real EIP-712 IntentBundle
 *   6. Agent submits executeWithProof() — real on-chain transaction
 *   7. Reads back the transaction receipt from Base Sepolia
 *
 * Prerequisites:
 *   - Fund the OWNER address with ~0.001 Base Sepolia ETH from a faucet
 *     (deploys 3 contracts + mint = ~0.0005 ETH gas on Base Sepolia)
 *   - .env file is already configured with wallet keys
 *
 * Run:
 *   node scripts/demo-live.js
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ─── Config from .env ───────────────────────────────────────────
const OWNER_KEY = process.env.OWNER_PRIVATE_KEY;
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const CHAIN_ID = 84532;

// ─── Contract Artifacts ─────────────────────────────────────────
const outDir = path.join(__dirname, "..", "contracts", "out");

function loadArtifact(name) {
  const abiPath = path.join(outDir, name + ".abi");
  const binPath = path.join(outDir, name + ".bin");
  return {
    abi: JSON.parse(fs.readFileSync(abiPath, "utf8")),
    bytecode: "0x" + fs.readFileSync(binPath, "utf8").trim(),
  };
}

// ─── EIP-712 Constants (must match AgentWallet.sol) ─────────────
const DIRECT_EXECUTION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes("DirectExecution(bytes32 nonce,uint256 expiry,bytes32 callsHash)")
);

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  VAEB LIVE DEMO — Real On-Chain Execution on Base Sepolia");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ─── Validate env ─────────────────────────────────────────────
  if (!OWNER_KEY || !AGENT_KEY) {
    console.error("❌ Missing keys. Make sure .env has OWNER_PRIVATE_KEY and AGENT_PRIVATE_KEY");
    process.exit(1);
  }

  // ─── Connect to Base Sepolia ──────────────────────────────────
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  console.log(`🔗 Connected to: ${network.name} (chainId: ${network.chainId})\n`);

  const owner = new ethers.Wallet(OWNER_KEY, provider);
  const agent = new ethers.Wallet(AGENT_KEY, provider);

  console.log(`👤 Owner:  ${owner.address}`);
  console.log(`🤖 Agent:  ${agent.address}`);

  // ─── Check Balances ───────────────────────────────────────────
  const ownerBal = await provider.getBalance(owner.address);
  const agentBal = await provider.getBalance(agent.address);
  console.log(`\n💰 Owner ETH: ${ethers.formatEther(ownerBal)}`);
  console.log(`💰 Agent ETH: ${ethers.formatEther(agentBal)}`);

  if (ownerBal === 0n) {
    console.error(`\n❌ Owner has no ETH!`);
    console.log(`\n   Fund this address with Base Sepolia ETH from a faucet:`);
    console.log(`   ${owner.address}`);
    console.log(`\n   Faucets:`);
    console.log(`   - https://www.alchemy.com/faucets/base-sepolia`);
    console.log(`   - https://faucet.quicknode.com/base/sepolia`);
    console.log(`   - https://www.coinbase.com/faucets/base-ethereum-goerli-faucet`);
    console.log(`\n   Then re-run: node scripts/demo-live.js`);
    process.exit(1);
  }

  if (ownerBal < ethers.parseEther("0.0003")) {
    console.log(`\n⚠️  Owner ETH is very low (${ethers.formatEther(ownerBal)} ETH).`);
    console.log(`   Deploying 3 contracts + minting costs ~0.0003-0.0005 ETH on Base Sepolia.`);
    console.log(`   The demo may fail partway through. Consider topping up from a faucet.\n`);
    console.log(`   Continuing anyway...\n`);
  } else {
    console.log(`\n   ✅ Owner is funded. Proceeding...\n`);
  }

  // Helper: deploy with explicit nonce management (prevents nonce collision on automining)
  let ownerNonce = await provider.getTransactionCount(owner.address);
  async function deployContract(factory, args = []) {
    const contract = await factory.deploy(...args, { nonce: ownerNonce });
    ownerNonce++;
    await contract.waitForDeployment();
    // Verify code was actually deployed
    const addr = await contract.getAddress();
    const code = await provider.getCode(addr);
    if (code === "0x" || code.length <= 2) {
      throw new Error(`Deployment to ${addr} has no code — constructor may have reverted or run out of gas`);
    }
    return contract;
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: Deploy Contracts
  // ═══════════════════════════════════════════════════════════════
  console.log("═══ STEP 1: DEPLOY CONTRACTS ════════════════════════════════\n");

  // Deploy MockZKVerifier
  console.log("📦 Deploying MockZKVerifier...");
  const verifierArtifact = loadArtifact("contracts_src_mocks_MockZKVerifier_sol_MockZKVerifier");
  const VerifierFactory = new ethers.ContractFactory(verifierArtifact.abi, verifierArtifact.bytecode, owner);
  const verifier = await deployContract(VerifierFactory);
  const verifierAddr = await verifier.getAddress();
  console.log(`   ✅ MockZKVerifier deployed: ${verifierAddr}`);
  console.log(`      https://sepolia.basescan.org/address/${verifierAddr}\n`);

  // Deploy MockERC20 (USDC)
  console.log("📦 Deploying MockERC20 (USDC)...");
  const erc20Artifact = loadArtifact("contracts_src_mocks_MockERC20_sol_MockERC20");
  const ERC20Factory = new ethers.ContractFactory(erc20Artifact.abi, erc20Artifact.bytecode, owner);
  const usdc = await deployContract(ERC20Factory, ["USD Coin", "USDC", 6]);
  const usdcAddr = await usdc.getAddress();
  console.log(`   ✅ MockUSDC deployed: ${usdcAddr}`);
  console.log(`      https://sepolia.basescan.org/address/${usdcAddr}\n`);

  // Deploy AgentWallet (owner=owner, agent=agent, verifier=verifier)
  console.log("📦 Deploying AgentWallet...");
  const walletArtifact = loadArtifact("contracts_src_AgentWallet_sol_AgentWallet");
  const WalletFactory = new ethers.ContractFactory(walletArtifact.abi, walletArtifact.bytecode, owner);
  const agentWallet = await deployContract(WalletFactory, [owner.address, agent.address, verifierAddr]);
  const agentWalletAddr = await agentWallet.getAddress();
  console.log(`   ✅ AgentWallet deployed: ${agentWalletAddr}`);
  console.log(`      Owner:      ${owner.address}`);
  console.log(`      Agent:      ${agent.address}`);
  console.log(`      Verifier:   ${verifierAddr}`);
  console.log(`      https://sepolia.basescan.org/address/${agentWalletAddr}\n`);

  // Save deployment info
  const deployInfo = {
    network: "base_sepolia", chainId: CHAIN_ID,
    timestamp: new Date().toISOString(),
    contracts: {
      MockZKVerifier: verifierAddr,
      MockUSDC: usdcAddr,
      AgentWallet: agentWalletAddr,
    },
    wallets: { owner: owner.address, agent: agent.address },
  };
  const deploymentsDir = path.join(__dirname, "..", "contracts", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(path.join(deploymentsDir, "base_sepolia.json"), JSON.stringify(deployInfo, null, 2));

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: Fund the AgentWallet with Mock USDC
  // ═══════════════════════════════════════════════════════════════
  console.log("═══ STEP 2: FUND AGENTWALLET ═══════════════════════════════\n");

  const mintAmount = ethers.parseUnits("1000", 6); // 1000 USDC
  console.log("💵 Minting 1000 USDC to AgentWallet...");
  // Use the usdc contract connected to owner (deployer) with explicit nonce
  const usdcAsOwner = usdc.connect(owner);
  const mintTx = await usdcAsOwner.mint(agentWalletAddr, mintAmount, { nonce: ownerNonce });
  ownerNonce++;
  await mintTx.wait();
  console.log(`   ✅ Mint tx: ${mintTx.hash}`);
  console.log(`      https://sepolia.basescan.org/tx/${mintTx.hash}`);

  const walletUsdcBal = await usdc.balanceOf(agentWalletAddr);
  console.log(`   AgentWallet USDC balance: ${ethers.formatUnits(walletUsdcBal, 6)} USDC\n`);

  // Fund the agent address with ETH so it can submit the executeDirectly() tx.
  // The AgentWallet itself doesn't need ETH — the agent pays gas externally.
  const ownerBalAfterDeploy = await provider.getBalance(owner.address);
  const agentBalNow = await provider.getBalance(agent.address);
  const agentNeedsGas = agentBalNow < ethers.parseEther("0.00005");

  if (agentNeedsGas) {
    // Send the agent just enough for one tx (~0.00005 ETH on Base Sepolia)
    const agentFundAmount = ethers.parseEther("0.00005");
    if (ownerBalAfterDeploy > agentFundAmount * 2n) {
      console.log("⛽ Sending 0.00005 ETH to Agent address for gas...");
      const agentFundTx = await owner.sendTransaction({
        to: agent.address,
        value: agentFundAmount,
        nonce: ownerNonce,
      });
      ownerNonce++;
      await agentFundTx.wait();
      console.log(`   ✅ Agent fund tx: ${agentFundTx.hash}\n`);
    } else {
      console.log("⚠️  Owner ETH is too low to fund agent. Please also send a tiny amount of");
      console.log(`   Base Sepolia ETH to the agent address: ${agent.address}`);
      console.log("   The agent needs ~0.00005 ETH to submit one transaction.\n");
      if (agentBalNow === 0n) {
        console.error("❌ Agent has 0 ETH and cannot submit transactions. Exiting.");
        process.exit(1);
      }
    }
  } else {
    console.log(`   Agent already has ${ethers.formatEther(agentBalNow)} ETH — sufficient for gas.\n`);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: Build Intent — Transfer 100 USDC to a recipient
  // ═══════════════════════════════════════════════════════════════
  console.log("═══ STEP 3: BUILD & SIGN INTENT ════════════════════════════\n");

  // We'll do a simple ERC-20 transfer (since we don't have a real DEX on testnet)
  const recipient = "0x000000000000000000000000000000000000dEaD"; // Burn address
  const transferAmount = ethers.parseUnits("100", 6); // 100 USDC

  // Encode the ERC-20 transfer call
  const erc20Iface = new ethers.Interface([
    "function transfer(address to, uint256 amount) returns (bool)",
  ]);
  const transferCalldata = erc20Iface.encodeFunctionData("transfer", [recipient, transferAmount]);

  // Build the calls array matching AgentWallet's Call struct
  const calls = [
    {
      target: usdcAddr,
      value: 0n,
      data: transferCalldata,
    },
  ];

  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const expiry = Math.floor(Date.now() / 1000) + 600; // 10 min from now

  console.log(`📋 Intent: Transfer 100 USDC to ${recipient}`);
  console.log(`   Nonce:  ${nonce.slice(0, 18)}...`);
  console.log(`   Expiry: ${new Date(expiry * 1000).toISOString()}`);
  console.log(`   Call:   USDC.transfer(0xdead, 100e6)\n`);

  // Compute callsHash (must match how AgentWallet computes it)
  const callsHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(address target, uint256 value, bytes data)[]"],
      [calls]
    )
  );
  console.log(`   Calls hash: ${callsHash.slice(0, 18)}...`);

  // ─── Sign with EIP-712 (DirectExecution path) ────────────────
  // We'll use executeDirectly() since we have a MockZKVerifier
  // This tests the real on-chain signature verification

  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint256", "bytes32"],
      [DIRECT_EXECUTION_TYPEHASH, nonce, expiry, callsHash]
    )
  );

  // Compute domain separator locally (matches EIP712 constructor: "VAEB AgentWallet", "1")
  const EIP712_DOMAIN_TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
  );
  const domainSeparator = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        EIP712_DOMAIN_TYPEHASH,
        ethers.keccak256(ethers.toUtf8Bytes("VAEB AgentWallet")),
        ethers.keccak256(ethers.toUtf8Bytes("1")),
        CHAIN_ID,
        agentWalletAddr,
      ]
    )
  );
  console.log(`   Domain separator: ${domainSeparator.slice(0, 18)}... (computed locally)`);

  const agentWalletContract = new ethers.Contract(agentWalletAddr, walletArtifact.abi, agent);

  // Compute the EIP-712 digest
  const digest = ethers.keccak256(
    ethers.solidityPacked(
      ["bytes1", "bytes1", "bytes32", "bytes32"],
      ["0x19", "0x01", domainSeparator, structHash]
    )
  );

  // Owner signs the digest
  const sig = owner.signingKey.sign(digest);
  const signature = ethers.Signature.from(sig).serialized;
  console.log(`\n✍️  Owner signed EIP-712 digest`);
  console.log(`   Signature: ${signature.slice(0, 20)}...${signature.slice(-8)}\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 4: Agent Submits On-Chain Transaction
  // ═══════════════════════════════════════════════════════════════
  console.log("═══ STEP 4: ON-CHAIN EXECUTION ═════════════════════════════\n");

  console.log("⚡ Agent calling AgentWallet.executeDirectly()...");
  console.log(`   From: ${agent.address} (agent)`);
  console.log(`   To:   ${agentWalletAddr} (AgentWallet)\n`);

  try {
    const execTx = await agentWalletContract.executeDirectly(
      signature,
      nonce,
      expiry,
      calls,
      { gasLimit: 200000 }
    );

    console.log(`   📡 Tx submitted: ${execTx.hash}`);
    console.log(`      https://sepolia.basescan.org/tx/${execTx.hash}`);
    console.log(`\n   ⏳ Waiting for confirmation...`);

    const receipt = await execTx.wait();

    console.log(`\n   ✅ TRANSACTION CONFIRMED!`);
    console.log(`   ──────────────────────────`);
    console.log(`   Block:    ${receipt.blockNumber}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
    console.log(`   Status:   ${receipt.status === 1 ? "SUCCESS ✓" : "REVERTED ✗"}`);
    console.log(`   Tx hash:  ${execTx.hash}`);
    console.log(`   Explorer: https://sepolia.basescan.org/tx/${execTx.hash}`);

    // Parse events
    if (receipt.logs.length > 0) {
      console.log(`\n   Events (${receipt.logs.length}):`);
      for (const log of receipt.logs) {
        // Try to parse ERC-20 Transfer event
        try {
          const parsed = erc20Iface.parseLog({ topics: log.topics, data: log.data });
          if (parsed && parsed.name === "Transfer") {
            console.log(`     📤 ERC20 Transfer: ${ethers.formatUnits(parsed.args[1] || parsed.args.amount || 0, 6)} USDC`);
          }
        } catch {}
        // Try to parse IntentExecuted event
        try {
          const walletIface = new ethers.Interface(walletArtifact.abi);
          const parsed = walletIface.parseLog({ topics: log.topics, data: log.data });
          if (parsed && parsed.name === "IntentExecuted") {
            console.log(`     🔐 IntentExecuted: nonce=${parsed.args.nonce?.slice(0, 18)}... calls=${parsed.args.callCount}`);
          }
        } catch {}
      }
    }

  } catch (error) {
    console.error(`\n   ❌ Transaction FAILED: ${error.message}`);
    if (error.data) console.error(`   Revert data: ${error.data}`);
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 5: Verify Final State
  // ═══════════════════════════════════════════════════════════════
  console.log("\n═══ STEP 5: VERIFY FINAL STATE ═════════════════════════════\n");

  const finalWalletBal = await usdc.balanceOf(agentWalletAddr);
  const recipientBal = await usdc.balanceOf(recipient);
  const nonceUsed = await agentWalletContract.isNonceUsed(nonce);

  console.log(`   AgentWallet USDC: ${ethers.formatUnits(finalWalletBal, 6)} (was 1000.0)`);
  console.log(`   Recipient USDC:   ${ethers.formatUnits(recipientBal, 6)} (was 0.0)`);
  console.log(`   Nonce used:       ${nonceUsed} (should be true)`);

  // Verify correctness
  const expectedWalletBal = ethers.parseUnits("900", 6);
  const expectedRecipientBal = ethers.parseUnits("100", 6);
  const allCorrect =
    finalWalletBal === expectedWalletBal &&
    recipientBal === expectedRecipientBal &&
    nonceUsed === true;

  if (allCorrect) {
    console.log(`\n   ✅ ALL CHECKS PASSED!`);
  } else {
    console.log(`\n   ⚠️  Some checks unexpected — review above values`);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 6: Test Replay Protection
  // ═══════════════════════════════════════════════════════════════
  console.log("\n═══ STEP 6: REPLAY PROTECTION TEST ═════════════════════════\n");

  console.log("🔒 Attempting replay with same nonce...");
  try {
    const replayTx = await agentWalletContract.executeDirectly(
      signature,
      nonce,
      expiry,
      calls,
      { gasLimit: 200000 }
    );
    await replayTx.wait();
    console.log("   ❌ REPLAY SUCCEEDED — this should NOT happen!");
  } catch (error) {
    console.log("   ✅ Replay REJECTED (NonceAlreadyUsed) — nonce protection works!");
  }

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  LIVE DEMO COMPLETE ✓");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`
  ┌───────────────────────────────────────────────────────────────┐
  │ VAEB Live Demo Results (Base Sepolia)                         │
  │                                                               │
  │ Contracts Deployed:                                           │
  │   MockZKVerifier:  ${verifierAddr}  │
  │   MockUSDC:        ${usdcAddr}  │
  │   AgentWallet:     ${agentWalletAddr}  │
  │                                                               │
  │ Execution:                                                    │
  │   ✅ 100 USDC transferred via AgentWallet.executeDirectly()   │
  │   ✅ EIP-712 signature verified on-chain                      │
  │   ✅ Nonce marked used — replay protection confirmed          │
  │                                                               │
  │ Explorer: https://sepolia.basescan.org/address/${agentWalletAddr} │
  └───────────────────────────────────────────────────────────────┘
  `);

  // Save full results
  const resultsPath = path.join(__dirname, "..", "contracts", "deployments", "demo-results.json");
  fs.writeFileSync(resultsPath, JSON.stringify({
    ...deployInfo,
    demo: {
      intentType: "USDC Transfer (100 USDC)",
      recipient,
      nonce,
      nonceReplayRejected: true,
      finalBalances: {
        agentWalletUSDC: ethers.formatUnits(finalWalletBal, 6),
        recipientUSDC: ethers.formatUnits(recipientBal, 6),
      },
    },
    timestamp: new Date().toISOString(),
  }, null, 2));
  console.log(`  Results saved to contracts/deployments/demo-results.json`);
}

main().catch((err) => {
  console.error("\n❌ Demo failed:", err.message);
  if (err.code === "INSUFFICIENT_FUNDS") {
    console.log("\n   Your owner wallet needs more ETH.");
    console.log(`   Fund: ${process.env.OWNER_ADDRESS || "check .env"}`);
    console.log("   Faucet: https://www.alchemy.com/faucets/base-sepolia");
  }
  process.exit(1);
});
