# VAEB Prize Strategy — ETHDenver 2026

## TL;DR

With **natural language intent processing** and **x402 payment gating**, VAEB targets **$52K across 7 prizes**: ADI ($19K), Base ($10K), Kite AI ($10K), 0g Labs ($7K), plus organizer tracks. The two new features unlock Kite AI (previously ineligible) and dramatically strengthen the Base "self-sustaining agent" narrative. Core crypto (ZK proofs, ERC-8150 wallet) is already production-quality — the work is in the product/presentation layer.

---

## Current State: Honest Audit

Before strategy, here's what's real and what's not:

| Component | Status | Verdict |
|-----------|--------|---------|
| AgentWallet.sol | Production-quality, no stubs, real ERC-8150 | **REAL** |
| ZK Circuit (IntentVerifier.circom) | Real constraints, 10,790, actual derivation verification | **REAL** |
| Groth16 proofs on-chain | Works end-to-end on Base Sepolia | **REAL** |
| Intent SDK | 13 passing tests, bundle creation/signing works | **REAL** |
| demo-zkproof.js | Deploys, proves, verifies, executes on-chain | **REAL** |
| demo/index.html | 100% simulated — fake txHashes, no wallet connection | **FAKE** |
| MCP server intent execution | Returns mock txHash, doesn't submit real txs | **STUBBED** |
| Prover service | Defaults to simulated mode, generates fake proofs | **STUBBED** |
| Contract test suite | Zero Solidity tests (Foundry/Hardhat) | **MISSING** |
| Root README.md | Does not exist | **MISSING** |
| Demo video | Does not exist | **MISSING** |

**Bottom line:** The cryptographic core is genuinely strong. But the presentation layer, integration layer, and developer experience have significant gaps that judges will notice.

---

## Product Requirements

Two new features transform VAEB from "cool ZK infrastructure" into a complete product with an economic loop. Both are needed to maximize the prize map.

### Feature 1: Natural Language Intent Processing

**What:** User types plain English → agent interprets, constructs intent, generates ZK proof, executes on-chain.

**Why it matters:** Right now the demo hardcodes "transfer 100 USDC to 0xdead." The agent makes zero decisions. With NL processing, the agent becomes a real AI — it reasons about what the user wants, resolves addresses, compares execution strategies, and acts.

**User flow:**
```
User: "Send 100 USDC to alice.eth"
  → Agent resolves alice.eth via ENS
  → Agent constructs IntentBundle (TRANSFER, 100 USDC, 0x...)
  → Agent generates Groth16 proof
  → Agent submits executeWithProof()
  → User sees BaseScan link + confirmation
```

**Requirements:**
- [ ] MCP `create_intent` tool accepts natural language description as input
- [ ] Agent parses NL into structured action (action type, token, amount, recipient)
- [ ] Agent resolves ENS names and token symbols to addresses
- [ ] Agent handles ambiguity by asking clarifying questions via MCP
- [ ] Support at minimum: TRANSFER ("send X to Y") and SWAP ("swap X for Y")
- [ ] Agent explains what it's about to do before requesting user signature
- [ ] Error messages are human-readable, not raw revert data

**Stretch goals:**
- [ ] Agent compares DEX quotes for SWAP actions (Uniswap vs Sushiswap)
- [ ] Agent suggests optimal gas timing
- [ ] Agent handles multi-step intents ("swap USDC to ETH, then stake the ETH")

**Prize impact:**
- 0g Labs: directly satisfies "AI meaningfully improves a DeFi workflow"
- Base: makes the agent visibly autonomous and intelligent
- Futurllama: demonstrates frontier AI+crypto integration

---

### Feature 2: x402 Payment Protocol

**What:** Agent services (proof generation, price feeds, intent execution) are gated behind HTTP 402 micropayments. The agent pays for services it consumes and charges users for services it provides — creating a self-sustaining economic loop.

