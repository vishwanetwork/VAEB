/**
 * Trust Tools — ERC-8004 Integration
 *
 * These tools query the three ERC-8004 on-chain registries:
 *   - IdentityRegistry: Agent registration (ERC-721 NFTs)
 *   - ReputationRegistry: Feedback scores and tags
 *   - ValidationRegistry: ZK proof re-verification records
 *
 * Together they form the "Trust Loop":
 *   discover → evaluate → execute → feedback → validate
 */

import { ethers } from "ethers";
import { CHAINS, ERC8004_ADDRESSES } from "@vaeb/intent-sdk";

type Config = {
  defaultChain: string;
  supportedChains: string[];
};

// ─── ABI Fragments for ERC-8004 Contracts ───────────────────────

const IDENTITY_REGISTRY_ABI = [
  "function register(string tokenURI, tuple(string key, string value)[] metadata) returns (uint256)",
  "function getMetadata(uint256 agentId) view returns (tuple(string key, string value)[])",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function totalSupply() view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const REPUTATION_REGISTRY_ABI = [
  "function giveFeedback(uint256 agentId, uint8 score, string tag1, string tag2, string fileuri, bytes32 filehash, bytes feedbackAuth)",
  "function getSummary(uint256 agentId) view returns (uint256 avgScore, uint256 feedbackCount, string[] tags)",
  "event FeedbackGiven(uint256 indexed agentId, uint8 score, string tag1, string tag2)",
];

const VALIDATION_REGISTRY_ABI = [
  "function validationRequest(address validatorAddress, uint256 agentId, string requestUri, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseUri, bytes32 responseHash, string tag)",
  "function getSummary(uint256 agentId) view returns (uint256 validationCount, uint256 passCount)",
];

// ─── Simulated Agent Database (for demo) ────────────────────────
// In production, these are queried from on-chain registries

const DEMO_AGENTS = [
  {
    agentId: 42,
    name: "VAEB-Prover-Base-01",
    owner: "0x1234567890123456789012345678901234567890",
    metadata: {
      agentName: "VAEB-Prover-Base-01",
      supportedChains: ["base", "ethereum", "arbitrum"],
      proofType: "groth16",
      avgProofTime: "3200ms",
      x402Pricing: "0.02 USDC per proof",
    },
    reputation: { avgScore: 9.2, feedbackCount: 1847, tags: { swap: 1200, execution_speed: 400, execution_quality: 247 } },
    validation: { validationCount: 412, passRate: 1.0 },
  },
  {
    agentId: 78,
    name: "VAEB-Prover-Multi-02",
    owner: "0xABCDABCDABCDABCDABCDABCDABCDABCDABCDABCD",
    metadata: {
      agentName: "VAEB-Prover-Multi-02",
      supportedChains: ["base", "ethereum"],
      proofType: "groth16",
      avgProofTime: "4100ms",
      x402Pricing: "0.015 USDC per proof",
    },
    reputation: { avgScore: 8.7, feedbackCount: 423, tags: { swap: 300, stake: 123 } },
    validation: { validationCount: 98, passRate: 0.99 },
  },
  {
    agentId: 115,
    name: "VAEB-Prover-Fast-03",
    owner: "0x5678567856785678567856785678567856785678",
    metadata: {
      agentName: "VAEB-Prover-Fast-03",
      supportedChains: ["base"],
      proofType: "groth16",
      avgProofTime: "1800ms",
      x402Pricing: "0.03 USDC per proof",
    },
    reputation: { avgScore: 6.1, feedbackCount: 89, tags: { swap: 70, transfer: 19 } },
    validation: { validationCount: 22, passRate: 0.91 },
  },
  {
    agentId: 203,
    name: "VAEB-Prover-New-04",
    owner: "0x9999999999999999999999999999999999999999",
    metadata: {
      agentName: "VAEB-Prover-New-04",
      supportedChains: ["base", "ethereum", "solana"],
      proofType: "groth16",
      avgProofTime: "2500ms",
      x402Pricing: "0.01 USDC per proof",
    },
    reputation: { avgScore: 9.5, feedbackCount: 12, tags: { swap: 12 } },
    validation: { validationCount: 3, passRate: 1.0 },
  },
];

// ─── Tool Handlers ──────────────────────────────────────────────

export const trustTools = {
  async handle(name: string, args: any, config: Config): Promise<any> {
    switch (name) {
      case "discover_agents":
        return discoverAgents(args, config);
      case "get_agent_reputation":
        return getAgentReputation(args);
      case "get_agent_validations":
        return getAgentValidations(args);
      case "post_feedback":
        return postFeedback(args, config);
      case "compare_agents":
        return compareAgents(args);
      default:
        throw new Error(`Unknown trust tool: ${name}`);
    }
  },
};

// ─── discover_agents ────────────────────────────────────────────

async function discoverAgents(args: any, config: Config) {
  const chainKey = args.chain || config.defaultChain;
  const operation = args.operation || "";
  const minReputation = args.min_reputation || 0;

  // Filter agents by criteria
  let candidates = DEMO_AGENTS.filter((a) => {
    if (minReputation > 0 && a.reputation.avgScore < minReputation) return false;
    if (chainKey) {
      // Strip network suffix (e.g. "base_sepolia" → "base", "ethereum_sepolia" → "ethereum")
      const chainBase = chainKey.replace(/_sepolia$/, "").replace(/_mainnet$/, "");
      if (!a.metadata.supportedChains.some((c) => c.toLowerCase().includes(chainBase))) {
        return false;
      }
    }
    return true;
  });

  // Score and rank
  const scored = candidates.map((a) => ({
    ...a,
    compositeScore: computeCompositeScore(a),
  })).sort((a, b) => b.compositeScore - a.compositeScore);

  const recommended = scored[0];
  const alternatives = scored.slice(1);

  return {
    recommended: recommended
      ? {
          agent_id: recommended.agentId,
          name: recommended.name,
          reputation: {
            score: recommended.reputation.avgScore,
            feedbacks: recommended.reputation.feedbackCount,
            validation_rate: recommended.validation.passRate,
          },
          pricing: recommended.metadata.x402Pricing,
          avg_proof_time: recommended.metadata.avgProofTime,
          composite_score: recommended.compositeScore.toFixed(2),
        }
      : null,
    alternatives: alternatives.map((a) => ({
      agent_id: a.agentId,
      name: a.name,
      score: a.reputation.avgScore,
      feedbacks: a.reputation.feedbackCount,
      composite_score: a.compositeScore.toFixed(2),
    })),
    query: { chain: chainKey, operation, min_reputation: minReputation },
    total_agents_found: scored.length,
  };
}

// ─── get_agent_reputation ───────────────────────────────────────

async function getAgentReputation(args: any) {
  const agent = DEMO_AGENTS.find((a) => a.agentId === args.agent_id);
  if (!agent) throw new Error(`Agent not found: ${args.agent_id}`);

  return {
    agent_id: agent.agentId,
    name: agent.name,
    reputation: {
      avg_score: agent.reputation.avgScore,
      feedback_count: agent.reputation.feedbackCount,
      tags: agent.reputation.tags,
      trust_tier: getTrustTier(agent.reputation.avgScore, agent.reputation.feedbackCount),
    },
    metadata: agent.metadata,
  };
}

// ─── get_agent_validations ──────────────────────────────────────

async function getAgentValidations(args: any) {
  const agent = DEMO_AGENTS.find((a) => a.agentId === args.agent_id);
  if (!agent) throw new Error(`Agent not found: ${args.agent_id}`);

  return {
    agent_id: agent.agentId,
    name: agent.name,
    validation: {
      total_validations: agent.validation.validationCount,
      pass_rate: (agent.validation.passRate * 100).toFixed(1) + "%",
      pass_count: Math.round(agent.validation.validationCount * agent.validation.passRate),
      fail_count: Math.round(agent.validation.validationCount * (1 - agent.validation.passRate)),
    },
  };
}

// ─── post_feedback ──────────────────────────────────────────────

async function postFeedback(args: any, config: Config) {
  const agent = DEMO_AGENTS.find((a) => a.agentId === args.agent_id);
  if (!agent) throw new Error(`Agent not found: ${args.agent_id}`);

  // In production: call ReputationRegistry.giveFeedback() on-chain
  // with feedbackAuth signature to prevent spam

  return {
    agent_id: args.agent_id,
    feedback_posted: true,
    score: args.score,
    tags: [args.tag1, args.tag2].filter(Boolean),
    receipt_uri: args.receipt_uri || "ipfs://Qm.../receipt.json",
    note: "Feedback recorded. Agent reputation will be updated on next query.",
    tx_hash: ethers.keccak256(
      ethers.toUtf8Bytes(`feedback-${args.agent_id}-${Date.now()}`)
    ),
  };
}

// ─── compare_agents ─────────────────────────────────────────────

async function compareAgents(args: any) {
  const agentIds = args.agent_ids || [];
  const agents = agentIds
    .map((id: number) => DEMO_AGENTS.find((a) => a.agentId === id))
    .filter(Boolean);

  if (agents.length === 0) throw new Error("No agents found for comparison");

  return {
    agents: agents.map((a: any) => ({
      agent_id: a.agentId,
      name: a.name,
      reputation_score: a.reputation.avgScore,
      feedback_count: a.reputation.feedbackCount,
      validation_rate: (a.validation.passRate * 100).toFixed(1) + "%",
      validations: a.validation.validationCount,
      trust_tier: getTrustTier(a.reputation.avgScore, a.reputation.feedbackCount),
      pricing: a.metadata.x402Pricing,
      avg_proof_time: a.metadata.avgProofTime,
      supported_chains: a.metadata.supportedChains,
      composite_score: computeCompositeScore(a).toFixed(2),
    })),
    recommendation: agents.sort(
      (a: any, b: any) => computeCompositeScore(b) - computeCompositeScore(a)
    )[0]?.agentId,
  };
}

// ─── Helper: Composite Trust Score ──────────────────────────────

function computeCompositeScore(agent: any): number {
  const repWeight = 0.4;
  const feedbackWeight = 0.2;
  const validationWeight = 0.3;
  const validationCountWeight = 0.1;

  const normalizedFeedback = Math.min(agent.reputation.feedbackCount / 2000, 1);
  const normalizedValidationCount = Math.min(agent.validation.validationCount / 500, 1);

  return (
    agent.reputation.avgScore * repWeight +
    normalizedFeedback * 10 * feedbackWeight +
    agent.validation.passRate * 10 * validationWeight +
    normalizedValidationCount * 10 * validationCountWeight
  );
}

// ─── Helper: Trust Tier ─────────────────────────────────────────

function getTrustTier(score: number, feedbacks: number): string {
  if (score >= 9 && feedbacks >= 1000) return "ELITE";
  if (score >= 7 && feedbacks >= 500) return "ESTABLISHED";
  if (score >= 5 && feedbacks >= 50) return "EMERGING";
  return "UNTRUSTED";
}
