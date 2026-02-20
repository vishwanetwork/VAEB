# VAEB Project Outline

## Vision

VAEB (Verified Agent Execution Bundle) enables AI agents to execute on-chain transactions on behalf of users with zero-knowledge proofs guaranteeing the agent can't deviate from the user's intent.

> "Tell an AI agent what you want in plain English. It figures out how to do it — even if that means swapping tokens first — proves it won't cheat with a ZK proof, pays for its own infrastructure with micropayments, and executes everything atomically on-chain. All without ever holding your keys."

---

## Target Customers

| Segment | Pain Point | VAEB Solution |
|---------|-----------|---------------|
| **AI agent developers** | Agents need on-chain execution but key custody is dangerous | Drop-in SDK + MCP server with ZK-verified execution |
| **DeFi users** | Want AI-assisted trading but don't trust bots with their keys | Delegate execution, not custody — ZK proof guarantees intent |
| **Merchants** | Customers hold wrong tokens, friction kills conversions | Agent auto-swaps and pays atomically in accepted token |
| **DAOs / Institutions** | Need auditable, verifiable agent execution | Every action has an on-chain ZK proof bound to an approved intent |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER LAYER                              │
│                                                                 │
│  Natural Language Intent ──► MCP Client (Claude, GPT, etc.)     │
│  "Pay merchant 50 USDC"      │                                  │
│                               ▼                                  │
├─────────────────────────────────────────────────────────────────┤
│                        AGENT LAYER                              │
│                                                                 │
│  MCP Server                                                     │
│  ├── get_wallet_balance (check AgentWallet ETH + USDC)         │
│  ├── create_intent (build IntentBundle via SDK)                 │
│  ├── execute_intent (prove + submit executeWithProof())         │
│  ├── check_nonce (verify nonce freshness before execution)      │
│  ├── get_price / estimate_gas / get_receipt (chain reads)       │
│  └── discover_agents / get_agent_reputation (ERC-8004 trust)   │
│                               │                                  │
│                               ▼                                  │
│  Prover Service (x402-gated)                                    │
│  └── Groth16 proof generation via snarkjs                       │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                       PROTOCOL LAYER                            │
│                                                                 │
│  Intent SDK (@vaeb/intent-sdk)                                  │
│  ├── Bundle creation, serialization, signing                    │
│  ├── Calldata derivation (TRANSFER, SWAP, STAKE, etc.)         │
│  └── EIP-712 typed data for owner signatures                    │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                       ON-CHAIN LAYER (Base Sepolia)             │
│                                                                 │
│  AgentWalletFactory                                             │
│  └── CREATE2 deterministic wallet deployment per user           │
│                                                                 │
│  AgentWallet (ERC-8150) — one per user                         │
│  ├── executeWithProof() ── ZK path (proof + signature)         │
│  ├── executeDirectly()  ── Simple path (signature only)        │
│  ├── Nonce replay protection                                    │
│  ├── Expiry enforcement                                         │
│  └── Atomic multi-call execution                                │
│                                                                 │
│  Groth16Verifier ← Adapter ← AgentWallet                       │
│  └── On-chain ZK proof verification (pairing check)            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Complete User Flow

### Setup (One Time per User)

```
1. User opens VAEB frontend → connects MetaMask (Base Sepolia)

2. Frontend calls AgentWalletFactory.createWallet(
       owner = user's MetaMask address,
       agent = VAEB server EOA (0x17C3771F...),
       salt  = random bytes32
   )
   └─ deploys AgentWallet via CREATE2 (deterministic address)
   └─ user pays gas

3. User deposits ETH + USDC into their AgentWallet contract
   (NOT into MetaMask — into the smart contract wallet)
```

### Per-Transaction Flow