**Why it matters:** Unlocks Kite AI prize ($10K) and transforms the Base "self-sustaining" narrative from hand-waving to a real revenue model. The agent isn't just executing — it's running a business.

**Economic loop:**
```
┌──────────────────────────────────────────────────────┐
│                  AGENT ECONOMY                       │
│                                                      │
│  User pays 0.05 USDC ──► Agent ──► executes intent   │
│                            │                         │
│                            ├── pays 0.02 USDC → Prover Service (x402)
│                            ├── pays 0.01 USDC → Price Oracle (x402)
│                            └── keeps 0.02 USDC profit
│                                                      │
│  Agent is self-sustaining: revenue > costs            │
└──────────────────────────────────────────────────────┘
```

**Requirements:**
- [ ] Prover service returns HTTP 402 with payment details when called without payment
- [ ] 402 response includes: price (in USDC), payment address, required headers
- [ ] Agent (MCP server) detects 402 responses and initiates on-chain payment
- [ ] Agent pays from AgentWallet using `executeDirectly()` (no ZK needed for service payments)
- [ ] After payment confirmed, agent retries the service call with payment proof header
- [ ] MCP server charges users a fee for `execute_intent` (bundled into the intent or separate)
- [ ] Health endpoint shows agent's revenue/cost balance

**Implementation approach:**
- Use Coinbase x402 SDK (`@coinbase/x402`) for the payment flow standard
- Prover service adds x402 middleware on `POST /prove`
- MCP server adds x402 client that handles 402 responses automatically
- Fee collection via a small surcharge on `execute_intent`

**Stretch goals:**
- [ ] Dashboard showing agent P&L (revenue from users - costs from services)
- [ ] Dynamic pricing based on proof complexity or gas costs
- [ ] Agent refuses unprofitable intents (cost > revenue)
- [ ] Multiple payment tokens supported (USDC, ETH)

**Prize impact:**
- Kite AI ($10K): directly satisfies "x402-powered agent payments" — moves from skip to strong fit
- Base ($10K): "self-sustaining" becomes literal — agent has a revenue model
- Blockade Labs ($2K): agent doesn't need external funding to operate

---

### Feature 3: Smart Payment Routing (Multi-Token Merchant Payments)

**What:** Merchant specifies accepted tokens (e.g. "only USDC and DAI"). User only has ETH. The agent automatically swaps the user's token to an accepted token and pays the merchant — all in one atomic ZK-verified transaction.

**Why it matters:** This is the feature that makes VAEB feel like a real product, not a protocol demo. Every judge understands "I want to pay a merchant but I have the wrong token." The agent solving this autonomously — choosing the best swap route, executing swap + transfer atomically, proving it all with ZK — is the clearest possible demonstration of AI + DeFi + ZK working together.

**User flow:**
```
Merchant: "Pay 50 USDC for coffee" (only accepts USDC, DAI)
User has: 0.02 ETH, 0 USDC

  → Agent checks user's token balances
  → Agent sees merchant accepts [USDC, DAI]
  → Agent finds best swap route: ETH → USDC via Uniswap
  → Agent constructs multi-action intent:
      Action 1: SWAP 0.02 ETH → ~50 USDC (approve + swap)
      Action 2: TRANSFER 50 USDC → merchant
  → Agent generates Groth16 proof for entire bundle
  → Single atomic tx: swap + pay (all-or-nothing)
  → Merchant receives USDC, user never touched a DEX
```

**Requirements:**
- [ ] MCP `create_intent` supports multi-action bundles (SWAP + TRANSFER in one intent)
- [ ] Agent queries merchant's accepted tokens (via MCP tool or parameter)
- [ ] Agent checks user's token balances across supported tokens
- [ ] Agent determines if a swap is needed (user token != accepted token)
- [ ] Agent finds swap route and estimates output amount (including slippage)
- [ ] Agent constructs atomic multi-call: approve → swap → transfer
- [ ] ZK circuit verifies the entire multi-action bundle (already supports up to 4 actions)
- [ ] Single `executeWithProof()` tx executes all calls atomically
- [ ] If any step fails (bad swap price, insufficient output), entire tx reverts

