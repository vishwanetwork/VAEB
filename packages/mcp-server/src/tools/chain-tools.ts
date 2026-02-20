/**
 * Chain Tools — Free on-chain read operations
 *
 * These tools don't require x402 payment since they're read-only
 * RPC calls. They provide the agent with on-chain data needed to
 * make informed decisions before constructing intents.
 */

import { ethers } from "ethers";
import { CHAINS } from "@vaeb/intent-sdk";
import { ContractFactory, ProviderFactory, getContract, getProvider } from "./deps";

type Config = {
  defaultChain: string;
  supportedChains: string[];
  rpcUrl?: string;
  providerFactory?: ProviderFactory;
  contractFactory?: ContractFactory;
  contracts?: {
    AgentWallet?: string;
    MockUSDC?: string;
  };
};

// ─── ERC-20 ABI fragments ───────────────────────────────────────

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

// ─── Tool Handlers ──────────────────────────────────────────────

export const chainTools = {
  async handle(name: string, args: any, config: Config): Promise<any> {
    switch (name) {
      case "get_wallet_balance":
        return getWalletBalance(config);
      case "check_nonce":
        return checkNonce(args, config);
      case "read_balance":
        return readBalance(args, config);
      case "get_price":
        return getPrice(args, config);
      case "estimate_gas":
        return estimateGas(args, config);
      case "get_receipt":
        return getReceipt(args, config);
      default:
        throw new Error(`Unknown chain tool: ${name}`);
    }
  },
};

// ─── read_balance ───────────────────────────────────────────────

async function readBalance(args: any, config: Config) {
  const chainKey = args.chain || config.defaultChain;
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Unsupported chain: ${chainKey}`);

  const provider = getProvider(chainKey, undefined, config.providerFactory);
  const walletAddress = args.wallet;

  // Native ETH balance
  if (args.token.toUpperCase() === "ETH" || args.token === chain.tokens.ETH) {
    const balance = await provider.getBalance(walletAddress);
    return {
      balance: ethers.formatEther(balance),
      token: "ETH",
      chain: chainKey,
      raw: balance.toString(),
    };
  }

  // ERC-20 balance
  const tokenAddress = chain.tokens[args.token.toUpperCase()] || args.token;
  const contract = getContract(tokenAddress, ERC20_ABI, provider, config.contractFactory);

  try {
    const [balance, decimals, symbol] = await Promise.all([
      contract.balanceOf(walletAddress),
      contract.decimals(),
      contract.symbol(),
    ]);

    return {
      balance: ethers.formatUnits(balance, decimals),
      token: symbol,
      chain: chainKey,
      raw: balance.toString(),
      decimals: Number(decimals),
    };
  } catch (error: any) {
    return {
      error: `Failed to read balance: ${error.message}`,
      chain: chainKey,
      tokenAddress,
    };
  }
}

// ─── get_wallet_balance ─────────────────────────────────────────

const WALLET_ABI = ["function isNonceUsed(bytes32) view returns (bool)"];

async function getWalletBalance(config: Config) {
  const chainKey = config.defaultChain || "base_sepolia";
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Chain not found: ${chainKey}`);

  const walletAddress = config.contracts?.AgentWallet;
  if (!walletAddress) throw new Error("AgentWallet address not configured");

  const provider = getProvider(chainKey, config.rpcUrl, config.providerFactory);
  const ethBalance = await provider.getBalance(walletAddress);

  let usdcBalance = "N/A";
  const usdcAddress = config.contracts?.MockUSDC || chain.tokens.USDC;
  try {
    const erc20 = getContract(usdcAddress, ERC20_ABI, provider, config.contractFactory);
    const [bal, dec] = await Promise.all([erc20.balanceOf(walletAddress), erc20.decimals()]);
    usdcBalance = ethers.formatUnits(bal, dec);
  } catch {
    // token may not exist on this chain
  }

  const ethFloat = parseFloat(ethers.formatEther(ethBalance));
  return {
    agentWallet: walletAddress,
    chain: chainKey,
    eth: ethers.formatEther(ethBalance),
    usdc: usdcBalance,
    usdcToken: usdcAddress,
    sufficient_for_gas: ethFloat > 0.001,
    warning: ethFloat < 0.001 ? "ETH balance low — may not cover gas" : undefined,
  };
}

// ─── check_nonce ────────────────────────────────────────────────