```
4. User tells Claude: "Send 100 USDC to 0xABC"

5. Claude calls get_wallet_balance
   └─ confirms sufficient ETH (gas) + USDC in AgentWallet

6. Claude calls create_intent(actions=[TRANSFER 100 USDC to 0xABC])
   └─ VAEB builds IntentBundle + derives calldata
   └─ returns human-readable preview

7. Claude asks user to sign the EIP-712 intent via MetaMask
   └─ user reviews and signs — signature returned to Claude

8. Claude calls execute_intent(intent_id, signature)
   a. VAEB checks nonce is fresh on-chain (isNonceUsed)
   b. Sends bundle to prover → Groth16 ZK proof generated
      └─ proof binds: intent commitment ↔ calldata
   c. Submits AgentWallet.executeWithProof(proof, sig, inputs, calls)
      └─ VAEB EOA signs and broadcasts, pays gas

9. AgentWallet verifies on-chain:
   ├─ ZK proof valid (Groth16Verifier)
   ├─ EIP-712 signature from owner (user's MetaMask)
   ├─ nonce not used, not expired, correct chainId
   └─ executes calls atomically

10. Claude: "Done. Tx: 0x... — view on BaseScan"
```

### Security Model

```
┌─────────────────┬──────────────────────────────────────────┐
│ User MetaMask   │ signing key only — holds no funds         │
│ AgentWallet     │ holds all funds — smart contract          │
│ VAEB EOA        │ submits txs, pays gas — cannot steal      │
└─────────────────┴──────────────────────────────────────────┘

VAEB EOA: 0x17C3771F0250b2774AA11b793Deb523d2D914E03
```

---

## What's Built (Done)

- [x] **AgentWallet.sol** — production-quality ERC-8150 wallet, deployed on Base Sepolia
- [x] **AgentWalletFactory.sol** — CREATE2 factory for deterministic multi-user wallet deployment
- [x] **IntentVerifier.circom** — Groth16 circuit, 10,790 constraints, real derivation verification
- [x] **Groth16Verifier.sol** — snarkjs-generated on-chain verifier, deployed on Base Sepolia
- [x] **Groth16VerifierAdapter.sol** — bridges wallet ↔ verifier interfaces, deployed on Base Sepolia
- [x] **Intent SDK** — bundle creation, signing, calldata derivation, 13 passing tests
- [x] **Prover Service** — Express.js wrapper around snarkjs (real Groth16 proofs by default)
- [x] **MCP Server** — 15 tools: chain reads, intent lifecycle, ERC-8004 trust/reputation
- [x] **MCP execute_intent** — real `executeWithProof()` submission via ethers.js, real txHash
- [x] **get_wallet_balance / check_nonce** — live on-chain reads in MCP server
- [x] **Nonce pre-check** — `isNonceUsed()` called before proof generation in `execute_intent`
- [x] **EIP-712 signatures** — owner signs intents, contract recovers signer
- [x] **Nonce + expiry** — replay protection and stale intent rejection
- [x] **Foundry tests** — 68/68 passing (AgentWallet: 41 tests, AgentWalletFactory: 27 tests)
- [x] **demo-zkproof.js** — end-to-end demo: deploy → prove → verify → execute on Base Sepolia

---

## What's Next (To Build)

### Phase 1: Make It Real (~12h)

Goal: Everything that exists works end-to-end with no simulation or stubs.

**1.1 Prover Service — Real Mode by Default** ✅ Done
- Auto-detect circuit artifacts in `circuits/build/`
- Default to real Groth16 proofs when artifacts exist
- Fall back to simulated only when artifacts are missing

**1.2 MCP Server — Real Execution** ✅ Done
- `execute_intent` calls real prover service
- Submits real `executeWithProof()` transaction via ethers.js
- Returns real txHash and BaseScan link
- Nonce pre-check before proof generation

**1.3 Frontend — Working Demo with Wallet Connection**
- Connect to MetaMask (Base Sepolia network)
- Display user wallet + AgentWallet balances
- Intent builder form (token, amount, recipient)
- Real proof generation with progress indicator
- Submit `executeWithProof()` and show BaseScan link
- Before/after balance display
- Tech: vanilla HTML + ethers.js (no framework needed)
- Files: `demo/index.html`

**1.4 Deploy AgentWalletFactory**
- Deploy to Base Sepolia, save address to `contracts/deployments/base_sepolia.json`
- Wire frontend to call `createWallet()` for new users

---

### Phase 2: Natural Language Intent Processing (~4h)

Goal: User types English, agent produces a structured intent and executes it.