**Stretch goals:**
- [ ] Agent compares multiple swap routes and picks the cheapest
- [ ] Slippage protection with user-configurable tolerance
- [ ] Agent suggests splitting across DEXs for large amounts
- [ ] Merchant can specify a payment request via x402 (pay-to-access pattern)
- [ ] Receipt/confirmation sent back to merchant via webhook

**Prize impact:**
- ADI ($19K): directly hits the "$3K ADI Payments Component for Merchants" sub-prize
- 0g Labs ($7K): "AI meaningfully improves DeFi" — agent autonomously routes payments
- Base ($10K): real-world use case for autonomous agents on Base
- Kite AI ($10K): merchant payment via x402 request → agent pays → access granted

**Why this is the "holy shit" demo moment:**
A judge watches you say "pay merchant X 50 USDC" when you only have ETH. The agent figures out the swap, builds a multi-action intent, generates a ZK proof that covers both the swap AND the payment, and executes it atomically on Base Sepolia. One sentence in, one tx out, zero trust required. That's not a hackathon project — that's a product.

---

### Combined Product Vision

With all three features, VAEB's pitch becomes:

> "Tell an AI agent what you want in plain English. It figures out how to do it — even if that means swapping tokens first — proves it won't cheat with a ZK proof, pays for its own infrastructure with micropayments, and executes everything atomically on-chain. All without ever holding your keys."

**Updated prize map with all features:**

| Prize | Amount | Fit | Key narrative |
|-------|--------|-----|---------------|
| ADI — Open Project + Payments | $19,000 + $3,000 | Very Strong | ZK-verified AA wallet + merchant payment routing |
| Base — Autonomous Agents | $10,000 | Very Strong | Self-sustaining agent with x402 revenue loop |
| Kite AI — Agent Payments | $10,000 | Strong (NEW) | x402-powered agent economy + merchant payments |
| 0g Labs — DeFAI | $7,000 | Very Strong | NL → smart payment routing with ZK guardrails |
| Blockade Labs | $2,000 | Strong | Economically independent agent, no "home" needed |
| Futurllama (organizer) | $2,000 | Strong | Frontier AI+ZK+x402+payment routing |
| Devtopia (organizer) | $2,000 | Strong | SDK + MCP + prover as dev infrastructure |

**Total addressable: $55,000** (up from $52,000 — ADI Payments sub-prize now in play)

---

## What Needs to Happen (Priority Order)

### P0: MUST DO (without these, you lose)

#### 1. Working Frontend Demo with Wallet Connection
The demo/index.html is pure simulation. Judges will click buttons and see fake data. This is the #1 killer.

**Build a real interactive demo that:**
- Connects to MetaMask (Base Sepolia)
- Shows the user's wallet and AgentWallet balances
- Lets the user construct an intent (pick token, amount, recipient)
- Shows real proof generation progress
- Submits real `executeWithProof()` transaction
- Links to BaseScan after execution
- Shows before/after balances

**Tech:** Can stay as vanilla HTML+JS using ethers.js (already a dependency). Doesn't need React/Next. But must talk to real contracts.

**Effort:** ~4-6 hours

#### 2. Root README.md
First thing judges see on GitHub. No README = instant credibility hit.

**Must include:**
- One-paragraph project description
- Architecture diagram (can reuse from DEPLOY_AND_TEST.md)
- "How it works" section with the user→agent→contract flow
- Links to live contracts on BaseScan
- Screenshot or GIF of the working demo
- Quick start instructions
- Link to DEPLOY_AND_TEST.md for detailed setup

**Effort:** ~1 hour

#### 3. Demo Video (< 3 minutes)
Most prizes explicitly require this. Hedera says "video under 3 minutes." Even prizes that don't require it — judges watch videos when they can't run your code.

