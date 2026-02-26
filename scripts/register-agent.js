#!/usr/bin/env node
/**
 * ERC-8004 Agent Registration Script
 *
 * Registers a VAEB agent in the IdentityRegistry on Base Sepolia.
 * Sets metadata: agentName, supportedChains, proofType, avgProofTime, x402Pricing.
 *
 * Usage:
 *   PRIVATE_KEY=0x... node scripts/register-agent.js
 */

const { ethers } = require("ethers");

// ERC-8004 IdentityRegistry ABI (minimal)
const IDENTITY_REGISTRY_ABI = [
  "function register(string tokenURI, tuple(string key, string value)[] metadata) returns (uint256)",
  "function getMetadata(uint256 agentId) view returns (tuple(string key, string value)[])",
  "function totalSupply() view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

// ERC-8004 addresses on Base Sepolia (from the spec)
const IDENTITY_REGISTRY = process.env.IDENTITY_REGISTRY || "0x7177000000000000000000000000000000000009A";

async function main() {
  console.log("🆔 ERC-8004 Agent Registration\n");

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  const privateKey = process.env.PRIVATE_KEY;

  if (!privateKey) {
    console.log("📋 Registration plan (dry-run):\n");
    console.log("  Registry:  IdentityRegistry on Base Sepolia");
    console.log("  TokenURI:  ipfs://Qm.../agent-card.json");
    console.log("  Metadata:");
    console.log('    agentName:       "VAEB-Prover-Base-01"');
    console.log('    supportedChains: "base,ethereum,arbitrum"');
    console.log('    proofType:       "groth16"');
    console.log('    avgProofTime:    "3200ms"');
    console.log('    x402Pricing:     "0.02 USDC per proof"');
    console.log("\n  Set PRIVATE_KEY to execute on-chain.");
    return;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  console.log(`  Registrant: ${signer.address}`);

  const registry = new ethers.Contract(IDENTITY_REGISTRY, IDENTITY_REGISTRY_ABI, signer);

  const tokenURI = "ipfs://QmVAEBAgentCard/agent-card.json";
  const metadata = [
    { key: "agentName", value: "VAEB-Prover-Base-01" },
    { key: "supportedChains", value: "base,ethereum,arbitrum" },
    { key: "proofType", value: "groth16" },
    { key: "avgProofTime", value: "3200ms" },
    { key: "x402Pricing", value: "0.02 USDC per proof" },
  ];

  console.log("\n  Registering agent...");

  try {
    const tx = await registry.register(tokenURI, metadata);
    console.log(`  Tx: ${tx.hash}`);
    const receipt = await tx.wait();

    // Find the Transfer event to get the agentId
    const transferEvent = receipt.logs.find(
      (log) => log.topics[0] === ethers.id("Transfer(address,address,uint256)")
    );

    if (transferEvent) {
      const agentId = parseInt(transferEvent.topics[3], 16);
      console.log(`\n  ✅ Agent registered! ID: ${agentId}`);
      console.log(`  Explorer: https://sepolia.basescan.org/tx/${tx.hash}`);
    }
  } catch (error) {
    console.error(`  ❌ Registration failed: ${error.message}`);
    console.log("\n  Note: Make sure the IdentityRegistry contract address is correct.");
    console.log("  The address may need to be updated from the ERC-8004 deployment.");
  }
}

main().catch(console.error);
