/**
 * Trust Tools — ERC-8004 Integration
 *
 * Queries the three ERC-8004 on-chain registries deployed on Base Sepolia:
 *   - IdentityRegistry   0x8004A818BFB912233c491871b3d84c89A494BD9e
 *   - ReputationRegistry 0x8004B663056A597Dffe9eCcC1965A193B7388713
 *   - ValidationRegistry — not yet deployed; falls back to stub data
 *
 * Each handler attempts a live on-chain read first. If the registry address
 * is unavailable or the call fails (e.g. wrong chain, no RPC), it falls back
 * to DEMO_AGENTS so the demo still runs without a live connection.
 */

import { ethers } from "ethers";
import { CHAINS, ERC8004_ADDRESSES } from "@vaeb/intent-sdk";

type Config = {
  defaultChain: string;
  supportedChains: string[];
  signerPrivateKey?: string; // Required for post_feedback
};

// ─── ABIs for ERC-8004 Contracts ───────────────────────

const IDENTITY_REGISTRY_ABI = [
  "function register() external returns (uint256 agentId)",
  "function register(string memory agentURI) external returns (uint256 agentId)",
  "function register(string memory agentURI, tuple(string metadataKey, bytes metadataValue)[] memory metadata) external returns (uint256 agentId)",
  "function tokenURI(uint256 tokenId) external view returns (string memory)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function totalSupply() external view returns (uint256)",
  "function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory)",
  "function getAgentWallet(uint256 agentId) external view returns (address)",
  "function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool)",
  "function getVersion() external pure returns (string memory)",
  "function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external",
  "function setAgentURI(uint256 agentId, string calldata newURI) external",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external",
  "function unsetAgentWallet(uint256 agentId) external",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)",
  "event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const REPUTATION_REGISTRY_ABI = [
  "function getIdentityRegistry() external view returns (address)",
  "function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64)",
  "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) external view returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)",
  "function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function readAllFeedback(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2, bool includeRevoked) external view returns (address[] memory clients, uint64[] memory feedbackIndexes, int128[] memory values, uint8[] memory valueDecimals, string[] memory tag1s, string[] memory tag2s, bool[] memory revokedStatuses)",
  "function getResponseCount(uint256 agentId, address clientAddress, uint64 feedbackIndex, address[] calldata responders) external view returns (uint64 count)",
  "function getClients(uint256 agentId) external view returns (address[] memory)",
  "function getVersion() external pure returns (string memory)",
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external",
  "function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external",
  "function appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex, string calldata responseURI, bytes32 responseHash) external",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)",
  "event ResponseAppended(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, address indexed responder, string responseURI, bytes32 responseHash)",
];

const VALIDATION_REGISTRY_ABI = [
  "function getIdentityRegistry() external view returns (address)",
  "function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag) external view returns (uint64 count, uint8 avgResponse)",
  "function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory)",
  "function getValidationStatus(bytes32 requestHash) external view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate)",
  "function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory)",
  "function getVersion() external pure returns (string memory)",
  "function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash) external",
  "function validationResponse(bytes32 requestHash, uint8 response, string calldata responseURI, bytes32 responseHash, string calldata tag) external",
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
];

const providerCache = new Map<string, ethers.JsonRpcProvider>();

function getProvider(chainKey: string): ethers.JsonRpcProvider | null {
  const cached = providerCache.get(chainKey);
  if (cached) return cached;

  const chain = CHAINS[chainKey];
  if (!chain) return null;

  try {
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
    providerCache.set(chainKey, provider);
    return provider;
  } catch {
    return null;
  }
}

function getContracts(chainKey: string) {
  const addrs = ERC8004_ADDRESSES[chainKey];
  const provider = getProvider(chainKey);
  if (!addrs || !provider) return null;

  return {
    identity: new ethers.Contract(addrs.identityRegistry, IDENTITY_REGISTRY_ABI, provider),
    reputation: new ethers.Contract(addrs.reputationRegistry, REPUTATION_REGISTRY_ABI, provider),
    validation: addrs.validationRegistry
      ? new ethers.Contract(addrs.validationRegistry, VALIDATION_REGISTRY_ABI, provider)
      : null,
    provider,
    addrs,
  };
}

// ─── Simulated Agent Database (for demo) ────────────────────────
// In production, these are queried from on-chain registries