**2.1 NL Parser in MCP Server**
- `create_intent` accepts `description` field
- Parse into structured action: type, token, amount, recipient
- Support TRANSFER ("send 100 USDC to 0xABC") and SWAP ("swap 100 USDC for ETH")
- Resolve token symbols to addresses (USDC → 0x..., ETH → native)
- Files: `packages/mcp-server/src/tools/intent-tools.ts`

**2.2 Agent Confirmation Flow**
- Agent explains what it's about to do before requesting signature
- Human-readable error messages (not raw revert data)
- Handle ambiguity by asking clarifying questions

**2.3 End-to-End MCP Demo**
- User tells Claude: "Send 100 USDC to 0xABC"
- Claude discovers tools via MCP → `create_intent` → `execute_intent`
- Real transaction appears on BaseScan

---

### Phase 3: x402 Payment Protocol (~5h)

Goal: Agent services are paid via HTTP 402 micropayments, creating a self-sustaining economy.

**3.1 x402 Server Middleware (Prover Service)**
- `POST /prove` returns HTTP 402 when called without payment
- 402 response body: price (USDC), payment address, required headers
- Verify payment on-chain before serving proof
- Use Coinbase x402 SDK (`@coinbase/x402`)
- Files: `packages/prover-service/src/index.ts`

**3.2 x402 Client (MCP Server)**
- Detect 402 responses from prover service
- Initiate on-chain USDC payment from AgentWallet via `executeDirectly()`
- Retry service call with payment proof header
- Files: `packages/mcp-server/src/tools/intent-tools.ts`

**3.3 Fee Collection**
- MCP server charges user a fee for `execute_intent`
- Fee > cost of proof generation = agent profit
- Health endpoint shows agent revenue/cost balance

**3.4 Economic Loop**
```
User pays 0.05 USDC → Agent → executes intent
                        ├── pays 0.02 USDC → Prover (x402)
                        ├── pays 0.01 USDC → Price feed (x402)
                        └── keeps 0.02 USDC profit
```

---

### Phase 4: Smart Payment Routing (~5h)

Goal: Merchant specifies accepted tokens. Agent auto-swaps and pays in one atomic tx.

**4.1 Multi-Token Balance Check**
- Agent queries user balances across supported tokens
- Determine if user already holds an accepted token
- If not, identify which token to swap from

**4.2 Swap Route Finding**
- Query DEX for swap quotes (Uniswap on Base Sepolia)
- Estimate output amount including slippage
- Select optimal route

**4.3 Multi-Action Intent Construction**
- Build atomic bundle: SWAP (approve + swap) + TRANSFER
- Circuit already supports up to 4 actions per bundle
- Single `executeWithProof()` covers entire bundle

**4.4 Merchant Integration**
- MCP tool accepts `accepted_tokens` parameter
- Merchant can trigger payment request via x402
- Agent auto-routes: wrong token → swap → pay → done

---

### Phase 5: Polish & Presentation (~5h)

**5.1 README.md**
- One-paragraph description
- Architecture diagram
- "How it works" flow
- Live contract links (BaseScan)
- Screenshot/GIF of working demo
- Quick start instructions

**5.2 Demo Video (< 3 minutes)**
- 0:00-0:15 — Problem: "How do you trust an AI agent with your money?"
- 0:15-0:45 — Architecture + ZK concept (one sentence)
- 0:45-2:00 — Live demo: NL intent → proof → on-chain execution
- 2:00-2:30 — MCP + Claude integration
- 2:30-3:00 — x402 economy + merchant payment routing

**5.3 Contract Tests (Foundry)** ✅ Done (68/68 passing)
- `AgentWallet.t.sol` — 41 tests (executeWithProof, executeDirectly, nonces, admin)
- `AgentWalletFactory.t.sol` — 27 tests (createWallet, predictAddress, isWallet, access control)

**5.4 BaseScan Verification**
- Verify all deployed contract source code on BaseScan

