# Canton ZK Custody + VAEB: Synergy Architecture

## Overview

**Canton ZK Custody** and **VAEB (Verified Agent Execution Bundle)** are complementary ZK-powered systems that together form a privacy-preserving, agent-native settlement pipeline on EVM.

| Layer | Canton ZK Custody | VAEB |
|-------|------------------|------|
| **Role** | Coordination, attestation & privacy | Verified EVM execution |
| **ZK System** | RISC0 (zkVM) | Groth16 (circom) |
| **What it proves** | EVM balance/staking state exists | Agent calldata matches user intent |
| **Ledger** | Canton (Daml sub-transaction privacy) | Base / any EVM chain |
| **Standard** | Daml 3.x templates | ERC-8150 |

Canton is a **privacy-preserving coordination layer** — it does not hold funds. Assets live on EVM. Canton records multi-party agreements and ZK attestations; VAEB executes the actual on-chain transfers with cryptographic proof of intent fidelity.

Canton answers **"does the asset exist and do all parties agree?"** — VAEB answers **"was the transfer executed faithfully?"**

## Dual ZK Proof Stack

```
                    Canton ZK Custody                          VAEB
               ┌──────────────────────┐              ┌──────────────────────┐
               │  RISC0 zkVM Proofs   │              │  Groth16 Proofs      │
               │                      │              │                      │
  EVM RPC ────▶│ EVM MPT state proof  │              │ IntentVerifier.circom│
  (Base)       │ (balance, staking)   │              │ (10,790 constraints) │
               │                      │              │                      │
               │  Proves: on-chain    │              │ Proves: calldata     │
               │  state at block N    │              │ matches signed intent│
               └──────────┬───────────┘              └──────────┬───────────┘
                          │                                     │
                          ▼                                     ▼
               ┌──────────────────────┐              ┌──────────────────────┐
               │  Canton Ledger       │              │  AgentWallet.sol     │
               │  (Daml contracts)    │              │  (ERC-8150 on Base)  │
               │                      │              │                      │
               │  AttestationProposal │              │  executeWithProof()  │
               │  CustodyAttestation  │              │  Groth16Verifier     │
               │  Settlement terms    │              │  Nonce + Expiry      │
               └──────────────────────┘              └──────────────────────┘

Where funds live:      EVM (Base) — USDC, ETH, ERC-20 tokens
Where agreements live: Canton — multi-party Daml contracts
Where proofs live:     Both — RISC0 anchored on Canton, Groth16 verified on-chain
```

## Integration Flow

A concrete example: **Custodian-supervised USDC payment on Base**.

```
Step 1: Attest Balance (Canton + RISC0)
────────────────────────────────────────
  EVM RPC (Base) ─▶ RISC0 proof of BalanceAbove(1000 USDC)
  ─▶ Custodian creates AttestationProposal on Canton
  ─▶ Asset Holder co-signs → CustodyAttestation
  Result: Canton records "address 0xABC holds ≥1000 USDC on Base at block N"
  Funds: untouched on Base

Step 2: Agree on Settlement (Canton)
─────────────────────────────────────
  Buyer + Seller + Custodian create Settlement contract on Canton:
  - chain: EVM (Base)
  - claimType: BalanceAbove
  - asset: USDC
  - amount: 500
  - seller: 0xABC, buyer: 0xDEF
  Result: multi-party agreement recorded with sub-transaction privacy
  Funds: still untouched on Base

Step 3: Execute Transfer (VAEB on Base)
────────────────────────────────────────
  AI Agent reads settlement terms from Canton
  ├─ create_intent("Transfer 500 USDC to 0xABC")
  ├─ User (buyer) signs IntentBundle via EIP-712 in MetaMask
  ├─ Prover generates Groth16 proof: calldata == signed intent
  └─ AgentWallet.executeWithProof(proof, signature, calls)
  Result: 500 USDC moves from buyer's AgentWallet to seller on Base
  Funds: transferred on Base, verified by Groth16 proof on-chain

Step 4: Record Receipt (Canton)
────────────────────────────────
  Canton records ExecutionReceipt:
  - Base tx hash: 0x...
  - Groth16 proof hash (intent verified on-chain)
  - RISC0 proof hash (balance attested off-chain)
  - Only settlement parties can see the details
  Result: immutable, private audit trail on Canton
```

## Why Canton + VAEB (Not Just VAEB Alone)

VAEB can execute transfers on its own. Adding Canton provides:

