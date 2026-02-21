/**
 * VAEB Intent SDK — IntentBundle Construction & Signing
 *
 * Core functions for creating, signing, and serializing IntentBundles
 * per the ERC-8150 specification.
 */

import { ethers } from "ethers";
import {
  IntentBundle,
  ActionEntry,
  ActionType,
  CreateIntentParams,
  ActionInput,
  DerivedCalldata,
  DerivedCall,
} from "./types";
import {
  CHAINS,
  EIP712_DOMAIN_TYPE,
  EIP712_TYPES,
  DEFAULTS,
  UNISWAP_V3_SELECTORS,
  ERC20_SELECTORS,
} from "./constants";

// ─── Nonce Generation ───────────────────────────────────────────

/**
 * Generate a cryptographically random bytes32 nonce
 */
export function generateNonce(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

// ─── Expiry Calculation ─────────────────────────────────────────

/**
 * Calculate expiry timestamp from current time + minutes
 */
export function calculateExpiry(minutes: number = DEFAULTS.EXPIRY_MINUTES): number {
  return Math.floor(Date.now() / 1000) + minutes * 60;
}

// ─── IntentBundle Construction ──────────────────────────────────

/**
 * Create an IntentBundle from high-level action inputs.
 * This is the main entry point for intent creation.
 */
export function createIntentBundle(params: CreateIntentParams): IntentBundle {
  const chainConfig = Object.values(CHAINS).find(
    (c) => c.chainId === params.chainId
  );

  if (!chainConfig) {
    throw new Error(`Unsupported chainId: ${params.chainId}`);
  }

  const actions: ActionEntry[] = params.actions.map((input) =>
    resolveAction(input, chainConfig.tokens)
  );

  return {
    version: DEFAULTS.INTENT_VERSION,
    chainId: params.chainId,
    nonce: generateNonce(),
    expiry: calculateExpiry(params.expiryMinutes),
    payer: ethers.getAddress(params.walletAddress),
    actions,
  };
}

/**
 * Resolve a high-level ActionInput into a concrete ActionEntry
 */
function resolveAction(
  input: ActionInput,
  tokens: Record<string, string>
): ActionEntry {
  switch (input.type) {
    case ActionType.SWAP:
      return resolveSwapAction(input, tokens);
    case ActionType.TRANSFER:
      return resolveTransferAction(input, tokens);
    case ActionType.STAKE:
    case ActionType.UNSTAKE:
    case ActionType.APPROVE:
    case ActionType.LEND:
    case ActionType.BORROW:
      return resolveGenericAction(input, tokens);
    default:
      throw new Error(`Unsupported action type: ${input.type}`);
  }
}

function resolveSwapAction(
  input: ActionInput,
  tokens: Record<string, string>
): ActionEntry {
  const fromToken = input.fromToken || input.token;
  if (!fromToken) throw new Error("SWAP requires fromToken");

  const tokenAddress = tokens[fromToken.toUpperCase()] || fromToken;
  const amount = parseTokenAmount(input.amount, fromToken);

  return {
    actionType: ActionType.SWAP,
    token: tokenAddress,
    to: tokens[input.toToken?.toUpperCase() || ""] || input.toToken || ethers.ZeroAddress,
    amount,
  };
}

function resolveTransferAction(
  input: ActionInput,
  tokens: Record<string, string>
): ActionEntry {
  const tokenName = input.token || input.fromToken;
  if (!tokenName) throw new Error("TRANSFER requires token");
  if (!input.recipient) throw new Error("TRANSFER requires recipient");

  const tokenAddress = tokens[tokenName.toUpperCase()] || tokenName;
  const amount = parseTokenAmount(input.amount, tokenName);

  return {
    actionType: ActionType.TRANSFER,
    token: tokenAddress,
    to: input.recipient,
    amount,
  };
}

function resolveGenericAction(
  input: ActionInput,
  tokens: Record<string, string>
): ActionEntry {
  const tokenName = input.token || input.fromToken;
  if (!tokenName) throw new Error(`${input.type} requires token`);

  const tokenAddress = tokens[tokenName.toUpperCase()] || tokenName;
  const amount = parseTokenAmount(input.amount, tokenName);

  return {
    actionType: input.type,
    token: tokenAddress,
    to: input.recipient || input.protocol || ethers.ZeroAddress,
    amount,
  };
}

// ─── Token Amount Parsing ───────────────────────────────────────

/**
 * Parse human-readable token amount to smallest unit.
 * Defaults to 18 decimals, 6 for stablecoins.
 */
function parseTokenAmount(amount: number | string, tokenSymbol: string): bigint {
  const decimals = getTokenDecimals(tokenSymbol);
  const amountStr = typeof amount === "number" ? amount.toString() : amount;
  return ethers.parseUnits(amountStr, decimals);
}

function getTokenDecimals(token: string): number {
  const upper = token.toUpperCase();
  if (["USDC", "USDT", "DAI"].includes(upper)) return 6;
  if (upper === "WBTC") return 8;
  return 18; // ETH, WETH, and most ERC-20s
}

// ─── EIP-712 Signing ────────────────────────────────────────────

/**
 * Construct the EIP-712 typed data for signing an IntentBundle
 */
export function getEIP712TypedData(
  bundle: IntentBundle,
  verifyingContract: string
) {
  return {
    domain: {
      name: EIP712_DOMAIN_TYPE.name,
      version: EIP712_DOMAIN_TYPE.version,
      chainId: bundle.chainId,
      verifyingContract: ethers.getAddress(verifyingContract),
    },
    types: EIP712_TYPES,
    primaryType: "IntentBundle" as const,
    message: {
      version: bundle.version,
      chainId: BigInt(bundle.chainId),
      nonce: bundle.nonce,
      expiry: BigInt(bundle.expiry),
      payer: bundle.payer,
      actions: bundle.actions.map((a) => ({
        actionType: a.actionType,
        token: a.token,
        to: a.to,
        amount: a.amount,
      })),
    },
  };
}

/**
 * Sign an IntentBundle using EIP-712 typed data signing
 */
export async function signIntentBundle(
  bundle: IntentBundle,
  signer: ethers.Signer,
  agentWalletAddress: string
): Promise<string> {
  const typedData = getEIP712TypedData(bundle, agentWalletAddress);

  // Use ethers v6 signTypedData
  if ("signTypedData" in signer) {
    return (signer as ethers.Signer & { signTypedData: Function }).signTypedData(
      typedData.domain,
      {
        IntentBundle: [...EIP712_TYPES.IntentBundle],
        ActionEntry: [...EIP712_TYPES.ActionEntry],
      },
      typedData.message
    );
  }

  throw new Error("Signer does not support signTypedData");
}

// ─── Intent ID Computation ──────────────────────────────────────

/**
 * Compute the unique intent ID (keccak256 of serialized bundle)
 */
export function computeIntentId(bundle: IntentBundle): string {
  const encoded = serializeBundle(bundle);
  return ethers.keccak256(encoded);
}

// ─── Serialization ──────────────────────────────────────────────

/**
 * Serialize IntentBundle to ABI-encoded bytes
 */
export function serializeBundle(bundle: IntentBundle): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  const actionsEncoded = bundle.actions.map((a) =>
    abiCoder.encode(
      ["string", "address", "address", "uint256"],
      [a.actionType, a.token, a.to, a.amount]
    )
  );

  return abiCoder.encode(
    ["string", "uint256", "bytes32", "uint256", "address", "bytes[]"],
    [
      bundle.version,
      bundle.chainId,
      bundle.nonce,
      bundle.expiry,
      bundle.payer,
      actionsEncoded,
    ]
  );
}