const DEMO_AGENTS = [
  {
    agentId: 1,
    agentURI: "https://vaeb.xyz/agent-1",
    owner: "0x1234567890123456789012345678901234567890",
    metadata: { name: "VAEB-Agent-1", proofType: "groth16", avgProofTime: "3200ms" },
    reputation: { count: 1847n, summaryValue: 920n, decimals: 2, clients: [] as string[] },
    validation: { count: 412n, avgResponse: 98 },
  },
  {
    agentId: 2,
    agentURI: "https://vaeb.xyz/agent-2",
    owner: "0x1234567890123456789012345678901234567890",
    metadata: { name: "VAEB-Agent-2", proofType: "groth16", avgProofTime: "4100ms" },
    reputation: { count: 423n, summaryValue: 870n, decimals: 2, clients: [] as string[] },
    validation: { count: 98n, avgResponse: 97 },
  },
];

// ─── Tool Handlers ──────────────────────────────────────────────

export const trustTools = {
  async handle(name: string, args: any, config: Config): Promise<any> {
    switch (name) {
      case "discover_agents":
        return discoverAgents(args, config);
      case "get_agent_reputation":
        return getAgentReputation(args, config);
      case "get_agent_validations":
          return getAgentValidations(args, config);
      case "post_feedback":
        return postFeedback(args, config);
      case "compare_agents":
        return compareAgents(args, config);
      default:
        throw new Error(`Unknown trust tool: ${name}`);
    }
  },
};

// ─── discover_agents ────────────────────────────────────────────

async function discoverAgents(args: any, config: Config) {
  const chainKey = args.chain || config.defaultChain;
  const minReputation = args.min_reputation || 0;
  const contracts = getContracts(chainKey);

  let agents: any[] = [];
  let source: "on-chain" | "demo" = "on-chain";

  if (contracts) {
    try {
      // scan IDs 1-100
      const MAX_AGENT_ID_SCAN = 100;
      const ids = Array.from({ length: MAX_AGENT_ID_SCAN }, (_, i) => i + 1);

      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const [owner, uri] = await Promise.all([
            contracts.identity.ownerOf(id),
            contracts.identity.tokenURI(id).catch(() => ""),
          ]);
          return { agentId: id, owner, agentURI: uri };
        })
      );

      // filter out rejected calls (agent ID doesn't exist)
      agents = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
        .map((r) => r.value);

      if (agents.length === 0) {
        source = "demo";
        agents = DEMO_AGENTS;
      }
    } catch {
      // if failure fall back to demo agents
      source = "demo";
      agents = DEMO_AGENTS;
    }
  } else {
    source = "demo";
    agents = DEMO_AGENTS;
  }

  // fetch reputation data
  const enriched = await Promise.all(
    agents.map(async (a) => {
      const rep = await fetchReputation(a.agentId, chainKey, contracts).catch(() => null);
      return { ...a, reputation: rep };
    })
  );

  // filter and score
  const filtered = enriched.filter((a) => {
    if (!a.reputation) return minReputation === 0;
    const score = normalizedScore(a.reputation);
    return score >= minReputation;
  });

  const scored = filtered
    .map((a) => ({ ...a, compositeScore: computeCompositeScore(a.reputation) }))
    .sort((a, b) => b.compositeScore - a.compositeScore);

  const recommended = scored[0];
  const alternatives = scored.slice(1);

  return {
    source,
    recommended: recommended ? formatAgent(recommended) : null,
    alternatives: alternatives.map(formatAgent),
    query: { chain: chainKey, min_reputation: minReputation },
    total_agents_found: scored.length,
  };
}

// ─── get_agent_reputation ───────────────────────────────────────

