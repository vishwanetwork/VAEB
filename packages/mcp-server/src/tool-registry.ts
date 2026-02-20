/**
 * Tool Registry — Defines all MCP tool schemas for VAEB
 *
 * Each tool has:
 *   - name: unique identifier
 *   - description: what the tool does (shown to AI agents)
 *   - inputSchema: JSON Schema for parameters
 */

export function getToolDefinitions() {
  return [
    // ─── Chain Tools (Free) ─────────────────────────────────────

    {
      name: "get_wallet_balance",
      description:
        "Get the configured AgentWallet ETH and USDC balances. Call this FIRST before creating any intent to verify sufficient funds for gas and the transaction.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "check_nonce",
      description:
        "Check if a nonce has already been used on-chain. Call this after create_intent and before execute_intent to verify the nonce is still fresh and safe to execute.",
      inputSchema: {
        type: "object" as const,
        properties: {
          nonce: {
            type: "string",
            description: "bytes32 hex nonce from the create_intent bundle response",
          },
        },
        required: ["nonce"],
      },
    },

    {
      name: "read_balance",
      description:
        "Read the token balance of a wallet on a supported chain. Returns balance in human-readable format.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chain: {
            type: "string",
            description: 'Chain to query (e.g., "base_sepolia", "ethereum_sepolia")',
          },
          token: {
            type: "string",
            description: 'Token symbol or address (e.g., "USDC", "ETH", "0x...")',
          },
          wallet: {
            type: "string",
            description: 'Wallet address to check, or "agent-wallet" for the configured AgentWallet',
          },
        },
        required: ["chain", "token", "wallet"],
      },
    },

    {
      name: "get_price",
      description:
        "Get the current price of a token pair across multiple chains and DEXs. Returns best price and liquidity.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pair: {
            type: "string",
            description: 'Token pair (e.g., "ETH/USDC", "WBTC/ETH")',
          },
          chains: {
            type: "array",
            items: { type: "string" },
            description: 'Chains to query (e.g., ["base_sepolia", "ethereum_sepolia"])',
          },
        },
        required: ["pair"],
      },
    },

    {
      name: "estimate_gas",
      description:
        "Estimate gas cost for an operation on a specific chain. Returns gas in native currency and USD.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chain: { type: "string", description: "Target chain" },
          operation: {
            type: "string",
            description: 'Operation type (e.g., "swap", "transfer", "stake")',
          },
          params: {
            type: "object",
            description: "Operation parameters",
          },
        },
        required: ["chain", "operation"],
      },
    },

    {
      name: "get_receipt",
      description:
        "Get the transaction receipt for a completed on-chain transaction. Returns confirmation status, gas used, and events.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chain: { type: "string", description: "Chain where the transaction was executed" },
          tx_hash: { type: "string", description: "Transaction hash" },
        },
        required: ["chain", "tx_hash"],
      },
    },

    // ─── Intent Tools (Paid via x402) ───────────────────────────

    {
      name: "create_intent",
      description:
        "Create an IntentBundle from high-level actions. Routes to optimal chain, resolves DEX, encodes calldata. Returns human-readable preview requiring user signature. Service fee: 0.01 USDC via x402.",
      inputSchema: {
        type: "object" as const,
        properties: {
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["SWAP", "TRANSFER", "STAKE", "UNSTAKE", "APPROVE", "LEND", "BORROW"],
                },
                from_token: { type: "string", description: "Source token (for SWAP)" },
                to_token: { type: "string", description: "Destination token (for SWAP)" },
                token: { type: "string", description: "Token (for TRANSFER, STAKE, etc.)" },
                amount: { type: "number", description: "Amount in human-readable units" },
                max_slippage: { type: "number", description: "Max slippage tolerance (e.g., 0.005 for 0.5%)" },
                preferred_dex: { type: "string", description: 'DEX preference (e.g., "uniswap", "auto")' },
                recipient: { type: "string", description: "Recipient address (for TRANSFER)" },
              },
              required: ["type", "amount"],
            },
            description: "List of actions to execute atomically",
          },
          chain_preference: {
            type: "string",
            description: 'Chain selection strategy: "cheapest_gas", "fastest_finality", "most_liquidity", or specific chain name',
          },
          expiry_minutes: {
            type: "number",
            description: "Minutes until intent expires (default: 10)",
          },
        },
        required: ["actions"],
      },
    },

    {
      name: "execute_intent",
      description:
        "Execute a previously created and signed intent. Triggers x402 payment, ZK proof generation, and on-chain execution via AgentWallet.executeWithProof(). Service fee: 0.02 USDC via x402.",
      inputSchema: {
        type: "object" as const,
        properties: {
          intent_id: { type: "string", description: "Intent ID from create_intent" },
          signature: { type: "string", description: "User's EIP-712 signature over the IntentBundle" },
        },
        required: ["intent_id", "signature"],
      },
    },

    {
      name: "simulate_intent",
      description:
        "Dry-run an intent via eth_call to preview execution result without submitting on-chain. Service fee: 0.005 USDC via x402.",
      inputSchema: {
        type: "object" as const,
        properties: {
          intent_id: { type: "string", description: "Intent ID from create_intent" },
        },
        required: ["intent_id"],
      },
    },

    {
      name: "cancel_intent",
      description: "Cancel a pending intent by invalidating its nonce on-chain.",
      inputSchema: {
        type: "object" as const,
        properties: {
          intent_id: { type: "string", description: "Intent ID to cancel" },
          signature: { type: "string", description: "Owner signature authorizing cancellation" },
        },
        required: ["intent_id"],
      },
    },

    // ─── Trust Tools (ERC-8004) ─────────────────────────────────

    {
      name: "discover_agents",
      description:
        "Discover VAEB agents via ERC-8004 IdentityRegistry. Queries agent capabilities, reputation scores, and validation history. Returns ranked recommendations.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chain: { type: "string", description: "Chain to query agents for" },
          operation: { type: "string", description: 'Operation type (e.g., "swap", "transfer")' },
          min_reputation: { type: "number", description: "Minimum reputation score (0-10)" },
        },
        required: ["chain"],
      },
    },

    {
      name: "get_agent_reputation",
      description:
        "Get detailed reputation info for a specific agent. Queries ERC-8004 ReputationRegistry.getSummary().",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: { type: "number", description: "Agent's ERC-721 token ID in IdentityRegistry" },
        },
        required: ["agent_id"],
      },
    },

    {
      name: "get_agent_validations",
      description:
        "Get validation history for an agent. Queries ERC-8004 ValidationRegistry.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: { type: "number", description: "Agent's ERC-721 token ID" },
        },
        required: ["agent_id"],
      },
    },

    {
      name: "post_feedback",
      description:
        "Post execution feedback to ERC-8004 ReputationRegistry. Requires feedbackAuth signature from the agent.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: { type: "number", description: "Agent ID that performed the execution" },
          score: { type: "number", description: "Quality score 0-10" },
          tag1: { type: "string", description: "Primary categorization tag" },
          tag2: { type: "string", description: "Operation type tag" },
          receipt_uri: { type: "string", description: "IPFS URI to execution receipt" },
          receipt_hash: { type: "string", description: "keccak256 hash of receipt data" },
        },
        required: ["agent_id", "score", "tag1"],
      },
    },

    {
      name: "compare_agents",
      description:
        "Side-by-side comparison of multiple agents' reputation, validation rates, and capabilities.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_ids: {
            type: "array",
            items: { type: "number" },
            description: "Agent IDs to compare",
          },
        },
        required: ["agent_ids"],
      },
    },
  ];
}
