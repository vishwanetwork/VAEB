/**
 * Verify Tools — ZK proof generation and verification for ERC-8150
 *
 * These tools handle the ZK verification pipeline:
 *   - check_nonce:  Check if a nonce has been used on-chain
 *   - prove_intent: Generate a Groth16 ZK proof via prover service
 *   - verify_proof: Verify a proof off-chain via prover service
 */

import { ethers } from "ethers";
import type { MCPConfig } from "../handlers";
import { getContract, getProvider } from "./deps";

const WALLET_ABI = [
  "function isNonceUsed(bytes32 nonce) view returns (bool)",
];

export const verifyTools = {
  async handle(name: string, args: any, config: MCPConfig): Promise<any> {
    switch (name) {
      case "check_nonce":
        return handleCheckNonce(args, config);
      case "prove_intent":
        return handleProveIntent(args, config);
      case "verify_proof":
        return handleVerifyProof(args, config);
      default:
        throw new Error(`Unknown verify tool: ${name}`);
    }
  },
};

// ─── check_nonce ─────────────────────────────────────────────

async function handleCheckNonce(
  args: { nonce: string },
  config: MCPConfig
) {
  if (!config.rpcUrl || !config.contracts?.AgentWallet) {
    throw new Error("RPC URL or AgentWallet not configured");
  }

  const provider = getProvider(
    config.defaultChain || "base_sepolia",
    config.rpcUrl,
    config.providerFactory
  );
  const wallet = getContract(
    config.contracts.AgentWallet,
    WALLET_ABI,
    provider,
    config.contractFactory
  );

  const used = await wallet.isNonceUsed(args.nonce);

  return {
    nonce: args.nonce,
    used,
    status: used ? "already_used" : "available",
    wallet: config.contracts.AgentWallet,
  };
}

// ─── prove_intent ────────────────────────────────────────────

async function handleProveIntent(
  args: {
    intent_bundle: any;
    derived_calldata: any;
    public_inputs: any;
  },
  config: MCPConfig
) {
  const proverEndpoint = config.proverEndpoint || "http://localhost:3001";
  const fetchFn = config.fetchFn || fetch;

  // Resolve token symbols (e.g. "USDC") to contract addresses.
  // The prover needs hex addresses so it can convert them to BigInt for the circuit.
  const tokenSymbolMap: Record<string, string | undefined> = {
    USDC: config.contracts?.MockUSDC,
    ETH:  "0x0000000000000000000000000000000000000000",
  };
  function resolveToken(token: string): string {
    if (token?.startsWith("0x")) return token;
    return tokenSymbolMap[token?.toUpperCase()] ?? token;
  }
  const resolvedBundle = {
    ...args.intent_bundle,
    actions: (args.intent_bundle?.actions ?? []).map((a: any) => ({
      ...a,
      token: resolveToken(a.token ?? ""),
    })),
  };

  try {
    const response = await fetchFn(`${proverEndpoint}/prove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intentBundle: resolvedBundle,
        derivedCalldata: args.derived_calldata,
        publicInputs: args.public_inputs,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Prover service returned ${response.status}: ${errBody}`);
    }

    const result = await response.json() as { proof: string; publicSignals: string[]; proofTimeMs: number; mode: string };

    return {
      proof: result.proof,
      publicSignals: result.publicSignals,
      proofTimeMs: result.proofTimeMs,
      mode: result.mode,
      status: "proof_generated",
    };
  } catch (err: any) {
    if (err.message?.includes("Prover service") || err.message?.includes("fetch")) {
      throw new Error(`Prover service unavailable at ${proverEndpoint}: ${err.message}`);
    }
    throw err;
  }
}

// ─── verify_proof ────────────────────────────────────────────

async function handleVerifyProof(
  args: { proof: string; public_signals: string[] },
  config: MCPConfig
) {
  const proverEndpoint = config.proverEndpoint || "http://localhost:3001";
  const fetchFn = config.fetchFn || fetch;

  try {
    const response = await fetchFn(`${proverEndpoint}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proof: args.proof,
        publicSignals: args.public_signals,
      }),
    });

    if (!response.ok) {
      throw new Error(`Verification service returned ${response.status}`);
    }

    const result = await response.json() as { valid: boolean };

    return {
      valid: result.valid,
      status: result.valid ? "proof_valid" : "proof_invalid",
    };
  } catch (err: any) {
    throw new Error(`Proof verification failed: ${err.message}`);
  }
}