**5.5 Devfolio Submission**
- Screenshots, architecture diagram, demo link, video embed
- Links to verified contracts

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart Contracts | Solidity 0.8.24, ERC-8150 |
| ZK Circuits | Circom (Groth16, BN128) |
| ZK Proofs | snarkjs |
| On-chain Verifier | snarkjs-generated Solidity |
| Hashing | Poseidon (circuit), Keccak256 (contract) |
| Signatures | EIP-712 typed data, ECDSA |
| SDK | TypeScript, ethers.js v6 |
| MCP Server | TypeScript, stdio transport |
| Prover Service | Express.js, snarkjs |
| Payment Protocol | x402 (Coinbase SDK) |
| Chain | Base Sepolia (chainId 84532) |
| Frontend | Vanilla HTML + ethers.js |
| Contract Tests | Foundry (forge) |

---

## Key Contracts (Base Sepolia)

| Contract | Address |
|----------|---------|
| AgentWallet | `0x99D238c22499e679e9d45578245083FE690C8B5f` |
| MockUSDC | `0x93560481FE085E4Fd1A0f0bAb2E625118A67aC1D` |
| MockZKVerifier | `0x83E5...` (dev only — real verifier below) |
| Groth16Verifier | `0xE004ff1dE5009b12c11DE00616Ac7a28437e3475` |
| Groth16VerifierAdapter | `0x7206d80BA38EDFd439951339eEAd95E3f301d8C8` |
| AgentWalletFactory | not yet deployed |

VAEB Agent EOA: `0x17C3771F0250b2774AA11b793Deb523d2D914E03`

---

## Repo Structure

```
vaeb/
├── circuits/                        # ZK circuit (Circom)
│   ├── IntentVerifier.circom        # Groth16 circuit (10,790 constraints)
│   └── build/                       # Compiled artifacts (.wasm, .zkey, .vkey)
├── contracts/
│   ├── src/                         # Solidity contracts
│   │   ├── AgentWallet.sol          # Core ERC-8150 wallet
│   │   ├── AgentWalletFactory.sol   # CREATE2 factory for multi-user deployment
│   │   ├── Groth16Verifier.sol      # On-chain ZK verifier (snarkjs-generated)
│   │   ├── Groth16VerifierAdapter.sol
│   │   ├── interfaces/              # IAgentWallet, IGroth16Verifier
│   │   ├── lib/                     # ECDSA, EIP712
│   │   └── mocks/                   # MockERC20, MockZKVerifier
│   ├── test/                        # Foundry tests (68/68 passing)
│   │   ├── AgentWallet.t.sol        # 41 tests
│   │   └── AgentWalletFactory.t.sol # 27 tests
│   ├── out/                         # Compiled ABI + bytecode (solcjs)
│   ├── out_forge/                   # Compiled ABI + bytecode (forge)
│   ├── lib/forge-std/               # Foundry test library
│   ├── foundry.toml                 # Foundry config
│   └── deployments/                 # Deployment addresses per chain
├── packages/
│   ├── intent-sdk/                  # TypeScript SDK
│   ├── mcp-server/                  # MCP server for AI agents (15 tools)
│   └── prover-service/              # ZK prover (Express.js)
├── scripts/
│   ├── demo-zkproof.js              # Full ZK demo (Base Sepolia)
│   ├── demo-live.js                 # Simple demo (no ZK)
│   └── deploy-real-verifier.js      # Swap MockZKVerifier → Groth16VerifierAdapter
├── demo/
│   └── index.html                   # Interactive frontend
├── doc/
│   ├── project_outline.md           # This file
│   ├── prize_strategy.md            # ETHDenver prize strategy
│   └── eip8150.md                   # ERC-8150 spec reference
├── DEPLOY_AND_TEST.md               # Deployment guide
└── .env                             # Wallet keys + RPC config
```

---

## Milestones

| Phase | Deliverable | Status |
|-------|------------|--------|
| Phase 1 | Real end-to-end execution (no stubs) | 🟡 In Progress (1.1, 1.2 done — frontend + factory deploy remain) |
| Phase 2 | Natural language → intent → execution | Not started |
| Phase 3 | x402 payment economy | Not started |
| Phase 4 | Multi-token merchant payment routing | Not started |
| Phase 5 | README, video, tests, submission | 🟡 In Progress (5.3 Foundry tests done) |
