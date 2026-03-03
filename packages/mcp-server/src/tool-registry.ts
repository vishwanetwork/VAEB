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

    // ─── Wallet Tools (AgentWalletFactory) ──────────────────────

    {
      name: "create_wallet",
      description:
        "Deploy a new AgentWallet contract for a user via AgentWalletFactory. The wallet is owned by the provided address (user's MetaMask) and operated by the VAEB agent EOA. Uses CREATE2 for a deterministic address. Provide salt_index to deploy multiple wallets for the same owner.",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: {
            type: "string",
            description: "Owner address (user's MetaMask wallet address, e.g. 0x...)",
          },
          salt_index: {
            type: "number",
            description: "Index for deterministic salt derivation (default: 0). Increment to deploy additional wallets for the same owner.",
          },
        },
        required: ["owner"],
      },
    },

    {
      name: "predict_wallet",
      description:
        "Predict the CREATE2 address of an AgentWallet before deployment. Free read-only call. Use this to show the user their future wallet address before calling create_wallet.",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: {
            type: "string",
            description: "Owner address to predict wallet for",
          },
          salt_index: {
            type: "number",
            description: "Salt index (must match what you plan to use in create_wallet, default: 0)",
          },
        },
        required: ["owner"],
      },
    },

    {
      name: "get_wallets",
      description:
        "List all AgentWallet contracts deployed for a given owner address via the factory. Returns wallet addresses and block explorer links.",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: {
            type: "string",
            description: "Owner address to look up wallets for",
          },
        },
        required: ["owner"],
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

    // ─── Marketplace Tools (Rent a Human) ─────────────────────

    {
      name: "search_marketplace",
      description:
        "Search the Rent a Human marketplace for available humans who can complete a physical task. Returns matching humans with name, rating, rate in USDC, skills, and distance.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description:
              'Search query — a task type or skill like "grocery", "delivery", "pet care", "errands", "cleaning"',
          },
        },
        required: ["query"],
      },
    },

    {
      name: "hire_human",
      description:
        "Hire a specific human from the marketplace for a task. Creates a USDC payment intent with EIP-712 typed data that the user must sign to approve. Only call this after the user explicitly confirms they want to hire someone.",
      inputSchema: {
        type: "object" as const,
        properties: {
          human_id: {
            type: "string",
            description: 'The ID of the human to hire (e.g. "alice", "bob")',
          },
          task_description: {
            type: "string",
            description: "Description of the task the human will perform",
          },
          amount: {
            type: "string",
            description: 'Amount in USDC to pay (e.g. "25")',
          },
        },
        required: ["human_id", "task_description", "amount"],
      },
    },

    {
      name: "execute_payment",
      description:
        "Execute a signed payment intent on-chain via the full ERC-8150 ZK pipeline: check_nonce → prove_intent → AgentWallet.executeWithProof(). Falls back to executeDirectly() if the prover is unavailable. Called after the user signs the EIP-712 typed data.",
      inputSchema: {
        type: "object" as const,
        properties: {
          review_id: {
            type: "string",
            description: "The review ID from the hire_human intent",
          },
          signature: {
            type: "string",
            description: "The user's EIP-712 signature over the DirectExecution typed data",
          },
        },
        required: ["review_id", "signature"],
      },
    },

    // ─── Verify Tools (ERC-8150 ZK Pipeline) ──────────────────

    {
      name: "prove_intent",
      description:
        "Generate a Groth16 ZK proof for an intent bundle via the VAEB prover service. The proof attests that the intent was correctly constructed without revealing private inputs. Used before executeWithProof().",
      inputSchema: {
        type: "object" as const,
        properties: {
          intent_bundle: {
            type: "object",
            description: "The intent bundle containing payer and actions",
          },
          derived_calldata: {
            type: "object",
            description: "The derived calldata with encoded contract calls",
          },
          public_inputs: {
            type: "object",
            description: "Public inputs: commitment, chainId, signerAddress, multicallDataHash, nonce, expiry",
          },
        },
        required: ["intent_bundle", "derived_calldata", "public_inputs"],
      },
    },

    {
      name: "verify_proof",
      description:
        "Verify a Groth16 ZK proof off-chain via the VAEB prover service. Returns whether the proof is valid. Useful for pre-checking before submitting on-chain.",
      inputSchema: {
        type: "object" as const,
        properties: {
          proof: {
            type: "string",
            description: "The encoded proof bytes",
          },
          public_signals: {
            type: "array",
            items: { type: "string" },
            description: "Array of public signal values from proof generation",
          },
        },
        required: ["proof", "public_signals"],
      },
    },

    // ─── BTC Tools (Bitcoin Transfer) ───────────────────────────

    {
      name: "init_btc_payment",
      description:
        "Initialize BTC staking to receive BTCVC via Vishwa's x402 payment service. IMPORTANT: This requires TWO payments: (1) $0.5 USDC service fee on Base network (x402 protocol) to obtain the BTC deposit address, (2) The actual BTC deposit from user's BTC wallet. BTCVC will be minted to a fixed vault address. First call will return payment requirements (402 response), user must pay $0.5 USDC, then call again with payment_header to get the actual BTC deposit address.",
      inputSchema: {
        type: "object" as const,
        properties: {
          amount_btc: {
            type: "string",
            description: "Amount of BTC to stake (e.g., \"0.001\")",
          },
          network: {
            type: "string",
            enum: ["mainnet", "testnet"],
            description: "Bitcoin network (default: testnet)",
          },
          expiry_minutes: {
            type: "number",
            description: "Minutes until expiration (default: 60)",
          },
          payer_address: {
            type: "string",
            description: "Optional: User's address for tracking",
          },
          payment_header: {
            type: "string",
            description: "Optional: x402 payment header/proof after paying $0.5 USDC (obtained from payment transaction)",
          },
        },
        required: ["amount_btc"],
      },
    },

    {
      name: "confirm_btc_transfer",
      description:
        "Confirm that the user has sent BTC to the deposit address. Call this after the user provides the transaction hash. This verifies the transaction on the blockchain and notifies the x402 service. This is Step 3 of the BTC payment flow.",
      inputSchema: {
        type: "object" as const,
        properties: {
          intent_id: {
            type: "string",
            description: "The intent ID returned by init_btc_payment",
          },
          tx_hash: {
            type: "string",
            description: "The Bitcoin transaction hash (txid) of the deposit",
          },
          signed_tx: {
            type: "string",
            description: "Optional: Signed transaction hex (alternative to tx_hash for direct broadcast)",
          },
        },
        required: ["intent_id"],
      },
    },

    {
      name: "get_btc_payment_status",
      description:
        "Check the current status of a BTC payment. Returns deposit address, transaction status, blockchain confirmations, and expiration info. Can be called at any time.",
      inputSchema: {
        type: "object" as const,
        properties: {
          intent_id: {
            type: "string",
            description: "The intent ID to check status for",
          },
        },
        required: ["intent_id"],
      },
    },

    {
      name: "broadcast_btc_transaction",
      description:
        "Broadcast a signed Bitcoin transaction to the network. Can also verify a transaction by hash. Uses mempool.space API. Generally not needed if using confirm_btc_transfer with tx_hash.",
      inputSchema: {
        type: "object" as const,
        properties: {
          intent_id: {
            type: "string",
            description: "The intent ID (optional if only verifying tx_hash)",
          },
          signed_tx: {
            type: "string",
            description: "Signed transaction hex string to broadcast",
          },
          tx_hash: {
            type: "string",
            description: "Transaction hash to verify on blockchain",
          },
          network: {
            type: "string",
            enum: ["mainnet", "testnet"],
            description: "Bitcoin network (default: testnet)",
          },
        },
        required: [],
      },
    },

    {
      name: "connect_btc_wallet",
      description:
        "Connect a BTC wallet and retrieve the user's Bitcoin address. This is the first step for any BTC operation. The frontend will show a wallet selection modal (Xverse, Unisat, Leather) and return the connected address. Call this when the user wants to connect their BTC wallet, send BTC, or before any BTC-related action.",
      inputSchema: {
        type: "object" as const,
        properties: {
          wallet_type: {
            type: "string",
            enum: ["xverse", "unisat", "leather"],
            description: "Optional: Preferred wallet type. If not specified, user can choose from available wallets.",
          },
          reason: {
            type: "string",
            description: "Reason for connecting the wallet (default: 'BTC operations')",
          },
        },
        required: [],
      },
    },

    {
      name: "send_btc_transfer",
      description:
        "Send a Bitcoin transfer to a specified address. Requires a connected BTC wallet. The frontend will prompt the user to confirm and sign the transaction in their wallet. Returns the transaction hash upon success. Call this after connect_btc_wallet returns the from_address.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to_address: {
            type: "string",
            description: "The recipient's Bitcoin address",
          },
          amount_btc: {
            type: "string",
            description: "Amount of BTC to send (e.g., '0.001')",
          },
          from_address: {
            type: "string",
            description: "Optional: Sender's BTC address (if already connected)",
          },
          wallet_type: {
            type: "string",
            description: "Optional: Wallet type used (xverse, unisat, leather)",
          },
          memo: {
            type: "string",
            description: "Optional: Memo or note for the transaction",
          },
          network: {
            type: "string",
            enum: ["mainnet", "testnet"],
            description: "Bitcoin network (default: testnet)",
          },
        },
        required: ["to_address", "amount_btc"],
      },
    },

    {
      name: "prepare_stake_btc",
      description:
        "Prepare BTC staking transaction after x402 payment is complete and BTC wallet is connected. Call this when user confirms they want to send BTC to the staking address. Returns STAKE_BTC intent for frontend to show deposit card.",
      inputSchema: {
        type: "object" as const,
        properties: {
          deposit_address: {
            type: "string",
            description: "The BTC deposit address for staking",
          },
          amount: {
            type: "string",
            description: "Amount of BTC to stake (e.g., '0.001')",
          },
          intent_id: {
            type: "string",
            description: "The intent ID from the x402 payment",
          },
        },
        required: ["deposit_address", "amount", "intent_id"],
      },
    },

    {
      name: "apply_add_custody_address",
      description:
        "Add a BTC custody address and mint BTCvc tokens via Vishwa's x402 payment service. This requires TWO steps: (1) User provides BTC address and pays $0.5 USDC service fee on Base network via x402 protocol, (2) After payment confirmation, the custody address is added and BTCvc is minted to the vault. First call returns payment requirements and address input UI; second call with payment_header completes the process.",
      inputSchema: {
        type: "object" as const,
        properties: {
          btc_address: {
            type: "string",
            description: "The BTC address to add as custody address (e.g., 'bc1q...' or '1A...'). Optional on first call if user hasn't provided it yet.",
          },
          network: {
            type: "string",
            enum: ["mainnet", "testnet"],
            description: "Bitcoin network (default: mainnet)",
          },
          expiry_minutes: {
            type: "number",
            description: "Minutes until expiration (default: 60)",
          },
          payment_header: {
            type: "string",
            description: "Optional: x402 payment header/proof after paying $0.5 USDC (obtained from payment transaction). Required for the second call.",
          },
          intent_id: {
            type: "string",
            description: "Optional: The intent ID from the first call. Required when providing payment_header.",
          },
        },
        required: [],
      },
    },

    // ─── Canton Tools (Coordination Layer) ──────────────────────

    {
      name: "canton_health",
      description:
        "Check if the Canton participant node is reachable. Canton is the privacy-preserving coordination layer that records multi-party settlement agreements and ZK attestations. Call this before using other Canton tools.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "query_attestations",
      description:
        "Query active CustodyAttestation contracts on Canton. Each attestation is a dual-signed (custodian + asset holder) record proving that an EVM balance or staking position exists, backed by a RISC0 ZK proof. Returns attestation details including chain, claim type, proof hash, and expiry.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "query_settlements",
      description:
        "Query pending CrossChainSettlement contracts on Canton. Each settlement defines terms agreed by buyer, seller, and custodian: token, amount, required chain, and required attestation type. Settlements are executed on EVM via VAEB after verification.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "prepare_settlement",
      description:
        "Prepare a Canton settlement for VAEB execution. Reads the settlement terms from Canton, finds a matching valid attestation, and returns VAEB-compatible actions for create_intent. After calling this, use create_intent with the returned vaebActions, get user signature, then execute_intent.",
      inputSchema: {
        type: "object" as const,
        properties: {
          settlement_id: {
            type: "string",
            description: "Canton contract ID of the CrossChainSettlement to execute",
          },
        },
        required: ["settlement_id"],
      },
    },
  ];
}