**Script:**
- 0:00-0:15 — Problem statement: "AI agents need to execute transactions, but how do you trust them?"
- 0:15-0:45 — Show the architecture diagram, explain the ZK proof concept in one sentence
- 0:45-2:00 — Live demo: user signs intent → agent generates proof → on-chain execution → BaseScan verification
- 2:00-2:30 — Show MCP integration (Claude using the wallet as a tool)
- 2:30-3:00 — What's next / why this matters

**Effort:** ~2-3 hours (recording + light editing)

#### 4. MCP Server Must Actually Execute Transactions
The MCP server's `execute_intent` returns a fake txHash. If a judge runs the MCP server and tries to execute, it fails silently. This undermines the entire "AI agent" narrative.

**Fix:** Wire `execute_intent` to:
1. Call the real prover service (in real mode) to generate a Groth16 proof
2. Submit the real `executeWithProof()` transaction via ethers.js
3. Return the real txHash and BaseScan link

**Effort:** ~3-4 hours

#### 5. Prover Service in Real Mode by Default
Currently defaults to `simulatedMode: true` with fake proofs. If anyone inspects the code or runs the service, they'll see it's generating mock data.

**Fix:** Default to real mode when circuit artifacts exist in `circuits/build/`. Only fall back to simulated when artifacts are missing.

**Effort:** ~1 hour

#### 6. Natural Language Intent Processing
See Product Requirements above. The agent must accept plain English and produce structured intents.

**Minimum viable:**
- MCP `create_intent` accepts a `description` field ("send 100 USDC to 0xABC")
- Agent parses into structured action type + parameters
- Agent constructs IntentBundle and proceeds to proof + execution

**Effort:** ~3-4 hours

#### 7. x402 Payment Gating on Prover Service
See Product Requirements above. The prover service must return HTTP 402 and the agent must handle payment.

**Minimum viable:**
- Prover `POST /prove` returns 402 with payment requirements
- MCP server detects 402, pays from AgentWallet, retries
- Fee collection on `execute_intent` (user pays agent)

**Effort:** ~4-6 hours

#### 8. Smart Payment Routing (Multi-Token Merchant Payments)
See Product Requirements above. The agent must handle swap + pay in one atomic tx.

**Minimum viable:**
- MCP `create_intent` accepts merchant's accepted tokens list
- Agent checks user balances, determines if swap is needed
- Agent constructs multi-action intent: SWAP + TRANSFER
- Single `executeWithProof()` with ZK proof covering both actions
- Demo: user has ETH, merchant wants USDC, agent swaps and pays atomically

**Effort:** ~4-6 hours (depends on NL processing and SWAP action type working)

---

### P1: SHOULD DO (these separate top 3 from top 10)

#### 8. End-to-End MCP Demo with Claude
Show a real AI model (Claude via MCP) discovering the wallet tools, constructing an intent from natural language, and executing it. This is the "wow" moment for the agentic narrative.

**Demo flow:**
- User tells Claude: "Send 100 USDC to 0xABC..."
- Claude discovers tools via MCP, calls `create_intent`
- Claude calls `execute_intent`
- Real transaction appears on BaseScan

