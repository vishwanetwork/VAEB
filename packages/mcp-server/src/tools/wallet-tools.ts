/**
 * Wallet Tools — AgentWallet lifecycle via AgentWalletFactory
 *
 *   create_wallet   — Deploy a new AgentWallet for a user (owner → their MetaMask address)
 *   predict_wallet  — Preview the CREATE2 address before deployment (read-only, free)
 *   get_wallets     — List all AgentWallets owned by an address (read-only, free)
 *
 * The agent EOA (derived from AGENT_PRIVATE_KEY) signs and submits createWallet() txs.
 * The factory uses CREATE2 so the address is predictable before deployment.
 */

import { ethers } from "ethers";
import { CHAINS } from "@vaeb/intent-sdk";

type Config = {
  defaultChain: string;
  walletPrivateKey: string;
  agentAddress?: string;   // fallback when private key is unavailable (e.g. read-only ops)
  rpcUrl?: string;
  contracts?: {
    AgentWalletFactory?: string;
  };
};

// ─── Factory ABI ─────────────────────────────────────────────────

const FACTORY_ABI = [
  "function createWallet(address owner, address agent, bytes32 salt) returns (address wallet)",
  "function predictWalletAddress(address owner, address agent, bytes32 salt) view returns (address predicted)",
  "function getWallets(address owner) view returns (address[])",
  "function isWallet(address) view returns (bool)",
  "function walletCount(address owner) view returns (uint256)",
  "function defaultZkVerifier() view returns (address)",
  "event WalletCreated(address indexed wallet, address indexed owner, address indexed agent, bytes32 salt)",
];

// ─── Tool handlers ────────────────────────────────────────────────

export const walletTools = {
  async handle(name: string, args: any, config: Config): Promise<any> {
    switch (name) {
      case "create_wallet":
        return createWallet(args, config);
      case "predict_wallet":
        return predictWallet(args, config);
      case "get_wallets":
        return getWallets(args, config);
      default:
        throw new Error(`Unknown wallet tool: ${name}`);
    }
  },
};

// ─── Helpers ─────────────────────────────────────────────────────

function getFactoryAddress(config: Config): string {
  const addr = config.contracts?.AgentWalletFactory;
  if (!addr) throw new Error("AgentWalletFactory address not configured (check deployments.json)");
  return addr;
}

function getAgentEOA(config: Config): string {
  if (config.walletPrivateKey) return new ethers.Wallet(config.walletPrivateKey).address;
  if (config.agentAddress) return config.agentAddress;
  throw new Error("Cannot determine agent EOA: set AGENT_PRIVATE_KEY or agentAddress in config");
}

function buildSalt(owner: string, index: number | string = 0): string {
  // Deterministic: keccak256(owner + index). Different index = different wallet address.
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [owner, index])
  );
}

function getProvider(config: Config): ethers.JsonRpcProvider {
  const chainKey = config.defaultChain || "base_sepolia";
  const rpcUrl = config.rpcUrl || CHAINS[chainKey]?.rpcUrl || "https://sepolia.base.org";
  return new ethers.JsonRpcProvider(rpcUrl);
}

function getChainExplorer(config: Config): string {
  const chainKey = config.defaultChain || "base_sepolia";
  return CHAINS[chainKey]?.blockExplorer || "https://sepolia.basescan.org";
}

// ─── create_wallet ────────────────────────────────────────────────

async function createWallet(args: any, config: Config) {
  const ownerAddress: string = args.owner;
  if (!ethers.isAddress(ownerAddress)) throw new Error(`Invalid owner address: ${ownerAddress}`);

  const factoryAddress = getFactoryAddress(config);
  const agentEOA       = getAgentEOA(config);
  const saltIndex      = args.salt_index ?? 0;
  const salt           = buildSalt(ownerAddress, saltIndex);

  const provider   = getProvider(config);
  const agentWallet = new ethers.Wallet(config.walletPrivateKey, provider);
  const factory    = new ethers.Contract(factoryAddress, FACTORY_ABI, agentWallet);
  const explorer   = getChainExplorer(config);

  // Check if this salt is already deployed
  const predicted  = await factory.predictWalletAddress(ownerAddress, agentEOA, salt);
  const alreadyDeployed = await factory.isWallet(predicted);
  if (alreadyDeployed) {
    throw new Error(
      `Wallet already exists at ${predicted} for owner=${ownerAddress} salt_index=${saltIndex}. ` +
      `Use a different salt_index to deploy an additional wallet.`
    );
  }

  // Submit transaction
  const tx = await factory.createWallet(ownerAddress, agentEOA, salt, {
    gasLimit: 500_000,
  });
  const receipt = await tx.wait();

  // Parse WalletCreated event
  const iface = new ethers.Interface(FACTORY_ABI);
  let walletAddress = predicted; // fallback
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "WalletCreated") {
        walletAddress = parsed.args.wallet;
        break;
      }
    } catch { /* skip unrelated logs */ }
  }

  return {
    wallet: walletAddress,
    owner: ownerAddress,
    agent: agentEOA,
    chain: config.defaultChain,
    salt_index: saltIndex,
    tx_hash: tx.hash,
    gas_used: receipt.gasUsed.toString(),
    block_explorer: `${explorer}/tx/${tx.hash}`,
    note: "AgentWallet deployed. Fund it with ETH for gas, then connect it to your intents.",
  };
}

// ─── predict_wallet ───────────────────────────────────────────────

async function predictWallet(args: any, config: Config) {
  const ownerAddress: string = args.owner;
  if (!ethers.isAddress(ownerAddress)) throw new Error(`Invalid owner address: ${ownerAddress}`);

  const factoryAddress = getFactoryAddress(config);
  const agentEOA       = getAgentEOA(config);
  const saltIndex      = args.salt_index ?? 0;
  const salt           = buildSalt(ownerAddress, saltIndex);

  const provider = getProvider(config);
  const factory  = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);

  const predicted     = await factory.predictWalletAddress(ownerAddress, agentEOA, salt);
  const alreadyExists = await factory.isWallet(predicted);

  return {
    predicted_address: predicted,
    owner: ownerAddress,
    agent: agentEOA,
    chain: config.defaultChain,
    salt_index: saltIndex,
    already_deployed: alreadyExists,
    note: alreadyExists
      ? "This wallet is already deployed — use get_wallets to list it."
      : "Call create_wallet with the same owner and salt_index to deploy at this address.",
  };
}

// ─── get_wallets ──────────────────────────────────────────────────

async function getWallets(args: any, config: Config) {
  const ownerAddress: string = args.owner;
  if (!ethers.isAddress(ownerAddress)) throw new Error(`Invalid owner address: ${ownerAddress}`);

  const factoryAddress = getFactoryAddress(config);
  const provider       = getProvider(config);
  const factory        = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  const explorer       = getChainExplorer(config);

  const wallets: string[] = await factory.getWallets(ownerAddress);

  return {
    owner: ownerAddress,
    chain: config.defaultChain,
    wallets: wallets.map((addr: string) => ({
      address: addr,
      block_explorer: `${explorer}/address/${addr}`,
    })),
    count: wallets.length,
    note: wallets.length === 0
      ? "No AgentWallets found for this owner. Call create_wallet to deploy one."
      : `${wallets.length} AgentWallet(s) found.`,
  };
}