async function checkNonce(args: any, config: Config) {
  const chainKey = config.defaultChain || "base_sepolia";
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Chain not found: ${chainKey}`);

  const walletAddress = config.contracts?.AgentWallet;
  if (!walletAddress) throw new Error("AgentWallet address not configured");

  const provider = getProvider(chainKey, config.rpcUrl, config.providerFactory);
  const wallet = getContract(walletAddress, WALLET_ABI, provider, config.contractFactory);
  const isUsed = await wallet.isNonceUsed(args.nonce);

  return {
    nonce: args.nonce,
    used: isUsed,
    safe_to_use: !isUsed,
    agentWallet: walletAddress,
    chain: chainKey,
    note: isUsed
      ? "Nonce already used — do not attempt execution"
      : "Nonce is fresh — safe to execute",
  };
}

// ─── get_price ──────────────────────────────────────────────────

async function getPrice(args: any, config: Config) {
  const pair = args.pair;
  const [baseToken, quoteToken] = pair.split("/");
  const chains = args.chains || config.supportedChains;

  const results: Record<string, any> = {};

  for (const chainKey of chains) {
    const chain = CHAINS[chainKey];
    if (!chain) continue;

    // For the hackathon demo, return simulated price data
    // In production, this would query on-chain price oracles or DEX pools
    const basePrice = getSimulatedPrice(baseToken, quoteToken);

    results[chainKey] = {
      price: basePrice,
      dex: "Uniswap V3",
      liquidity: getSimulatedLiquidity(chainKey),
      lastUpdated: new Date().toISOString(),
    };
  }

  return {
    pair,
    prices: results,
    bestPrice: Object.entries(results).sort(
      (a: any, b: any) => b[1].price - a[1].price
    )[0]?.[0],
  };
}

function getSimulatedPrice(base: string, quote: string): number {
  const prices: Record<string, number> = {
    ETH: 3245.50,
    WETH: 3245.50,
    USDC: 1.0,
    USDT: 1.0,
    WBTC: 97500.0,
    DAI: 1.0,
  };

  const basePrice = prices[base.toUpperCase()] || 1;
  const quotePrice = prices[quote.toUpperCase()] || 1;
  return basePrice / quotePrice;
}

function getSimulatedLiquidity(chain: string): string {
  const liquidity: Record<string, string> = {
    base_sepolia: "12M",
    base: "89M",
    ethereum_sepolia: "5M",
  };
  return liquidity[chain] || "1M";
}

// ─── estimate_gas ───────────────────────────────────────────────

async function estimateGas(args: any, config: Config) {
  const chainKey = args.chain || config.defaultChain;
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Unsupported chain: ${chainKey}`);

  // Estimated gas for common operations
  const gasEstimates: Record<string, number> = {
    swap: 250000,
    transfer: 65000,
    approve: 46000,
    stake: 150000,
    executeWithProof: 350000, // AgentWallet.executeWithProof()
  };

  const gasLimit = gasEstimates[args.operation] || 200000;

  try {
    const provider = getProvider(chainKey, undefined, config.providerFactory);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits("1", "gwei");
    const gasCostWei = gasPrice * BigInt(gasLimit);

    return {
      chain: chainKey,
      operation: args.operation,
      estimatedGas: gasLimit,
      gasCostETH: ethers.formatEther(gasCostWei),
      gasCostUSD: `$${(parseFloat(ethers.formatEther(gasCostWei)) * 3245.5).toFixed(4)}`,
      gasPrice: ethers.formatUnits(gasPrice, "gwei") + " gwei",
    };
  } catch {
    // Fallback if RPC is unavailable
    return {
      chain: chainKey,
      operation: args.operation,
      estimatedGas: gasLimit,
      gasCostETH: "~0.0005",
      gasCostUSD: chain.avgGasCost,
      note: "Estimated (RPC unavailable)",
    };
  }
}

// ─── get_receipt ────────────────────────────────────────────────

async function getReceipt(args: any, config: Config) {
  const chainKey = args.chain || config.defaultChain;
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Unsupported chain: ${chainKey}`);

  const provider = getProvider(chainKey, undefined, config.providerFactory);

  try {
    const receipt = await provider.getTransactionReceipt(args.tx_hash);

    if (!receipt) {
      return {
        confirmed: false,
        chain: chainKey,
        tx_hash: args.tx_hash,
        status: "pending",
      };
    }

    return {
      confirmed: true,
      chain: chainKey,
      tx_hash: args.tx_hash,
      block: receipt.blockNumber,
      status: receipt.status === 1 ? "success" : "reverted",
      gasUsed: receipt.gasUsed.toString(),
      events: receipt.logs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data.slice(0, 66) + "...",
      })),
      blockExplorer: `${chain.blockExplorer}/tx/${args.tx_hash}`,
    };
  } catch (error: any) {
    return {
      error: `Failed to get receipt: ${error.message}`,
      chain: chainKey,
      tx_hash: args.tx_hash,
    };
  }
}