**Effort:** ~2-3 hours (MCP server must work first — depends on P0 #4)

#### 9. Persistent Deployed Contracts
Currently the demo deploys fresh contracts every run. For judging, you want stable contract addresses judges can inspect on BaseScan.

**Fix:** Deploy once, save addresses to a config file, and have the demo/frontend use those addresses. The deployment results are already saved to `contracts/deployments/zkproof-demo-results.json` — wire the frontend to read from this.

**Effort:** ~1-2 hours

#### 10. Contract Tests (Foundry)
Zero Solidity tests is a red flag for infrastructure-track judges (Devtopia, ADI). Doesn't need 100% coverage — but core flows need tests.

**Minimum test suite:**
- `testExecuteWithProof()` — happy path
- `testExecuteDirectly()` — happy path
- `testReplayProtection()` — same nonce fails
- `testExpiry()` — expired intent fails
- `testInvalidSignature()` — wrong signer fails
- `testInvalidProof()` — bad proof fails

**Effort:** ~3-4 hours (need to set up Foundry)

#### 11. Multiple Action Types in Demo
Currently only demonstrates TRANSFER. The circuit supports SWAP too. Showing a swap flow (approve + swap as atomic multi-call) proves the system handles real DeFi complexity.

**Effort:** ~2-3 hours

---

### P2: NICE TO HAVE (polish that wins tiebreakers)

#### 12. Live Contract Verification on BaseScan
Verified source code on BaseScan lets judges read the contracts directly. Unverified contracts look suspicious.

**Effort:** ~1 hour

#### 13. Devfolio Project Page Polish
- Clear screenshots
- Architecture diagram
- Working demo link
- Video embed
- Links to all relevant contracts

**Effort:** ~1 hour

#### 14. ERC-8004 Agent Discovery (for ADI/Base prizes)
MCP server has hardcoded agent data. Even a minimal on-chain agent registry would strengthen the "composable agent economy" narrative.

**Effort:** ~4-6 hours

#### 15. Gas Optimization Analysis
Show judges you've thought about production viability. Document gas costs per operation and any optimizations made.

**Effort:** ~1 hour (the data already exists from demo output — 358K gas for executeWithProof)

---

## Effort Summary

| Priority | Item | Hours | Impact |
|----------|------|-------|--------|
| **P0** | Working frontend with wallet connection | 4-6h | Critical |
| **P0** | Root README.md | 1h | Critical |
| **P0** | Demo video (< 3 min) | 2-3h | Critical |
| **P0** | MCP server real execution | 3-4h | Critical |
| **P0** | Prover service real mode | 1h | Critical |
| **P0** | Natural language intent processing | 3-4h | Critical |
| **P0** | x402 payment gating | 4-6h | Critical |
| **P0** | Smart payment routing (swap + pay) | 4-6h | Critical |
| **P1** | End-to-end MCP + Claude demo | 2-3h | High |
| **P1** | Persistent deployed contracts | 1-2h | High |
| **P1** | Foundry contract tests | 3-4h | High |
| **P1** | SWAP action type in demo | 2-3h | Medium |
| **P2** | BaseScan contract verification | 1h | Medium |
| **P2** | Devfolio page polish | 1h | Medium |
| **P2** | ERC-8004 on-chain registry | 4-6h | Low |
| **P2** | Gas optimization docs | 1h | Low |

**P0 total: ~23-31 hours** — this is the minimum to be competitive for $55K.
**P0 + P1 total: ~32-39 hours** — this puts you in the top tier.
**Everything: ~39-48 hours**

---

## Tier 1: High Fit (submit these)

### Base — Self-Sustaining Autonomous Agents ($10,000)

**Why VAEB fits:**
VAEB is literally an autonomous agent executing on-chain transactions on Base Sepolia. The agent independently derives calldata from user intents, generates ZK proofs, and submits verified transactions — all without holding signing keys. The "self-sustaining" angle comes from the agent operating as an autonomous service that can process intents continuously.

**What to emphasize in submission:**
- Agent has no signing authority — can only submit data, never steal funds
- ZK proof guarantees the agent faithfully executed the user's intent
- ERC-8150 standard means any agent can be swapped in/out (composable agent economy)
- MCP server enables any AI model (Claude, GPT, etc.) to discover and use the wallet as a tool
- Live demo on Base Sepolia with real Groth16 verification

**Gaps to fill:**
- Show the agent doing something more "self-sustaining" — e.g. a loop where the agent monitors conditions and autonomously executes intents (price threshold, scheduled transfers, rebalancing)
- Add a simple revenue model: the agent could charge a small fee per proof generation (the prover service already has a `/prove` endpoint — add a fee parameter)
- Emphasize Base-native deployment (already done)

**Demo script:**
1. Show user signing an intent in one terminal
2. Show agent picking it up, generating proof, submitting tx in another terminal
3. Show on-chain verification succeeding on Base Sepolia
4. Show BaseScan tx link with real proof data

---

### 0g Labs — Best DeFAI Application ($7,000)

**Why VAEB fits:**
The prize asks for "AI that meaningfully improves a DeFi workflow" with "structured decisions and guardrails, not just chat" and "users maintain control over outcomes." VAEB is exactly this — the AI agent makes structured execution decisions (deriving calldata), the ZK proof is the guardrail (agent can't deviate from the intent), and the user maintains control via signing.

**What to emphasize in submission:**
- AI agent as a DeFi execution layer, not a chatbot
- ZK proof = cryptographic guardrail (not just a policy check)
- User signs intent (maintains control), agent executes (improves workflow)
- MCP integration = any LLM can become a DeFi agent
- Intent SDK supports SWAP, TRANSFER, STAKE, LEND, BORROW action types

**Gaps to fill:**
- Integrate with 0G's infrastructure if possible (check if 0G has a compute endpoint for proof generation — would make the "AI inference" angle stronger)
- Show a DeFi-specific flow: user says "swap 100 USDC for ETH on Uniswap" → agent derives the exact swap calldata → ZK proof verifies derivation → executes on-chain
- Add a simple simulation endpoint showing the agent comparing DEX quotes before choosing optimal execution

**Demo script:**
1. User signs a swap intent with natural language description
2. Agent queries prices, selects optimal route
3. Agent derives calldata and generates ZK proof
4. On-chain execution with proof verification
5. Show the user never had to interact with a DEX UI

---

### ADI Foundation — Open Project Submission ($19,000)

**Why VAEB fits:**
ADI focuses on Account Abstraction (ERC-4337). VAEB's AgentWallet is a smart contract wallet that extends AA concepts — it's an account that can be operated by an agent with cryptographic proof of correct execution. The wallet supports multiple execution paths (direct signature vs. ZK proof), which maps to AA's flexible validation logic.

**What to emphasize in submission:**
- AgentWallet as a next-gen smart contract wallet (ERC-8150)
- Two validation paths: `executeDirectly()` (simple signature, like standard AA) and `executeWithProof()` (ZK-verified agent execution)
- Nonce management, expiry, atomic multi-call — all AA-native patterns
- Intent-based architecture aligns with AA's vision of abstracting transaction construction away from users
- Agent can be thought of as a "bundler with proof" — submits UserOperations but with ZK verification that the operation matches the user's intent

**Gaps to fill:**
- Frame the submission in AA terminology (UserOperations, bundlers, paymasters)
- Consider adding a thin ERC-4337 compatibility layer or at least documenting how AgentWallet maps to 4337 concepts
- Mention how the ZK proof replaces trust in bundlers — in standard 4337, you trust the bundler to submit your operation faithfully; with VAEB, the proof guarantees it

**Demo script:**
1. Compare standard 4337 flow vs. VAEB flow side by side
2. Show how VAEB adds cryptographic guarantees that 4337 alone doesn't provide
3. Live tx on Base Sepolia

---

## Tier 2: Moderate Fit (submit if time allows)

### Blockade Labs — Solving the Homeless Agent Problem ($2,000)

**Why VAEB fits:**
The "homeless agent problem" is about agent infrastructure resilience. VAEB solves this — agents don't need their own wallets or keys to operate. They use the user's AgentWallet with delegated, ZK-verified execution. An agent can be spun up, connected to any AgentWallet via MCP, and start executing — no onboarding, no key management, no "home" needed.

**What to emphasize:**
- Agent is stateless — doesn't hold keys, funds, or persistent state
- Any agent can be authorized/deauthorized via `setAgent()`
- MCP server means agents discover capabilities dynamically
- Agent portability: swap agents without migrating funds or state

**Gap:** Frame the narrative around agent resilience and portability rather than ZK proofs.

---

### Organizer Track: Futurllama ($2,000)

**Focus:** AI, DePIN, frontier tech, innovative UI/UX

**Angle:** VAEB is frontier AI + crypto infrastructure. ZK proofs for agent execution is genuinely novel — most agent wallets use multisig or policy engines, not Groth16 circuits. Emphasize the technical innovation.

---

### Organizer Track: Devtopia ($2,000)

**Focus:** Infrastructure, L2s, dev tooling, security, scaling

**Angle:** VAEB is developer infrastructure — the Intent SDK, MCP server, and prover service are all tools for building agent-powered DeFi applications. Emphasize the SDK and developer experience.

---

### Kite AI — Agent-Native Payments & Identity ($10,000) [NEW — enabled by x402]

**Why VAEB fits (with x402):**
VAEB's agent economy is x402-native. The agent pays for proof generation via HTTP 402 micropayments, charges users for execution, and maintains economic self-sufficiency. The AgentWallet itself serves as the payment identity — the agent is identified by its wallet address and authorized via `setAgent()`.

**What to emphasize in submission:**
- Agent pays for services (proof generation, price feeds) via x402 automatically
- Agent charges users for intent execution — real revenue model
- AgentWallet as agent identity: on-chain address, authorization history, execution track record
- Economic self-sustainability: agent's revenue exceeds its costs
- MCP server as the x402 client — any AI model can participate in the payment economy

**Demo script:**
1. Show agent receiving an intent
2. Agent calls prover service → gets HTTP 402 → pays automatically → receives proof
3. Agent executes intent, charges user fee
4. Show agent P&L: revenue from users - costs from services = profit

---

## Tier 3: Weak Fit (skip unless pivoting)

| Prize | Why it's weak | What would be needed |
|-------|---------------|---------------------|
| Hedera ($25K) | Requires Hedera-native services, not EVM | Port everything to Hedera — not worth it |
| Canton Network ($15K) | Requires Daml language | Completely different stack |
| QuickNode ($2K) | Requires Monad or Hyperliquid Streams | No overlap with current architecture |
| 0g Labs — On-Chain Agent/iNFT ($7K) | Requires NFT-based agent identity | Would need to mint agent as NFT — possible but significant work |

---

## Submission Priorities

| Priority | Prize | Amount | Work Needed |
|----------|-------|--------|-------------|
| 1 | ADI — Open Project | $19,000 | Low — reframe in AA terminology |
| 2 | Base — Autonomous Agents | $10,000 | Medium — x402 revenue loop + NL demo |
| 3 | Kite AI — Agent Payments | $10,000 | Medium — x402 implementation |
| 4 | 0g Labs — DeFAI | $7,000 | Medium — NL → DeFi flow |
| 5 | Blockade Labs | $2,000 | Very Low — write narrative only |
| 6 | Futurllama (organizer) | $2,000 | Very Low — submit existing project |
| 7 | Devtopia (organizer) | $2,000 | Very Low — emphasize SDK/tooling |

**Total addressable prize pool: $52,000**

---

## General Presentation Tips

1. **Lead with the demo, not the slides.** Show a real tx on BaseScan within the first 60 seconds.
2. **One sentence pitch:** "VAEB lets AI agents execute DeFi transactions with zero-knowledge proofs that cryptographically guarantee the agent can't cheat."
3. **Show the BaseScan tx.** Judges love seeing real on-chain activity. Link directly to the `executeWithProof()` tx.
4. **Differentiate from multisig/policy agents.** Most "agent wallets" use allowlists or spending limits. VAEB uses math — a Groth16 proof with 10,790 constraints. That's the moat.
5. **Have the MCP demo ready.** Showing an AI model (Claude) discovering and using the wallet tools via MCP is a strong visual for the "agentic" narrative.
6. **Keep technical depth available but don't lead with it.** Circuit details, EIP-712 domain separators, and Poseidon hashing are for follow-up questions, not the opening pitch.
