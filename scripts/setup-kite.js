#!/usr/bin/env node
/**
 * Fix Kite AI Testnet: Mint USDC to owner + approve AgentWallet
 *
 * The deploy-kite.js script mistakenly minted USDC to the AgentWallet
 * instead of the owner. This script fixes that by:
 *   1. Minting 1000 USDC to the owner
 *   2. Approving AgentWallet to spend owner's USDC (max uint256)
 *
 * Uses private key directly → eth_sendRawTransaction (works on all RPCs).
 *
 * Run:  node scripts/setup-kite.js
 */

require("dotenv").config();
const { ethers } = require("ethers");

const OWNER_KEY = process.env.OWNER_PRIVATE_KEY;
const RPC_URL = process.env.KITE_TESTNET_RPC_URL || "https://rpc-testnet.gokite.ai";

// Kite testnet contract addresses (from config)
const MOCK_USDC = process.env.KITE_MOCK_USDC_ADDRESS || "0xE6725aAf7E8495a5952B0b89b3D51BCC5aeF4D3a";
const AGENT_WALLET = process.env.KITE_AGENT_WALLET_ADDRESS || "0x517cbec020c79034cB7F3A2eeA843B17e3744cd3";

const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

async function main() {
  console.log("\n  VAEB — Kite AI Testnet Setup\n");

  if (!OWNER_KEY) {
    console.error("  Missing OWNER_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const owner = new ethers.Wallet(OWNER_KEY, provider);
  const usdc = new ethers.Contract(MOCK_USDC, ERC20_ABI, owner);

  console.log(`  Owner:        ${owner.address}`);
  console.log(`  MockUSDC:     ${MOCK_USDC}`);
  console.log(`  AgentWallet:  ${AGENT_WALLET}\n`);

  // Check current state
  const currentBalance = await usdc.balanceOf(owner.address);
  const currentAllowance = await usdc.allowance(owner.address, AGENT_WALLET);
  console.log(`  Current USDC balance:   ${ethers.formatUnits(currentBalance, 6)}`);
  console.log(`  Current allowance:      ${ethers.formatUnits(currentAllowance, 6)}\n`);

  let nonce = await provider.getTransactionCount(owner.address);

  // 1. Mint 1000 USDC to owner
  const mintAmount = ethers.parseUnits("1000", 6);
  if (currentBalance < mintAmount) {
    console.log("  Minting 1000 USDC to owner...");
    const mintTx = await usdc.mint(owner.address, mintAmount, { nonce });
    nonce++;
    await mintTx.wait();
    const newBal = await usdc.balanceOf(owner.address);
    console.log(`    Balance: ${ethers.formatUnits(newBal, 6)} USDC`);
  } else {
    console.log("  Owner already has sufficient USDC, skipping mint.");
  }

  // 2. Approve AgentWallet with max amount
  const MAX_UINT256 = ethers.MaxUint256;
  if (currentAllowance < mintAmount) {
    console.log("  Approving AgentWallet to spend owner's USDC (max)...");
    const approveTx = await usdc.approve(AGENT_WALLET, MAX_UINT256, { nonce });
    nonce++;
    await approveTx.wait();
    const newAllowance = await usdc.allowance(owner.address, AGENT_WALLET);
    console.log(`    Allowance: ${ethers.formatUnits(newAllowance, 6)} USDC`);
  } else {
    console.log("  Allowance already sufficient, skipping approve.");
  }

  console.log("\n  Done! Owner now has USDC and AgentWallet is approved.\n");
}

main().catch((err) => {
  console.error("\n  Setup failed:", err.message);
  process.exit(1);
});