/**
 * Deserialize ABI-encoded bytes back into an IntentBundle
 */
export function deserializeBundle(data: string): IntentBundle {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  const [version, chainId, nonce, expiry, payer, actionsEncoded] =
    abiCoder.decode(
      ["string", "uint256", "bytes32", "uint256", "address", "bytes[]"],
      data
    );

  const actions: ActionEntry[] = (actionsEncoded as string[]).map((encoded: string) => {
    const [actionType, token, to, amount] = abiCoder.decode(
      ["string", "address", "address", "uint256"],
      encoded
    );
    return {
      actionType: actionType as ActionType,
      token,
      to,
      amount,
    };
  });

  return {
    version,
    chainId: Number(chainId),
    nonce,
    expiry: Number(expiry),
    payer,
    actions,
  };
}

/**
 * Convert IntentBundle to JSON-safe format (bigints as strings)
 */
export function bundleToJSON(bundle: IntentBundle): object {
  return {
    ...bundle,
    actions: bundle.actions.map((a) => ({
      ...a,
      amount: a.amount.toString(),
    })),
  };
}

/**
 * Parse JSON back into IntentBundle (strings back to bigints)
 */
export function bundleFromJSON(json: any): IntentBundle {
  return {
    ...json,
    actions: json.actions.map((a: any) => ({
      ...a,
      amount: BigInt(a.amount),
    })),
  };
}