async function getAgentReputation(args: any, config: Config) {
  const chainKey = args.chain || config.defaultChain;
  const agentId: number = args.agent_id;
  const contracts = getContracts(chainKey);

  if (contracts) {
    try {
      const [owner, uri] = await Promise.all([
        contracts.identity.ownerOf(agentId),
        contracts.identity.tokenURI(agentId).catch(() => ""),
      ]);

      const rep = await fetchReputation(agentId, chainKey, contracts);

      return {
        source: "on-chain",
        agent_id: agentId,
        owner,
        agent_uri: uri,
        reputation: formatReputation(rep),
      };
    } catch (err: any) {
      // fall back to demo
      console.error(`[getAgentReputation] On-chain fetch failed for agent ${agentId}:`, err.message);
      const demo = DEMO_AGENTS.find((a) => a.agentId === agentId);
      if (!demo) throw new Error(`Agent ${agentId} not found on-chain or in demo data. Original error: ${err.message}`);
      return {
        source: "demo",
        agent_id: demo.agentId,
        owner: demo.owner,
        agent_uri: demo.agentURI,
        reputation: formatReputation(demo.reputation),
      };
    }
  } else {
    const demo = DEMO_AGENTS.find((a) => a.agentId === agentId);
    if (!demo) throw new Error(`Agent ${agentId} not found`);
    return {
      source: "demo",
      agent_id: demo.agentId,
      owner: demo.owner,
      agent_uri: demo.agentURI,
      reputation: formatReputation(demo.reputation),
    };
  }
}

// ─── get_agent_validations ──────────────────────────────────────

async function getAgentValidations(args: any, config: Config) {
  const chainKey = args.chain || config.defaultChain;
  const agentId: number = args.agent_id;
  const contracts = getContracts(chainKey);

  if (contracts?.validation) {
    try {
      const hashes: string[] = await contracts.validation.getAgentValidations(agentId);
      const statuses = await Promise.allSettled(
        hashes.map((h) => contracts.validation!.getValidationStatus(h))
      );

      const resolved = statuses
        .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
        .map((r, i) => ({
          request_hash: hashes[i],
          validator: r.value.validatorAddress,
          response: r.value.response,
          tag: r.value.tag,
          last_update: new Date(Number(r.value.lastUpdate) * 1000).toISOString(),
          has_response: r.value.hasResponse,
        }));

      const passCount = resolved.filter((v) => v.response >= 50).length;

      return {
        source: "on-chain",
        agent_id: agentId,
        total_validations: resolved.length,
        pass_count: passCount,
        fail_count: resolved.length - passCount,
        pass_rate: resolved.length > 0
          ? ((passCount / resolved.length) * 100).toFixed(1) + "%"
          : "N/A",
        validations: resolved,
      };
    } catch {
      // Fall through to demo
    }
  }

  // Fallback
  const demo = DEMO_AGENTS.find((a) => a.agentId === agentId);
  if (!demo) throw new Error(`Agent ${agentId} not found`);
  return {
    source: "demo",
    agent_id: demo.agentId,
    total_validations: Number(demo.validation.count),
    pass_count: Math.round(Number(demo.validation.count) * demo.validation.avgResponse / 100),
    fail_count: Math.round(Number(demo.validation.count) * (1 - demo.validation.avgResponse / 100)),
    pass_rate: demo.validation.avgResponse.toFixed(1) + "%",
    validations: [],
  };
}

// ─── post_feedback ──────────────────────────────────────────────
// need to set config.signerPrivateKey for this

async function postFeedback(args: any, config: Config) {
  const chainKey = args.chain || config.defaultChain;
  const agentId: number = args.agent_id;

  // value is an integer score 0–100
  const value: number = Math.max(0, Math.min(100, Math.round(args.score ?? 50)));
  const tag1: string = args.tag1 ?? "";
  const tag2: string = args.tag2 ?? "";
  const feedbackURI: string = args.feedback_uri ?? "";
  const feedbackHash: string = args.feedback_hash
    ?? ethers.keccak256(ethers.toUtf8Bytes(`${agentId}-${value}-${Date.now()}`));
  const endpoint: string = args.endpoint ?? "";

  if (!config.signerPrivateKey) {
    return {
      posted: false,
      note: "No signer key configured. Set AGENT_PRIVATE_KEY in .env.",
      agent_id: agentId,
      score: value,
    };
  }

  const addrs = ERC8004_ADDRESSES[chainKey];
  const provider = getProvider(chainKey);
  if (!addrs || !provider) {
    throw new Error(`Chain ${chainKey} not configured`);
  }

  const signer = new ethers.Wallet(config.signerPrivateKey, provider);
  const rep = new ethers.Contract(addrs.reputationRegistry, REPUTATION_REGISTRY_ABI, signer);

  const tx = await rep.giveFeedback(
    agentId,
    value,
    0,
    tag1,
    tag2,
    endpoint,
    feedbackURI,
    feedbackHash
  );
  const receipt = await tx.wait();

  return {
    posted: true,
    agent_id: agentId,
    score: value,
    tags: [tag1, tag2].filter(Boolean),
    tx_hash: receipt.hash,
    block: receipt.blockNumber,
    explorer: `${CHAINS[chainKey]?.blockExplorer}/tx/${receipt.hash}`,
  };
}

