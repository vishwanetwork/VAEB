# VAEB Prize Strategy — ETHDenver 2026

## TL;DR

VAEB's strongest fit is **Base ($10K)**, **0g Labs DeFAI ($7K)**, and **ADI Foundation ($19K)**. These three alone total $36K and align directly with what's already built. Secondary targets like Blockade Labs and organizer tracks add upside with minimal extra work.

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

---

### P1: SHOULD DO (these separate top 3 from top 10)

#### 6. End-to-End MCP Demo with Claude
Show a real AI model (Claude via MCP) discovering the wallet tools, constructing an intent from natural language, and executing it. This is the "wow" moment for the agentic narrative.

**Demo flow:**
- User tells Claude: "Send 100 USDC to 0xABC..."
- Claude discovers tools via MCP, calls `create_intent`
- Claude calls `execute_intent`
- Real transaction appears on BaseScan

**Effort:** ~2-3 hours (MCP server must work first — depends on P0 #4)

#### 7. Persistent Deployed Contracts
Currently the demo deploys fresh contracts every run. For judging, you want stable contract addresses judges can inspect on BaseScan.

**Fix:** Deploy once, save addresses to a config file, and have the demo/frontend use those addresses. The deployment results are already saved to `contracts/deployments/zkproof-demo-results.json` — wire the frontend to read from this.

**Effort:** ~1-2 hours

#### 8. Contract Tests (Foundry)
Zero Solidity tests is a red flag for infrastructure-track judges (Devtopia, ADI). Doesn't need 100% coverage — but core flows need tests.

**Minimum test suite:**
- `testExecuteWithProof()` — happy path
- `testExecuteDirectly()` — happy path
- `testReplayProtection()` — same nonce fails
- `testExpiry()` — expired intent fails
- `testInvalidSignature()` — wrong signer fails
- `testInvalidProof()` — bad proof fails

**Effort:** ~3-4 hours (need to set up Foundry)

#### 9. Multiple Action Types in Demo
Currently only demonstrates TRANSFER. The circuit supports SWAP too. Showing a swap flow (approve + swap as atomic multi-call) proves the system handles real DeFi complexity.

**Effort:** ~2-3 hours

---

### P2: NICE TO HAVE (polish that wins tiebreakers)

#### 10. Live Contract Verification on BaseScan
Verified source code on BaseScan lets judges read the contracts directly. Unverified contracts look suspicious.

**Effort:** ~1 hour

#### 11. Devfolio Project Page Polish
- Clear screenshots
- Architecture diagram
- Working demo link
- Video embed
- Links to all relevant contracts

**Effort:** ~1 hour

#### 12. ERC-8004 Agent Discovery (for ADI/Base prizes)
MCP server has hardcoded agent data. Even a minimal on-chain agent registry would strengthen the "composable agent economy" narrative.

**Effort:** ~4-6 hours

#### 13. Gas Optimization Analysis
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
| **P1** | End-to-end MCP + Claude demo | 2-3h | High |
| **P1** | Persistent deployed contracts | 1-2h | High |
| **P1** | Foundry contract tests | 3-4h | High |
| **P1** | SWAP action type in demo | 2-3h | Medium |
| **P2** | BaseScan contract verification | 1h | Medium |
| **P2** | Devfolio page polish | 1h | Medium |
| **P2** | ERC-8004 on-chain registry | 4-6h | Low |
| **P2** | Gas optimization docs | 1h | Low |

**P0 total: ~12-15 hours** — this is the minimum to be competitive.
**P0 + P1 total: ~20-25 hours** — this puts you in the top tier.
**Everything: ~28-35 hours**

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

## Tier 3: Weak Fit (skip unless pivoting)

| Prize | Why it's weak | What would be needed |
|-------|---------------|---------------------|
| Kite AI ($10K) | Requires x402 protocol — VAEB doesn't implement payment gating | Build x402 HTTP 402 payment flow into MCP server |
| Hedera ($25K) | Requires Hedera-native services, not EVM | Port everything to Hedera — not worth it |
| Canton Network ($15K) | Requires Daml language | Completely different stack |
| QuickNode ($2K) | Requires Monad or Hyperliquid Streams | No overlap with current architecture |
| 0g Labs — On-Chain Agent/iNFT ($7K) | Requires NFT-based agent identity | Would need to mint agent as NFT — possible but significant work |

---

## Submission Priorities

| Priority | Prize | Amount | Work Needed |
|----------|-------|--------|-------------|
| 1 | Base — Autonomous Agents | $10,000 | Low — add autonomy narrative, polish demo |
| 2 | 0g Labs — DeFAI | $7,000 | Low-Medium — add DeFi flow (swap intent) |
| 3 | ADI — Open Project | $19,000 | Low — reframe in AA terminology |
| 4 | Blockade Labs | $2,000 | Very Low — write narrative only |
| 5 | Futurllama (organizer) | $2,000 | Very Low — submit existing project |
| 6 | Devtopia (organizer) | $2,000 | Very Low — emphasize SDK/tooling |

**Total addressable prize pool: $42,000**

---

## General Presentation Tips

1. **Lead with the demo, not the slides.** Show a real tx on BaseScan within the first 60 seconds.
2. **One sentence pitch:** "VAEB lets AI agents execute DeFi transactions with zero-knowledge proofs that cryptographically guarantee the agent can't cheat."
3. **Show the BaseScan tx.** Judges love seeing real on-chain activity. Link directly to the `executeWithProof()` tx.
4. **Differentiate from multisig/policy agents.** Most "agent wallets" use allowlists or spending limits. VAEB uses math — a Groth16 proof with 10,790 constraints. That's the moat.
5. **Have the MCP demo ready.** Showing an AI model (Claude) discovering and using the wallet tools via MCP is a strong visual for the "agentic" narrative.
6. **Keep technical depth available but don't lead with it.** Circuit details, EIP-712 domain separators, and Poseidon hashing are for follow-up questions, not the opening pitch.
