Context
The Verified Agent Execution Bundle (VAEB) is a standalone, composable infrastructure layer that any AI agent can use whenever it needs to touch on-chain assets. 
Every agent-initiated on-chain action requires four things that are currently solved independently but should be a single atomic unit.
VAEB fuses these into a single bundle: 
- Discover via MCP
- Evaluate trust via ERC-8004
- Pay via x402
- Verify-and-execute via ERC-8150 
- Post reputation back to ERC-8004
This content is only supported in a Lark Docs
Architecture
┌────────────────────────────────────────────────────────────────────────┐
│                        ANY AI AGENT / APPLICATION                      │
│  (Claude, GPT, custom agent SDK, A2A peer, autonomous trading bot)    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                             MCP (JSON-RPC)
                          tool discovery + invocation
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                         VAEB MCP SERVER                                │
│                    (@vaeb/mcp-agent-execution)                         │
│                                                                        │
│  ┌───────────┐ ┌────────────┐ ┌────────────┐ ┌─────────┐ ┌──────────┐│
│  │Chain Tools│ │Intent Tools│ │Verify Tools│ │Pay Tools│ │Trust     ││
│  │           │ │            │ │            │ │         │ │Tools     ││
│  │read_balance│ │create_intent│ │prove_intent│ │(x402   │ │(ERC-8004)││
│  │read_token │ │sign_intent │ │verify_proof│ │ handled │ │          ││
│  │read_nft   │ │add_action  │ │check_nonce │ │ at HTTP │ │discover  ││
│  │get_price  │ │set_expiry  │ │            │ │ layer)  │ │ _agents  ││
│  │estimate_gas│ │            │ │            │ │         │ │get_rep   ││
│  │get_receipt│ │            │ │            │ │         │ │post_     ││
│  │           │ │            │ │            │ │         │ │ feedback ││
│  └───────────┘ └────────────┘ └────────────┘ └─────────┘ └──────────┘│
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Settlement Rail Router                       │   │
│  │                                                                 │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────┐ ┌────────┐  │   │
│  │  │   Base   │ │ Ethereum │ │  Solana  │ │Polygon│ │Arbitrum│  │   │
│  │  │  (EVM)   │ │  (EVM)   │ │  (SVM)   │ │ (EVM) │ │ (EVM)  │  │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────┘ └────────┘  │   │
│  │                                                                 │   │
│  │  x402 Schemes:  exact │ upto │ stream │ deferred               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    ERC-8150 Execution Engine                     │   │
│  │                                                                 │   │
│  │  IntentBundle ──→ ZK Prover ──→ AgentWallet.executeWithProof() │   │
│  │                                                                 │   │
│  │  Private witness: user intent + derivation logic                │   │
│  │  Public inputs: commitment, chain, signer, calldata hash       │   │
│  │  On-chain: verify proof → check signature → atomic execute     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    ERC-8004 Trust Engine                         │   │
│  │                                                                 │   │
│  │  ┌─────────────────┐ ┌──────────────────┐ ┌─────────────────┐  │   │
│  │  │ Identity        │ │ Reputation       │ │ Validation      │  │   │
│  │  │ Registry        │ │ Registry         │ │ Registry        │  │   │
│  │  │                 │ │                  │ │                 │  │   │
│  │  │ register()      │ │ giveFeedback()   │ │ validationReq() │  │   │
│  │  │ getMetadata()   │ │ getSummary()     │ │ validationRes() │  │   │
│  │  │ ERC-721 NFT IDs │ │ score + tags     │ │ ZK/TEE/staker   │  │   │
│  │  └─────────────────┘ └──────────────────┘ └─────────────────┘  │   │
│  │                                                                 │   │
│  │  Trust Loop: discover → evaluate → execute → feedback → validate│  │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
MCP: Discovery & Interface
MCP is the front door. Any AI agent (Claude answering a user's question, an autonomous trading bot, or another agent in an A2A network) can discover VAEB's capabilities through standard MCP tool listings. The agent doesn't need to know about Ethereum ABIs, Solana program IDs, or x402 headers. It just sees tools like create_intent, execute_intent, read_balance. It solely handles:
- Tool discovery (what can I do?)
- Input/output schema (what parameters does this need?)
- Transport (stdio for local, HTTP+SSE for remote/cloud)
- Context passing (which wallet, which chain, which user?)
x402: Payment for Services
x402 handles economics. Every tool call that consumes resources (proof generation, RPC queries, real-time data, gas subsidization) is monetized at the HTTP layer via x402's paidTools pattern. x402 is not just how the agent pays for VAEB's services. It is also one of the settlement rails the agent can use for the on-chain operation itself. This creates a two-tier payment model:
This content is only supported in a Lark Docs
This separation is critical: 
- The agent pays VAEB a small service fee via x402 to generate the ZK proof and submit the transaction. 
- The user's funds flow through ERC-8150's verified execution path on whatever chain the user prefers.
Our ERC-8150: Verified Execution
1. The user signs an IntentBundle (a high-level description of what they want (e.g., "swap 100 USDC for ETH on Uniswap, max slippage 0.5%"))
2. The agent derives the exact calldata (router address, function selector, encoded parameters)
3. A ZK-SNARK proves the derivation is faithful to the signed intent
4. The user's AgentWallet verifies the proof on-chain and executes atomically
This means the agent can handle arbitrary complexity (multi-hop swaps, cross-protocol interactions, batch operations) while the user only needs to understand and sign a simple intent.
We handle the payment first as the CallData is the simplest.
ERC-8004: Reputation
ERC-8004 can answer: 
- which agent should the user delegate to in the first place? 
- And after execution: was the agent's route selection actually good, or did it pick a worse price?
ERC-8004's three on-chain registries:
- Identity Registry: Every VAEB agent (prover node, settlement router, optimizer) registers as an ERC-721 NFT with metadata pointing to an off-chain agent card (capabilities, supported chains, pricing, SLA). Users and other agents discover agents by browsing or querying the registry, not by hardcoding addresses.
Agent Registration:
  IdentityRegistry.register(
    tokenURI: "ipfs://Qm.../agent-card.json",
    metadata: [
      { key: "agentName",       value: "VAEB-Prover-Base-01" },
      { key: "supportedChains", value: "base,ethereum,arbitrum" },
      { key: "proofType",       value: "groth16" },
      { key: "avgProofTime",    value: "3200ms" },
      { key: "x402Pricing",     value: "0.02 USDC per proof" }
    ]
  ) → agentId: 42 (ERC-721 NFT)
- Reputation Registry: After every VAEB execution, the system automatically posts structured feedback. The feedbackAuth mechanism (EIP-191 / ERC-1271 signatures) prevents spam: only parties who actually interact with the agent can post feedback.
Post-execution feedback:
  ReputationRegistry.giveFeedback(
    agentId: 42,
    score: 9,                          // 0-10 scale
    tag1: "execution_speed",           // categorization
    tag2: "swap",                      // operation type
    fileuri: "ipfs://Qm.../receipt.json",  // detailed evidence
    filehash: keccak256(receipt),
    feedbackAuth: <agent-signed authorization>
  )

  receipt.json = {
    intent_id: "int_abc123",
    proof_generation_time_ms: 2850,
    gas_used: 245000,
    price_improvement_vs_baseline: "+0.12%",
    slippage_actual: 0.003,
    settlement_chain: "base",
    x402_fee_paid: "0.02 USDC",
    erc8150_proof_verified: true,
    timestamp: 1739400000
  }
Validation Registry: For high-value operations, the ZK proof verification itself becomes a validation record. Each successful executeWithProof() generates a validation that an independent verifier (a staker, a ZK re-verifier, a TEE oracle) can confirm. This creates a cryptographic audit trail linking ERC-8150 proofs to ERC-8004 validation history.
After ERC-8150 execution succeeds:
  ValidationRegistry.validationRequest(
    validatorAddress: 0xZKReVerifier,
    agentId: 42,
    requestUri: "ipfs://Qm.../proof-bundle.json",
    requestHash: keccak256(proof + publicInputs + txHash)
  )

Independent verifier re-checks the proof:
  ValidationRegistry.validationResponse(
    requestHash: keccak256(...),
    response: 1,                   // 1 = valid, 0 = invalid
    responseUri: "ipfs://Qm.../verification.json",
    responseHash: keccak256(verification),
    tag: "zk_proof_verified"
  )
How ERC-8004 Changes Agent Selection
With ERC-8004, the VAEB MCP server can automatically select the best available agent:
User calls: vaeb.create_intent({ actions: [...], chain: "base" })
         │
         ▼
VAEB internally:
  1. Query IdentityRegistry for agents with metadata:
     supportedChains contains "base" AND proofType = "groth16"
     → returns agentIds: [42, 78, 115, 203]

  2. Query ReputationRegistry.getSummary() for each:
     Agent 42:  avg score 9.2 / 10, 1,847 feedbacks, tag "swap"
     Agent 78:  avg score 8.7 / 10, 423 feedbacks, tag "swap"
     Agent 115: avg score 6.1 / 10, 89 feedbacks, tag "swap"
     Agent 203: avg score 9.5 / 10, 12 feedbacks, tag "swap" (too new)

  3. Query ValidationRegistry.getSummary() for each:
     Agent 42:  412 validations, 100% pass rate
     Agent 78:  98 validations, 99% pass rate
     Agent 115: 22 validations, 91% pass rate (concerning)
     Agent 203: 3 validations, 100% pass rate (too few)

  4. Score = f(reputation_avg, reputation_count, validation_rate, validation_count)
     → Select Agent 42 (highest composite trust score)

  5. Route intent to Agent 42 for proof generation
Trust-Tiered Autonomy
ERC-8004 reputation scores directly control how much autonomy an agent gets within the ERC-8150 framework:
This content is only supported in a Lark Docs
These tiers are enforced in the ZK circuit. The user signs a policy that references minimum reputation thresholds:
Pre-authorization policy (with reputation gate):
{
  "auto_approve": {
    "SWAP": {
      "max_amount_per_tx": 500,
      "min_agent_reputation": 7.0,          // ← ERC-8004 check
      "min_agent_validations": 100,         // ← ERC-8004 check
      "min_agent_validation_rate": 0.95     // ← ERC-8004 check
    }
  }
}
Settlement Rail Router
The Settlement Rail Router is what makes this bundle chain-agnostic. When an agent constructs an on-chain operation, it specifies the desired chain (or lets the router choose optimally). The router handles:
Agent requests: "Swap 100 USDC → ETH"
         │
         ▼
Router evaluates available rails:
         │
         ├── Base:     gas ~$0.001, finality ~2s, USDC native
         ├── Ethereum:  gas ~$2.50,  finality ~12s, deepest liquidity
         ├── Arbitrum:  gas ~$0.01,  finality ~250ms, Uniswap v3
         ├── Polygon:   gas ~$0.005, finality ~2s, QuickSwap
         └── Solana:    gas ~$0.0003, finality ~400ms, Jupiter
         │
         ▼
Router selects based on:
  • User preference (set in config)
  • Liquidity depth for this specific pair
  • Gas cost vs. transaction value ratio
  • Finality requirements
  • Where the user's AgentWallet is deployed
         │
         ▼
ERC-8150 execution on selected rail
How ERC-8150 Adapts Across Rails

On EVM chains (Base, Ethereum, Arbitrum, Polygon), ERC-8150 works natively: the AgentWallet contract with executeWithProof(). The ZK verifier (Groth16) runs as a precompile or library call.
On non-EVM chains (Solana), the equivalent is:

- AgentWallet → a Solana program (Anchor-based) with execute_with_proof instruction
- ZK verifier → Groth16 verification via Solana's alt_bn128 syscalls or a dedicated verifier program
- IntentBundle → same structure, serialized as Borsh instead of ABI-encoded
- x402 settlement → uses SVM exact scheme (SPL token transfers) instead of EVM scheme
The MCP tool interface remains identical regardless of the underlying chain. The agent calls execute_intent({ chain: "solana", ... }) and the router handles the translation.
x402 Payment Scheme Selection
The router also selects the appropriate x402 payment scheme for the service fee:
Scheme
When to Use
Example
exact
One-shot operations with known cost
"Generate ZK proof for this intent" → 0.05 USDC
upto
Operations with variable cost
"Execute this swap and subsidize gas" → up to 0.10 USDC
stream
Continuous operations
"Monitor this position and auto-redeem on resolution" → 0.001 USDC/hour
deferred
Batch operations, subscription-like
"Process all my intents today" → settle at end of day
End-to-End User Flow
One-Time Initial Setup
1. User (developer, agent operator, or end user)
         │
         ▼
2. Install VAEB MCP server
         │
         ▼
3. Configure in MCP client (Claude Desktop, agent framework, etc.):
  {
    "mcpServers": {
      "vaeb": {
        "command": "npx",
        "args": ["-y", "@vaeb/mcp-agent-execution"],
        "env": {
          "WALLET_PRIVATE_KEY": "0x...",
          "SUPPORTED_CHAINS": "base,ethereum,solana,arbitrum,polygon",
          "DEFAULT_CHAIN": "base",
          "X402_FACILITATOR": "https://x402.coinbase.com",
          "X402_MAX_SERVICE_FEE_PER_TX": "0.10",
          "X402_MAX_DAILY_SPEND": "5.00",
          "PROVER_ENDPOINT": "https://prover.vaeb.xyz",
          "REQUIRE_MANUAL_APPROVAL": "true"
        }
      }
    }
  }
         │
         ▼
4. VAEB auto-deploys AgentWallet (if not already deployed):
  • Detects chains in SUPPORTED_CHAINS
  • Deploys AgentWallet factory instance on each EVM chain
  • Creates equivalent program account on Solana
  • Registers agent public key in each wallet
         │
         ▼
5. Ready — agent can now execute verified on-chain operations
Semi-autonomous Agent Executes an On-Chain Operation
This flow is the same regardless of what the operation is — a swap, a stake, a prediction market bet, an NFT mint, a lending deposit, a bridge transfer. VAEB treats them all as "an intent to be verified and executed."
STEP 1: Agent Decides to Act
──────────────────────────────
AI Agent (e.g., autonomous portfolio manager) decides:
"I should swap 100 USDC → ETH because ETH is undervalued
 based on my analysis of on-chain metrics."
         │
         ▼
STEP 2: Agent Discovers VAEB Tools (MCP)
──────────────────────────────────────────
Agent's MCP client lists available tools from @vaeb/mcp-agent-execution:
  → create_intent, add_action, estimate_execution, execute_intent,
    read_balance, get_price, check_position, ...

Agent calls: vaeb.read_balance({
  chain: "base",
  token: "USDC",
  wallet: "agent-wallet"
})
  → Returns: { balance: 500.00, chain: "base" }

Agent calls: vaeb.get_price({
  pair: "ETH/USDC",
  chains: ["base", "ethereum", "arbitrum"]
})
  → Returns: {
      base: { price: 3245.50, dex: "Uniswap v3", liquidity: "12M" },
      ethereum: { price: 3245.80, dex: "Uniswap v3", liquidity: "89M" },
      arbitrum: { price: 3245.45, dex: "Uniswap v3", liquidity: "8M" }
    }
         │
         ▼
STEP 3: Agent Evaluates Trust (MCP → ERC-8004)
────────────────────────────────────────────────
Agent calls: vaeb.discover_agents({
  chain: "base",
  operation: "swap",
  min_reputation: 7.0
})
  → Queries IdentityRegistry for eligible agents
  → Queries ReputationRegistry.getSummary() for each
  → Queries ValidationRegistry.getSummary() for each
  → Returns: {
      recommended: {
        agent_id: 42,
        name: "VAEB-Prover-Base-01",
        reputation: { score: 9.2, feedbacks: 1847, validation_rate: 1.0 },
        pricing: "0.02 USDC per proof",
        avg_proof_time: "3.2s"
      },
      alternatives: [{ agent_id: 78, ... }, { agent_id: 203, ... }]
    }

Agent (or user) selects agent 42 for this operation.
         │
         ▼
STEP 4: Agent Constructs Intent (MCP → ERC-8150)
──────────────────────────────────────────────────
Agent calls: vaeb.create_intent({
  actions: [
    {
      type: "SWAP",
      from_token: "USDC",
      to_token: "ETH",
      amount: 100,
      max_slippage: 0.005,
      preferred_dex: "auto"
    }
  ],
  chain_preference: "cheapest_gas",
  expiry_minutes: 10
})

VAEB server internally:
  1. Routes to optimal chain (Base — cheapest gas, sufficient liquidity)
  2. Resolves DEX (Uniswap v3 on Base)
  3. Encodes swap calldata:
     - USDC.approve(Uniswap Router, 100e6)
     - Router.exactInputSingle({
         tokenIn: USDC, tokenOut: WETH,
         fee: 500, recipient: AgentWallet,
         amountIn: 100e6,
         amountOutMinimum: 0.03069e18  // (100 / 3245.50) * 0.995
       })
  4. Constructs IntentBundle:
     {
       version: "1.0",
       chainId: 8453,
       nonce: "0x7f3a...",
       expiry: <now + 10 min>,
       payer: "0xAgentWallet",
       actions: [{
         actionType: "SWAP",
         token: "0xUSDC",
         to: "0xUniswapRouter",
         amount: 100_000000
       }]
     }

Returns to agent:
  {
    intent_id: "int_abc123",
    chain: "base",
    estimated_output: "0.03079 ETH",
    estimated_gas: "$0.0012",
    service_fee: "0.02 USDC",
    requires_signature: true,
    human_readable: "Swap 100 USDC → ~0.0308 ETH on Uniswap (Base)"
  }
         │
         ▼
STEP 5: User Approves Intent (Human-in-the-Loop)
──────────────────────────────────────────────────
If REQUIRE_MANUAL_APPROVAL=true:
  Agent presents to user (in Claude UI, chat, notification, etc.):

  "I'd like to swap 100 USDC for ~0.0308 ETH on Base via Uniswap.
   Service fee: 0.02 USDC. Gas: ~$0.001. Approve?"

  User approves → wallet signs EIP-712 IntentBundle
  (MetaMask popup, WalletConnect, or embedded signer)

If REQUIRE_MANUAL_APPROVAL=false (autonomous mode):
  Agent's embedded signer auto-signs
  (only if user pre-authorized this action type + amount range)
         │
         ▼
STEP 6: VAEB Proves & Executes (x402 + ERC-8150)
──────────────────────────────────────────────────
Agent calls: vaeb.execute_intent({
  intent_id: "int_abc123",
  signature: "0xUserSig..."
})

  → x402 service fee triggered:
    VAEB server returns 402 Payment Required
    { scheme: "exact", amount: 20000, token: "USDC", network: "base" }
    Agent's x402 wallet auto-pays 0.02 USDC

  → VAEB server (now paid) proceeds:
    a. Sends IntentBundle + derivedCalldata to ZK Prover service
    b. Prover generates Groth16 proof (~2-5 seconds):
       Private witness: full IntentBundle + swap calldata derivation
       Public inputs: commitment, chainId=8453, signerAddress,
                      multicallDataHash, nonce, expiry
    c. Submits to AgentWallet on Base:
       AgentWallet.executeWithProof(proof, signature, publicInputs, calls)

  → On-chain (Base):
    1. ZK verifier: proof valid? ✓
    2. EIP-712 signature matches signer? ✓
    3. Nonce unused + not expired? ✓
    4. Atomic execute:
       USDC.approve(UniswapRouter, 100e6)
       UniswapRouter.exactInputSingle(...) → 0.03082 ETH to AgentWallet
    5. Nonce marked used

Returns to agent:
  {
    status: "executed",
    tx_hash: "0xabc...",
    chain: "base",
    output: { token: "ETH", amount: "0.03082" },
    gas_used: "$0.0011",
    service_fee_paid: "0.02 USDC"
  }
         │
         ▼
STEP 7: Post Reputation Feedback (ERC-8004)
────────────────────────────────────────────
VAEB server automatically posts to ReputationRegistry:
  giveFeedback(
    agentId: 42,
    score: 9,                     // based on execution quality metrics
    tag1: "execution_quality",
    tag2: "swap",
    fileuri: "ipfs://Qm.../execution-receipt.json",
    filehash: keccak256(receipt),
    feedbackAuth: <signed by user's AgentWallet>
  )

  // Receipt includes: proof time, gas efficiency, slippage vs estimate,
  // price improvement over baseline, successful verification

Optionally, request independent validation:
  ValidationRegistry.validationRequest(
    validatorAddress: 0xZKReVerifier,
    agentId: 42,
    requestUri: "ipfs://Qm.../proof-bundle.json",
    requestHash: keccak256(proof + publicInputs + txHash)
  )
         │
         ▼
STEP 8: Agent Confirms to User
──────────────────────────────
Agent: "Swapped 100 USDC → 0.03082 ETH on Base.
        Tx: 0xabc... | Gas: $0.001 | Service fee: $0.02
        Agent 42 reputation: 9.2 → updated with this execution."
Autonomous Agent (No Human-in-the-Loop)
For fully autonomous agents (trading bots, yield optimizers, rebalancers), the user pre-authorizes a set of action types and limits:
Pre-authorization config (set once during setup):
{
  "auto_approve": {
    "SWAP": {
      "max_amount_per_tx": 500,
      "max_daily_amount": 2000,
      "allowed_tokens": ["USDC", "ETH", "WBTC"],
      "allowed_dexes": ["uniswap", "curve"],
      "max_slippage": 0.01
    },
    "STAKE": {
      "max_amount_per_tx": 1000,
      "allowed_protocols": ["lido", "rocketpool"],
      "max_daily_amount": 5000
    },
    "TRANSFER": false   // never auto-approve transfers
  }
}
The ERC-8150 ZK circuit enforces these limits. The circuit has additional constraints:
// In the ZK circuit, beyond standard ERC-8150 checks:
signal input autoApprovePolicy[MAX_POLICY_SIZE];
signal input actionAmount;
signal input dailySpentSoFar;

// Constraint: amount within single-tx limit
actionAmount <= autoApprovePolicy[ACTION_TYPE].max_amount_per_tx;

// Constraint: daily aggregate within limit
(dailySpentSoFar + actionAmount) <= autoApprovePolicy[ACTION_TYPE].max_daily_amount;

// Constraint: token is in allowed list
tokenInAllowedList(action.token, autoApprovePolicy[ACTION_TYPE].allowed_tokens) === 1;
This means even an autonomous agent operating without human approval is cryptographically constrained to the user's pre-authorized policy. If the agent tries to exceed limits, the ZK proof will not verify and the AgentWallet will reject the transaction.
End-to-End Fund Flow
Service Fee Flow (x402): Payment from the agent (or agent operator) to VAEB for infrastructure services.
Agent's x402 Wallet                VAEB Server                   x402 Facilitator
(funded by agent operator)         (earns fees)                  (Coinbase CDP / self-hosted)
        │                               │                               │
        │  MCP tool call                │                               │
        │─────────────────────────────→ │                               │
        │                               │                               │
        │  HTTP 402 + PAYMENT-REQUIRED  │                               │
        │  { scheme: "exact",           │                               │
        │    amount: 20000,             │                               │
        │    token: "USDC",             │                               │
        │    network: "base",           │                               │
        │    recipient: "0xVAEB" }      │                               │
        │←─────────────────────────────│                               │
        │                               │                               │
        │  Signs EIP-712 payment        │                               │
        │                               │                               │
        │  Retry + X-PAYMENT header     │                               │
        │─────────────────────────────→ │                               │
        │                               │  POST /verify                 │
        │                               │─────────────────────────────→ │
        │                               │  ✓ valid                      │
        │                               │←─────────────────────────────│
        │                               │                               │
        │                               │  POST /settle                 │
        │                               │─────────────────────────────→ │
        │                               │  0.02 USDC: Agent → VAEB      │
        │                               │  tx: 0x...                    │
        │                               │←─────────────────────────────│
        │                               │                               │
        │  Tool result returned         │                               │
        │←─────────────────────────────│                               │
User Transaction Flow (ERC-8150): the actual user's funds movement
User's AgentWallet              Target Protocol              Blockchain
(holds user's assets)           (Uniswap, Aave, etc.)       (Base, ETH, Solana, etc.)
        │                               │                           │
        │                               │                           │
  ┌─────┴──────────────────────────────────────────────────────┐    │
  │  executeWithProof(proof, signature, publicInputs, calls)   │    │
  │                                                            │    │
  │  1. Verify ZK proof                                        │    │
  │     → proof matches publicInputs? ✓                        │    │
  │  2. Verify signature                                       │    │
  │     → EIP-712 sig from owner? ✓                            │    │
  │  3. Check nonce                                            │    │
  │     → nonce unused? ✓                                      │    │
  │  4. Check expiry                                           │    │
  │     → block.timestamp < expiry? ✓                          │    │
  │  5. Execute calls atomically:                              │    │
  └────┬───────────────────────────────────────────────────────┘    │
       │                                                            │
       │  call[0]: USDC.approve(UniswapRouter, 100e6)               │
       │─────────────────────────→  │                               │
       │  ✓                         │                               │
       │                            │                               │
       │  call[1]: Router.exactInputSingle(...)                     │
       │─────────────────────────→  │                               │
       │                            │  100 USDC → 0.0308 ETH       │
       │  ← 0.0308 ETH             │─────────────────────────────→ │
       │                            │                     settled   │
       │                                                            │
  AgentWallet now holds:                                            │
    previous ETH + 0.0308 ETH                                      │
    previous USDC - 100 USDC                                        │
Combined Flow:
┌──────────────────┐
│  Agent Operator   │  Funds the agent's x402 wallet (once, small amount)
│  (or user)        │  e.g., deposit 10 USDC for ~500 tool calls
└────────┬─────────┘
         │
    fund x402 wallet
         │
         ▼
┌──────────────────┐     x402 service fee      ┌──────────────────┐
│  Agent's x402    │ ─────(0.02 USDC)────────→ │  VAEB Treasury   │
│  Wallet          │     per operation          │  (revenue)       │
│  (Base, USDC)    │                            └──────────────────┘
└──────────────────┘

┌──────────────────┐
│  User's EOA      │  Funds the AgentWallet (user's own assets)
│                   │  e.g., 1000 USDC + 2 ETH for trading
└────────┬─────────┘
         │
    deposit to AgentWallet
    (on any supported chain)
         │
         ▼
┌──────────────────┐   ERC-8150 verified     ┌──────────────────┐
│  User's          │   execution             │  Target Protocol  │
│  AgentWallet     │ ──────────────────────→ │  (Uniswap, Aave, │
│  (Base/ETH/etc.) │                         │   Polymarket...)  │
│                   │ ←─── output tokens ──── │                  │
└──────────────────┘                         └──────────────────┘

KEY INVARIANT:
  The agent's x402 wallet and the user's AgentWallet are SEPARATE.
  VAEB's service fees never touch user funds.
  User funds only move through ERC-8150 verified execution.
End-to-End Data Flow
┌─────────┐  natural language   ┌──────────┐   MCP JSON-RPC    ┌──────────────┐
│ Human   │ ──────────────────→ │ AI Agent │ ─────────────────→ │ VAEB MCP     │
│ User    │                     │ (Claude, │                    │ Server       │
│         │ ← natural language  │  GPT,    │ ← MCP response    │              │
└─────────┘                     │  custom) │                    │              │
                                └──────────┘                    └──────┬───────┘
                                                                       │
                                                    ┌──────────────────┼──────────────────┐
                                                    │                  │                  │
                                              ┌─────▼─────┐    ┌──────▼──────┐    ┌──────▼──────┐
                                              │ Chain      │    │ Intent      │    │ Settlement  │
                                              │ Abstraction│    │ Engine      │    │ Rail Router │
                                              │ Layer      │    │ (ERC-8150)  │    │             │
                                              └─────┬──────┘    └──────┬──────┘    └──────┬──────┘
                                                    │                  │                  │
                                              ┌─────▼──────┐    ┌─────▼──────┐    ┌──────▼──────┐
                                              │ Multi-chain│    │ ZK Prover  │    │ x402        │
                                              │ RPC Pool   │    │ Service    │    │ Facilitator │
                                              │            │    │            │    │ (Coinbase/  │
                                              │ Base  ─────│    │ Groth16    │    │  self-host) │
                                              │ Ethereum ──│    │ ~2-5s per  │    │             │
                                              │ Solana ────│    │ proof      │    │ Verify +    │
                                              │ Arbitrum ──│    │            │    │ Settle      │
                                              │ Polygon ───│    │            │    │             │
                                              └────────────┘    └────────────┘    └─────────────┘
Step-by-step
PHASE 1: DISCOVERY (MCP + ERC-8004 layer)
──────────────────────────────────────────
[Agent]
  │
  │  MCP: tools/list
  │─────────────────────────→ [VAEB MCP Server]
  │                                   │
  │  Available tools:                 │
  │  - create_intent                  │
  │  - execute_intent                 │
  │  - read_balance                   │
  │  - discover_agents      ← NEW     │
  │  - get_agent_reputation ← NEW     │
  │  - post_feedback        ← NEW     │
  │  - ...25 total tools              │
  │←─────────────────────────────────│
  │
  │  MCP: tools/call { read_balance }
  │─────────────────────────→ [VAEB] ──→ [RPC: Base] ──→ [USDC contract]
  │                                                          │
  │  { balance: 500 USDC }                                   │
  │←─────────────────────────────────────────────────────────│
  │
  │  MCP: tools/call { discover_agents, chain: "base", op: "swap" }
  │─────────────────────────→ [VAEB] ──→ [IdentityRegistry]
  │                                  ──→ [ReputationRegistry]
  │                                  ──→ [ValidationRegistry]
  │                                          │
  │  { recommended: { agent_id: 42,          │
  │    score: 9.2, validations: 412 } }      │
  │←─────────────────────────────────────────│


PHASE 2: INTENT CONSTRUCTION (ERC-8150 layer)
──────────────────────────────────────────────
[Agent]
  │
  │  MCP: tools/call { create_intent, actions: [...] }
  │─────────────────────────→ [VAEB]
  │                              │
  │                              ├──→ [Settlement Router]
  │                              │     "Which chain is optimal?"
  │                              │     → evaluates gas, liquidity, finality
  │                              │     → selects: Base
  │                              │
  │                              ├──→ [Chain Abstraction]
  │                              │     "Encode calldata for Base + Uniswap"
  │                              │     → USDC.approve(...) + Router.swap(...)
  │                              │
  │                              ├──→ [Intent Engine]
  │                              │     "Construct IntentBundle"
  │                              │     → { version, chainId, nonce, expiry,
  │                              │        payer, actions }
  │                              │
  │  { intent_id, human_readable,│
  │    estimated_output,         │
  │    requires_signature: true }│
  │←─────────────────────────────│


PHASE 3: APPROVAL (User ↔ Agent)
─────────────────────────────────
[Agent] → [User]: "Swap 100 USDC → 0.0308 ETH on Base. Approve?"
[User] → [Wallet]: signs EIP-712 IntentBundle
[Wallet] → [Agent]: signature 0x...


PHASE 4: EXECUTION (x402 + ERC-8150 layers)
─────────────────────────────────────────────
[Agent]
  │
  │  MCP: tools/call { execute_intent, intent_id, signature }
  │─────────────────────────→ [VAEB]
  │                              │
  │  ←── HTTP 402 ──────────────│  (x402 service fee required)
  │                              │
  │  ──── X-PAYMENT ───────────→│
  │                              │
  │                              ├──→ [x402 Facilitator]
  │                              │     verify + settle service fee
  │                              │     0.02 USDC: Agent → VAEB
  │                              │
  │                              ├──→ [ZK Prover Service]
  │                              │     input: IntentBundle + derivedCalldata
  │                              │     output: Groth16 proof (2-5 sec)
  │                              │
  │                              ├──→ [Base RPC]
  │                              │     AgentWallet.executeWithProof(
  │                              │       proof, signature,
  │                              │       publicInputs, calls
  │                              │     )
  │                              │
  │                              │     ON-CHAIN:
  │                              │       1. verify ZK proof ✓
  │                              │       2. verify signature ✓
  │                              │       3. check nonce + expiry ✓
  │                              │       4. atomic execute:
  │                              │          USDC.approve → Router.swap
  │                              │       5. mark nonce used
  │                              │
  │  { status: "executed",       │
  │    tx_hash: "0x...",         │
  │    output: "0.0308 ETH" }   │
  │←─────────────────────────────│


PHASE 5: POST-EXECUTION (MCP layer)
─────────────────────────────────────
[Agent]
  │
  │  MCP: tools/call { get_receipt, tx_hash: "0x..." }
  │─────────────────────────→ [VAEB] ──→ [Base RPC]
  │                                          │
  │  { confirmed: true, block: 12345,        │
  │    gas_used: 245000, events: [...] }     │
  │←─────────────────────────────────────────│
  │
  │  → [User]: "Done. 100 USDC → 0.0308 ETH. Tx: 0x..."


PHASE 6: REPUTATION FEEDBACK (ERC-8004 layer)
──────────────────────────────────────────────
[VAEB Server] (automatic, post-execution)
  │
  │  Compute execution quality score:
  │    proof_time: 2.8s (good) → +2
  │    gas_efficiency: 98th percentile → +2
  │    slippage: 0.3% vs 0.5% max → +2
  │    price vs baseline: +0.12% → +1.5
  │    proof verified on-chain: yes → +1.5
  │    composite score: 9 / 10
  │
  ├──→ [ReputationRegistry.giveFeedback()]
  │     agentId: 42, score: 9,
  │     tags: ("execution_quality", "swap")
  │     evidence: IPFS receipt with x402 payment proof
  │
  └──→ [ValidationRegistry.validationRequest()]
        (optional, for high-value txs)
        validator: 0xIndependentZKVerifier
        evidence: proof + publicInputs + txHash
                    │
                    ▼
[Independent Validator] (async, minutes to hours later)
  │
  │  Re-verifies ZK proof off-chain
  │  Confirms calldata matches intent commitment
  │
  └──→ [ValidationRegistry.validationResponse()]
        response: 1 (valid), tag: "zk_reverified"

Agent 42's on-chain reputation is now updated:
  feedbacks: 1847 → 1848
  avg score: 9.2 (maintained)
  validations: 412 → 413, 100% pass rate
[Optional] Selective Disclosure of Data
Data
Who Sees It
Who Does NOT See It
User's intent (high-level: "swap 100 USDC for ETH")
User, Agent, VAEB server
On-chain observers (hidden inside ZK proof)
Derived calldata (exact function calls)
VAEB server, ZK prover, on-chain (after execution)
—
ZK proof
On-chain verifier, VAEB server
—
User's EIP-712 signature
VAEB server, on-chain verifier
Other agents, x402 facilitator
x402 service fee payment
Agent, VAEB server, x402 facilitator, on-chain
—
Agent's x402 wallet balance
Agent operator, x402 facilitator
User, VAEB server
User's AgentWallet balance
User, on-chain (public)
—
Pre-authorization policy
User (signs it), ZK circuit (private witness)
Agent (only sees allowed/denied), VAEB, on-chain
Agent identity (ERC-8004)
Public (on-chain ERC-721)
—
Agent reputation scores
Public (on-chain, queryable)
—
Detailed feedback evidence
Feedback poster, IPFS readers
On-chain (only hash + score stored)
Validation results
Public (on-chain)
—
Agent selection reasoning
VAEB server (internal scoring)
User sees only the recommendation
The critical privacy property: the user's intent description is a private witness in the ZK proof. On-chain, observers see the executed calldata and the ZK proof that it was authorized, but they cannot reconstruct the human-readable intent from the proof. This prevents front-running based on intent analysis.
The critical trust property: reputation is non-forgeable. Only parties who received a feedbackAuth signature from the agent can post feedback (preventing Sybil attacks on reputation). Validation records are independently verifiable (ZK re-verification, TEE attestation, or staker confirmation)
Security Model
Trust Boundaries
┌────────────────────────────────────────────────────┐
│                    UNTRUSTED                        │
│                                                    │
│  ┌───────────┐  ┌────────────┐  ┌───────────────┐ │
│  │ AI Agent  │  │ VAEB Server│  │ ZK Prover     │ │
│  │ (may be   │  │ (may be    │  │ (may be       │ │
│  │  rogue)   │  │  compromised)│ │  compromised) │ │
│  └───────────┘  └────────────┘  └───────────────┘ │
│                                                    │
└────────────────────────────────────────────────────┘
                        │
           TRUST BOUNDARY (cryptographic + reputational)
                        │
┌────────────────────────────────────────────────────┐
│                    TRUSTED                          │
│                                                    │
│  ┌────────────────────────────────────────────┐    │
│  │ On-Chain AgentWallet (ERC-8150)            │    │
│  │  • ZK verifier: mathematically sound       │    │
│  │  • Signature check: user's key only        │    │
│  │  • Nonce: no replay                        │    │
│  │  • Expiry: time-bounded                    │    │
│  │  • Atomic execution: all-or-nothing        │    │
│  └────────────────────────────────────────────┘    │
│                                                    │
│  ┌────────────────────────────────────────────┐    │
│  │ On-Chain Registries (ERC-8004)             │    │
│  │  • Identity: non-forgeable agent IDs       │    │
│  │  • Reputation: auth-gated feedback only    │    │
│  │  • Validation: independent re-verification │    │
│  │  • Self-feedback blocked on-chain          │    │
│  │  • Request hash uniqueness enforced        │    │
│  └────────────────────────────────────────────┘    │
│                                                    │
│  ┌────────────────────────────────────────────┐    │
│  │ User's Wallet (holds signing key)          │    │
│  │  • Only entity that can authorize intents  │    │
│  └────────────────────────────────────────────┘    │
│                                                    │
│  ┌────────────────────────────────────────────┐    │
│  │ x402 Facilitator (Coinbase CDP)            │    │
│  │  • Can only move funds per signed payment  │    │
│  │  • Spending caps enforced client-side      │    │
│  └────────────────────────────────────────────┘    │
│                                                    │
└────────────────────────────────────────────────────┘
Edge Cases and Preventions
Failure
Impact
Preventions
Agent goes rogue
Cannot execute unauthorized operations
ZK proof must match user-signed intent; AgentWallet rejects invalid proofs
VAEB server compromised
Cannot steal funds or forge transactions
Server never holds user keys; can only submit proofs that the on-chain verifier validates
ZK prover generates false proof
Would allow unauthorized execution
Groth16 soundness: computationally infeasible to forge valid proofs without correct witness
x402 facilitator compromised
Could double-charge service fees
Service fee is capped by X402_MAX_SERVICE_FEE_PER_TX; user funds unaffected (separate flow)
Network outage on selected chain
Transaction not executed
Intent has expiry; user can re-try on different chain; nonce prevents stale execution
Agent submits stale intent
Replay of previously executed intent
Nonce system: each nonce can only be used once; invalidateNonceRange for bulk revocation
Sybil attack on reputation
Fake identities inflate agent scores
ERC-8004 feedbackAuth requires agent-signed authorization; only actual clients can post; self-feedback blocked on-chain
Reputation manipulation
Agent selectively allows feedback from satisfied clients
Feedback URI contains proof-of-payment (x402 receipt); validators can audit completeness; aggregation weights by tag
New agent with no history
Cannot evaluate trustworthiness
Trust-tiered autonomy: new agents start in "Untrusted" tier with manual approval and low limits until track record builds
Validator collusion
Independent validators rubber-stamp bad agents
Multiple validator quorum; validation scores weighted by validator's own reputation; diverse validator selection
Identity key compromise
Agent's ERC-721 transferred maliciously
ERC-721 transfer events are public; reputation is tied to agentId, not owner address; users can re-evaluate after ownership change
What's available to use
x402 Protocol & SDK
This content is only supported in a Lark Docs
ERC-8004 (Trustless Agents)
This content is only supported in a Lark Docs
ZK Tooling
This content is only supported in a Lark Docs
MCP SDK
This content is only supported in a Lark Docs
What Needs to Be Built
P1: Must-have for VAEB
This content is only supported in a Lark Docs
P2: ERC-8004 Integration
This content is only supported in a Lark Docs
Demo Polish
This content is only supported in a Lark Docs
Task Split 
@Justin Cheng : On-Chain + ZK
Smart contracts, ZK circuits, and the on-chain trust layer.
This content is only supported in a Lark Docs
Focuses on smart contracts, ZK circuits, and the on-chain trust layer.
Smart Contracts (ERC-8150)
[]  Set up Foundry project with forge init
[]  Implement IAgentWallet interface from ERC-8150 spec
[]  Implement AgentWallet.sol with executeWithProof() — signature verification, nonce management, expiry check, atomic multicall
[]  Implement AgentWalletFactory.sol — createWallet(owner, agent) using CREATE2 for deterministic addresses
[]  Write unit tests: valid proof execution, invalid proof rejection, nonce replay prevention, expired intent rejection
[]  Deploy AgentWallet + AgentWalletFactory to Base Sepolia
[]  Verify contracts on Basescan Sepolia
ZK Circuits (Circom + snarkjs)
[]  Install circom compiler + snarkjs
[]  Write IntentVerifier.circom — minimal circuit: hash(intentBundle) == commitment + payer == signer
[]  Add calldata derivation verification for TRANSFER action type
[]  Add calldata derivation verification for SWAP action type
[]  Run Powers of Tau trusted setup ceremony (use Hermez Phase 1)
[]  Generate circuit-specific Phase 2 contribution
[]  Export proving key (.zkey) and verification key (.vkey)
[]  Generate Solidity verifier via snarkjs zkey export solidityverifier
[]  Deploy ZKVerifier.sol to Base Sepolia
[]  Integrate verifier into AgentWallet.executeWithProof()
[]  Test end-to-end: construct intent → generate proof locally → submit → verify on-chain
[]  Benchmark proof generation time (target: <5s for 2-action bundle)
[]  Benchmark on-chain verification gas (target: ~210k gas)
ERC-8004 Trust Layer
[]  Write agent registration script using IdentityRegistry.register() on Base Sepolia (0x7177...09A)
[]  Set agent metadata: agentName, supportedChains, proofType, avgProofTime, x402Pricing
[]  Write reputation feedback script using ReputationRegistry.giveFeedback() on Base Sepolia (0xB504...322)
[]  Implement feedbackAuth signing (EIP-191 / ERC-1271)
[]  Test getSummary() reads after posting feedback
[]  Write validation request script using ValidationRegistry.validationRequest() on Base Sepolia (0x662b...6d8)
[]  Implement trust-tiered policy: read reputation score on-chain, gate auto-approval thresholds
[]  Test closed trust loop: execute → feedback → validate → reputation updated
Integration & Polish
[]  Help @Jenny Zhang  integrate contracts (provide ABIs + deployment addresses)
[]  Optimize gas across all contracts
[]  Document gas benchmarks in README
[]  Handle edge cases: zero-amount actions, max nonce, boundary expiry
[]  Final deployment to Base Sepolia with verified contracts
[]  Demo rehearsal: walk through on-chain flow
@Jenny Zhang "MCP Server + x402 + Demo"
Focuses on the MCP server, x402 integration, intent SDK, and the demo experience.
This content is only supported in a Lark Docs
Intent SDK (@vaeb/intent-sdk)
[]  Scaffold TypeScript package with tsconfig.json, exports
[]  Implement IntentBundle type definition matching ERC-8150 spec
[]  Implement Action type with actionType, token, to, amount
[]  Implement EIP-712 typed data construction for IntentBundle signing
[]  Implement bundle serialization / deserialization (JSON ↔ bytes)
[]  Implement nonce generation (random bytes32)
[]  Implement expiry calculation (current time + configurable minutes)
[]  Write unit tests for all SDK functions
[]  Export package for use by MCP server
MCP Server (@vaeb/mcp-server)
[]  Scaffold MCP server using @modelcontextprotocol/sdk
[]  Implement free tools: read_balance, get_price, estimate_gas, get_receipt
[]  Test free tools with Claude Desktop — verify tool discovery + invocation
[]  Implement create_intent tool — calls intent SDK, returns human-readable preview
[]  Implement execute_intent tool — accepts intent_id + signature, triggers proof + on-chain execution
[]  Implement simulate_intent tool — dry-run execution via eth_call
[]  Implement cancel_intent tool — invalidate nonce
[]  Wire prover service wrapper (call snarkjs locally or Sindri API)
[]  Test MCP → prover → on-chain pipeline end-to-end
x402 Integration
[]  Install x402-mcp package
[]  Set up Coinbase CDP facilitator account (free tier)
[]  Configure paidTools for execute_intent (0.01 USDC on Base Sepolia)
[]  Configure paidTools for simulate_intent (0.005 USDC)
[]  Test x402 payment flow: 402 → X-PAYMENT → verify → settle
[]  Configure spending caps in MCP server env
ERC-8004 Trust Tools
[]  Implement discover_agents tool — query IdentityRegistry, rank by ReputationRegistry score
[]  Implement get_agent_reputation tool — query ReputationRegistry.getSummary()
[]  Implement get_agent_validations tool — query ValidationRegistry
[]  Implement post_feedback tool — post feedback with execution quality metrics
[]  Implement compare_agents tool — side-by-side reputation comparison
Demo & Packaging
[]  Build end-to-end demo script: Claude → MCP → discover agent → create intent → sign → prove → execute → feedback
[]  Build demo UI (React): live visualization of VAEB flow — intent construction, ZK proof progress, on-chain tx, reputation update
[]  Record 3-minute demo video
[]  Package MCP server for npx @vaeb/mcp-server distribution
[]  Write README with setup instructions, architecture diagram, usage examples
[]  Demo rehearsal 
Hackathon Submission Checklist
This content is only supported in a Lark Docs