// ─── compare_agents ─────────────────────────────────────────────

async function compareAgents(args: any, config: Config) {
  const chainKey = args.chain || config.defaultChain;
  const agentIds: number[] = args.agent_ids ?? [];
  if (agentIds.length === 0) throw new Error("agent_ids must be a non-empty array");

  const results = await Promise.allSettled(
    agentIds.map((id) => getAgentReputation({ agent_id: id, chain: chainKey }, config))
  );

  const agents = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map((r) => r.value);

  if (agents.length === 0) throw new Error("No agents found for comparison");

  const scored = agents
    .map((a) => ({
      ...a,
      compositeScore: computeCompositeScore(a.reputation?._raw),
    }))
    .sort((a, b) => b.compositeScore - a.compositeScore);

  return {
    agents: scored.map((a) => ({
      agent_id: a.agent_id,
      owner: a.owner,
      reputation_score: a.reputation?.normalized_score,
      feedback_count: a.reputation?.feedback_count,
      trust_tier: a.reputation?.trust_tier,
      composite_score: a.compositeScore.toFixed(2),
    })),
    recommendation: scored[0]?.agent_id,
  };
}

// helpers

// fetch reputation data for an agent
async function fetchReputation(agentId: number, _chainKey: string, contracts: ReturnType<typeof getContracts>) {
  if (!contracts) throw new Error("no contracts");

  const clientsResult = await contracts.reputation.getClients(agentId);
  // Convert to plain array - ethers.js returns a Result object
  const clients: string[] = Array.from(clientsResult);

  // getSummary with empty tag filter returns aggregated score across all feedback
  const result = await contracts.reputation.getSummary(agentId, clients, "", "");
  const count = result[0];
  const summaryValue = result[1];
  const summaryDecimals = result[2];

  return {
    count,
    summaryValue,
    decimals: Number(summaryDecimals),
    clients,
  };
}

// convert on-chain summaryValue/decimals to a 0–100 score
function normalizedScore(rep: { summaryValue: bigint; decimals: number; count: bigint }): number {
  if (rep.count === 0n) return 0;
  const divisor = Math.pow(10, rep.decimals);
  return Number(rep.summaryValue) / divisor;
}

// ─── Helper: Trust Tier ─────────────────────────────────────────

function getTrustTier(score: number, count: bigint): string {
  const n = Number(count);
  if (score >= 90 && n >= 1000) return "ELITE";
  if (score >= 70 && n >= 500)  return "ESTABLISHED";
  if (score >= 50 && n >= 50)   return "EMERGING";
  return "UNTRUSTED";
}

// ─── Helper: Composite Trust Score ──────────────────────────────

function computeCompositeScore(rep: any): number {
  if (!rep) return 0;
  const count = Number(rep.count ?? 0n);
  const score = normalizedScore(rep);
  const normalizedCount = Math.min(count / 2000, 1);
  return score * 0.6 + normalizedCount * 100 * 0.4;
}

function formatReputation(rep: any) {
  if (!rep) return null;
  const score = normalizedScore(rep);
  const count = Number(rep.count ?? 0n);
  return {
    normalized_score: score.toFixed(2),
    feedback_count: count,
    trust_tier: getTrustTier(score, rep.count ?? 0n),
    clients: (rep.clients ?? []).map((c: string) => c),
    _raw: rep,
  };
}

function formatAgent(a: any) {
  return {
    agent_id: a.agentId,
    owner: a.owner,
    agent_uri: a.agentURI,
    reputation: a.reputation ? {
      score: normalizedScore(a.reputation).toFixed(2),
      feedback_count: Number(a.reputation.count ?? 0n),
      trust_tier: getTrustTier(normalizedScore(a.reputation), a.reputation.count ?? 0n),
    } : null,
    composite_score: a.compositeScore?.toFixed(2) ?? "0.00",
  };
}