// ─── Calldata Derivation ────────────────────────────────────────

/**
 * Derive the actual on-chain calldata from an IntentBundle.
 * This converts high-level intents into concrete EVM calls.
 */
export async function deriveCalldata(
  bundle: IntentBundle,
  chainKey: string
): Promise<DerivedCalldata> {
  const chainConfig = CHAINS[chainKey];
  if (!chainConfig) throw new Error(`Unknown chain: ${chainKey}`);

  const calls: DerivedCall[] = [];

  for (const action of bundle.actions) {
    switch (action.actionType) {
      case ActionType.TRANSFER:
        calls.push(deriveTransferCall(action));
        break;

      case ActionType.SWAP:
        calls.push(...deriveSwapCalls(action, chainConfig));
        break;

      case ActionType.APPROVE:
        calls.push(deriveApproveCall(action));
        break;

      default:
        // For other action types, generate a placeholder
        calls.push({
          target: action.to,
          value: 0n,
          data: "0x",
        });
    }
  }

  const intentId = computeIntentId(bundle);
  const multicallDataHash = await computeMulticallHash(calls);

  return {
    intentId,
    chainId: bundle.chainId,
    calls,
    multicallDataHash,
  };
}

function deriveTransferCall(action: ActionEntry): DerivedCall {
  const iface = new ethers.Interface([
    "function transfer(address to, uint256 amount) returns (bool)",
  ]);

  return {
    target: action.token,
    value: 0n,
    data: iface.encodeFunctionData("transfer", [action.to, action.amount]),
  };
}