| Without Canton | With Canton |
|---------------|-------------|
| Buyer trusts agent "the seller has funds" | RISC0 proof of seller's balance, co-signed by custodian |
| Settlement terms in a backend DB or chat | Multi-party Daml contract with propose/accept consent |
| Tx history on public chain (visible to all) | Sub-transaction privacy (only parties see details) |
| No custodian oversight | Custodian must attest before settlement proceeds |
| Single proof (Groth16 for intent) | Dual proof: RISC0 for state + Groth16 for intent |

Canton turns a simple agent-executed payment into a **regulated, privacy-preserving, multi-party settlement workflow**.

## Concrete Integration Points

### 1. Settlement Execution Bridge (~100 LOC)

Canton's `CrossChainSettlement.Execute` triggers VAEB execution:

```
Canton Settlement ──▶ VAEB MCP execute_intent() ──▶ Base tx hash ──▶ Canton ExecutionReceipt
```

The bridge service:
- Reads pending `CrossChainSettlement` contracts from Canton
- Constructs a VAEB IntentBundle matching the settlement terms (recipient, amount, token)
- Submits to VAEB's prover service for Groth16 proof generation (~12s)
- Executes via `AgentWallet.executeWithProof()` on Base
- Records the tx hash back on Canton as an `ExecutionReceipt`

### 2. Dual Proof Anchoring

Each settlement gets **two independent ZK proofs**:

| Proof | System | Proves | Verified |
|-------|--------|--------|----------|
| Balance state | RISC0 | Seller holds ≥ X USDC on Base at block N | Off-chain (zkVM guest), anchored on Canton |
| Intent execution | Groth16 | Transfer calldata matches buyer's signed intent | On-chain (AgentWallet on Base) |

Canton's sub-transaction privacy ensures only settlement parties see the proof details.

### 3. MCP Server Expansion

VAEB's MCP server (23 tools) extended with Canton-aware tools:

| New Tool | Category | Description |
|----------|----------|-------------|
| `query_attestations` | Canton | List active CustodyAttestations |
| `query_settlements` | Canton | List pending settlements |
| `execute_settlement` | Canton+VAEB | Read Canton terms → build intent → prove → execute on Base |
| `verify_reserve` | Canton | Check ProofOfReserve validity |

This lets AI agents orchestrate the full flow conversationally:
```
User: "Pay the 500 USDC settlement to the seller"
Agent: query_settlements() → found settlement #xyz (500 USDC on Base)
Agent: query_attestations() → seller balance attestation valid
Agent: create_intent("Transfer 500 USDC to 0xABC")
User:  signs IntentBundle in MetaMask
Agent: execute_intent() → Groth16 proof + Base tx
Agent: record_receipt() → Canton ExecutionReceipt with tx hash
```

## Architecture Summary

| Dimension | Canton ZK Custody | VAEB | Combined |
|-----------|------------------|------|----------|
| Privacy model | Sub-transaction (Daml) | Per-wallet (ERC-8150) | Multi-layer |
| Consensus | Canton synchronizer | EVM block finality (Base) | Both |
| Proof generation | RISC0 Docker (~30s) | Groth16 snarkjs (~12s) | Parallel |
| Key parties | Custodian, AssetHolder, Counterparty | User, Agent, Wallet | All roles |
| Funds | Never on Canton | EVM-native (Base) | EVM only |
| Role | Agreement + attestation | Execution + verification | Full pipeline |

## Why This Matters

1. **No single point of trust**: Canton ensures multi-party consent before funds move; VAEB ensures agent can't deviate from signed intent
2. **Dual ZK verification**: RISC0 proves the world state, Groth16 proves the action matches intent — independent proof systems, no shared trust assumptions
3. **Privacy at every layer**: Canton hides settlement details from non-parties; Groth16 proof hides intent details on-chain
4. **AI-agent native**: VAEB's MCP server makes the entire flow accessible to AI agents — no custom integration, just tool calls

## Estimated Implementation

| Component | Files | LOC |
|-----------|-------|-----|
| Settlement bridge (Canton → VAEB) | `canton-bridge/vaeb_executor.py` | ~80 |
| VAEB MCP Canton tools | `packages/mcp-server/src/tools/canton.ts` | ~60 |
| ExecutionReceipt with VAEB tx/proof hash | `daml/src/CrossChainSettlement.daml` | ~20 |
| Config + types | Various | ~40 |
| **Total** | **4 files** | **~200 LOC** |

---

*Canton ZK Custody: Vishwa Network — Daml 3.x + RISC0*
*VAEB: ERC-8150 Verified Agent Execution Bundle — Groth16 + Base*