function deriveSwapCalls(
  action: ActionEntry,
  chainConfig: any
): DerivedCall[] {
  const calls: DerivedCall[] = [];
  const routerAddress =
    chainConfig.dexRouters.uniswap_v3 || Object.values(chainConfig.dexRouters)[0];

  if (!routerAddress) {
    throw new Error(`No DEX router configured for chain ${chainConfig.name}`);
  }

  // Step 1: Approve the router to spend tokens
  const approveIface = new ethers.Interface([
    "function approve(address spender, uint256 amount) returns (bool)",
  ]);
  calls.push({
    target: action.token,
    value: 0n,
    data: approveIface.encodeFunctionData("approve", [
      routerAddress,
      action.amount,
    ]),
  });

  // Step 2: Execute the swap via Uniswap V3 exactInputSingle
  const swapIface = new ethers.Interface([
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
  ]);

  // Calculate minimum output with 0.5% default slippage
  // In production, this would query on-chain price oracles
  const amountOutMinimum = (action.amount * 995n) / 1000n;

  calls.push({
    target: routerAddress as string,
    value: 0n,
    data: swapIface.encodeFunctionData("exactInputSingle", [
      {
        tokenIn: action.token,
        tokenOut: action.to,
        fee: 3000, // 0.3% pool fee
        recipient: "0x0000000000000000000000000000000000000000", // Will be replaced with AgentWallet
        deadline: Math.floor(Date.now() / 1000) + 600,
        amountIn: action.amount,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ]),
  });

  return calls;
}

function deriveApproveCall(action: ActionEntry): DerivedCall {
  const iface = new ethers.Interface([
    "function approve(address spender, uint256 amount) returns (bool)",
  ]);

  return {
    target: action.token,
    value: 0n,
    data: iface.encodeFunctionData("approve", [action.to, action.amount]),
  };
}

// compute multicallDataHash using Poseidon
async function computeMulticallHash(calls: DerivedCall[]): Promise<bigint> {
  const circomlibjs = await import("circomlibjs");
  const poseidon = await circomlibjs.buildPoseidon();
  const F = poseidon.F;

  const poseidonHash = (inputs: bigint[]): bigint => {
    return F.toObject(poseidon(inputs));
  };

  const MAX_CALLS = 8; // MAX_ACTIONS * 2
  const paddingCallHash = poseidonHash([0n, 0n, 0n]);
  const singleCallHashes: bigint[] = [];

  for (let i = 0; i < MAX_CALLS; i++) {
    if (i < calls.length) {
      const call = calls[i];
      // Poseidon(target, value, keccak256(data))
      const dataHash = BigInt(ethers.keccak256(call.data));
      const callHash = poseidonHash([
        BigInt(call.target),
        BigInt(call.value),
        dataHash,
      ]);
      singleCallHashes.push(callHash);
    } else {
      singleCallHashes.push(paddingCallHash);
    }
  }

  // Final multicall hash: Poseidon(singleCallHash[0], ..., singleCallHash[7])
  const multicallHash = poseidonHash(singleCallHashes);

  // Return raw bigint (caller decides format: .toString() for prover, toHex() for contract)
  return multicallHash;
}

// ─── Human-Readable Intent Description ──────────────────────────

/**
 * Generate a human-readable description of an IntentBundle
 */
export function describeIntent(bundle: IntentBundle): string {
  const chainConfig = Object.values(CHAINS).find(
    (c) => c.chainId === bundle.chainId
  );
  const chainName = chainConfig?.name || `Chain ${bundle.chainId}`;

  const actionDescs = bundle.actions.map((a) => {
    const tokenSymbol = resolveTokenSymbol(a.token, chainConfig);
    const toSymbol = resolveTokenSymbol(a.to, chainConfig);
    const amount = formatTokenAmount(a.amount, tokenSymbol);

    switch (a.actionType) {
      case ActionType.SWAP:
        return `Swap ${amount} ${tokenSymbol} → ${toSymbol}`;
      case ActionType.TRANSFER:
        return `Transfer ${amount} ${tokenSymbol} to ${shortenAddress(a.to)}`;
      case ActionType.STAKE:
        return `Stake ${amount} ${tokenSymbol}`;
      case ActionType.APPROVE:
        return `Approve ${amount} ${tokenSymbol} for ${shortenAddress(a.to)}`;
      default:
        return `${a.actionType} ${amount} ${tokenSymbol}`;
    }
  });

  return `${actionDescs.join(", ")} on ${chainName}`;
}

function resolveTokenSymbol(
  address: string,
  chainConfig: any
): string {
  if (!chainConfig) return shortenAddress(address);
  for (const [symbol, addr] of Object.entries(chainConfig.tokens)) {
    if ((addr as string).toLowerCase() === address.toLowerCase()) return symbol;
  }
  return shortenAddress(address);
}

function formatTokenAmount(amount: bigint, symbol: string): string {
  const upper = symbol.toUpperCase();
  const decimals =
    ["USDC", "USDT", "DAI"].includes(upper) ? 6 : upper === "WBTC" ? 8 : 18;
  return ethers.formatUnits(amount, decimals);
}

function shortenAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
