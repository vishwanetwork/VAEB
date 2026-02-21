# Canton ZK Custody — Privacy-Preserving Multi-Party Settlement

> **Best Privacy-Focused dApp Using Daml** — Canton Hackathon Submission

Privacy-preserving coordination layer that enables multi-party settlements with dual ZK proofs. Built on Canton's Daml smart contracts with sub-transaction privacy, bridging to EVM execution via VAEB's AgentWallet (ERC-8150).

## What This Does

Canton is a **privacy-preserving coordination layer** — it never holds funds. Assets live on EVM (Base). Canton provides:

- **Multi-party consent**: Buyer, seller, and custodian must all agree before funds move
- **ZK attestations**: RISC0 proofs of EVM balance/staking state, dual-signed on Canton
- **Sub-transaction privacy**: Only settlement parties see the details — external parties see nothing
- **Immutable audit trail**: Execution receipts link both proof systems (RISC0 + Groth16)

Canton answers **"does the asset exist and do all parties agree?"**
VAEB answers **"was the transfer executed faithfully?"**

## Privacy Model

Each contract has explicit visibility rules enforced by Canton's sub-transaction privacy:

```
┌────────────────────────┬────────────┬─────────┬────────────┐
│ Contract               │ Custodian  │ Buyer   │ Seller     │
├────────────────────────┼────────────┼─────────┼────────────┤
│ AttestationProposal    │ signatory  │    —    │     —      │
│ CustodyAttestation     │ signatory  │ observer│  observer  │
│  └─ proofHash (RISC0)  │  ✓ SEES    │ ✗ hidden│  ✗ hidden  │
│  └─ claimDigest        │  ✓ SEES    │ ✗ hidden│  ✗ hidden  │
│ CrossChainSettlement   │ signatory  │signatory│ signatory  │
│  └─ amount & terms     │  ✓ SEES    │ ✓ SEES  │  ✓ SEES   │
│ ExecutionReceipt       │ signatory  │signatory│ signatory  │
│  └─ txHash + proofHash │  ✓ SEES    │ ✓ SEES  │  ✓ SEES   │
│ ProofOfReserve         │ signatory  │    —    │  observer  │
├────────────────────────┴────────────┴─────────┴────────────┤
│ External parties see NOTHING (Canton sub-transaction       │
│ privacy ensures only named parties have visibility)        │
└────────────────────────────────────────────────────────────┘
```

## Architecture

```
EVM (Base)                    Canton                         VAEB
┌──────────┐           ┌──────────────────┐           ┌──────────────┐
│ USDC     │──RISC0──▶│ CustodyAttestation│           │ AgentWallet  │
│ balances │  proof    │ (dual-signed)     │           │ (ERC-8150)   │
└──────────┘           ├──────────────────┤           ├──────────────┤
                       │ Settlement       │──bridge──▶│ create_intent│
                       │ (buyer+seller+   │           │ Groth16 proof│
                       │  custodian agree)│           │ executeWith  │
                       ├──────────────────┤           │  Proof()     │
                       │ ExecutionReceipt │◀──tx hash─┤              │
                       │ (private audit)  │           └──────────────┘
                       └──────────────────┘
```

## Daml Smart Contracts

All contracts are in [`daml/src/`](daml/src/) and compiled to a DAR (`canton-zk-custody-0.1.0.dar`).

### CustodyAttestation.daml

Dual-signed ZK attestation of EVM state. The RISC0 `proofHash` is private to signatories (custodian + asset holder). Observers can verify existence but not proof internals.

- **AttestationProposal** — Custodian proposes, asset holder accepts → creates CustodyAttestation
- **CustodyAttestation** — Choices: `IsValid` (check expiry), `Refresh` (new proof), `Revoke`/`RevokeByHolder`

### CrossChainSettlement.daml

Multi-party settlement requiring buyer + seller + custodian consent. All three are signatories, ensuring Canton's privacy guarantees.

- **SettlementProposal** — Any party proposes, all three agree → creates CrossChainSettlement
- **CrossChainSettlement** — Choices: `Execute` (verifies attestation, creates receipt), `Abort`
- **ExecutionReceipt** — Immutable audit trail linking RISC0 proofHash + EVM txHash

### ProofOfReserve.daml

Aggregate portfolio view. Custodian creates for selected counterparties without revealing individual attestation details.

## Verified End-to-End Settlement Flow

### Step 1: Attest Balance (Canton + RISC0)
```
EVM RPC (Base) ─▶ RISC0 proof of BalanceAbove(1000 USDC)
  ─▶ Custodian creates AttestationProposal on Canton
  ─▶ Asset Holder co-signs → CustodyAttestation
  Result: Canton records "address holds ≥1000 USDC on Base at block N"
  Funds: untouched on Base
```

### Step 2: Agree on Settlement (Canton multi-party)
```
Buyer + Seller + Custodian create CrossChainSettlement on Canton:
  - requiredChain: EVM
  - requiredClaimType: BalanceAbove
  - settlementAsset: { issuer, label: "USDC" }
  - amount: 500
  Result: multi-party agreement recorded with sub-transaction privacy
  Funds: still untouched on Base
```

### Step 3: Execute Transfer (VAEB on Base)
```
AI Agent reads settlement terms from Canton
├─ SettlementBridge maps Canton parties → EVM addresses
├─ SettlementBridge generates TRANSFER action
├─ create_intent(vaebActions) → IntentBundle ready
├─ User (buyer) signs IntentBundle via EIP-712 in MetaMask
├─ Prover generates Groth16 proof: calldata == signed intent
└─ AgentWallet.executeWithProof(proof, signature, calls)
Result: USDC moves from buyer's AgentWallet to seller on Base
```

### Step 4: Record Receipt (Canton)
```
CrossChainSettlement.Execute choice on Canton
  → Creates ExecutionReceipt linking both proof systems
  → Immutable, private audit trail
```

## Dual ZK Proof Stack

Each settlement is backed by two independent ZK proofs with no shared trust assumptions:

| Proof | System | Proves | Verified | Visible To |
|-------|--------|--------|----------|------------|
| Balance state | RISC0 (zkVM) | EVM balance at block N | Off-chain, anchored on Canton | Custodian + AssetHolder only |
| Intent execution | Groth16 (circom) | Calldata matches signed intent | On-chain (AgentWallet) | All EVM participants |

## Quick Start

### Prerequisites

- Docker
- Node.js 18+
- Daml SDK (`curl -sSL https://get.daml.com/ | sh`)

### 1. Start Canton Sandbox

```bash
# Pull Canton and start sandbox
docker pull digitalasset/canton-open-source:latest

docker run -d --name canton-sandbox \
  -p 5011:5011 -p 7575:7575 \
  -v $(pwd)/packages/canton-settlement/canton-sandbox.conf:/canton/vaeb.conf \
  digitalasset/canton-open-source:latest \
  --config /canton/simple-topology.conf,/canton/vaeb.conf
```

### 2. Build and Deploy Daml Contracts

```bash
cd packages/canton-settlement/daml
daml build

# Upload DAR to Canton
HEADER=$(echo -n '{"alg":"HS256"}' | base64 | tr -d '=' | tr '+/' '-_')
PAYLOAD=$(echo -n '{"sub":"admin","ledgerId":"vaeb_participant","applicationId":"vaeb-canton","admin":true,"actAs":["Custodian::namespace"],"readAs":[]}' | base64 | tr -d '=' | tr '+/' '-_')

curl -X POST http://localhost:7575/v1/packages \
  -H "Authorization: Bearer ${HEADER}.${PAYLOAD}.unsigned" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @.daml/dist/canton-zk-custody-0.1.0.dar
```

### 3. Allocate Parties

```bash
for party in Custodian Seller Buyer; do
  docker exec canton-sandbox /canton/bin/canton \
    -c /canton/simple-topology.conf,/canton/vaeb.conf \
    --no-tty -e "vaeb_participant.parties.enable(\"$party\")"
done
```

### 4. Run the CLI Demo

```bash
cd packages/canton-settlement

# Check Canton health
npx ts-node src/cli.ts health

# View privacy model with live Canton queries
npx ts-node src/cli.ts privacy-demo

# Query as different parties (demonstrates visibility)
npx ts-node src/cli.ts attestations --party custodian
npx ts-node src/cli.ts attestations --party buyer      # proofHash hidden
npx ts-node src/cli.ts settlements --party seller
```

### 5. Run Tests

```bash
# All canton-settlement tests (35 tests, live Canton)
npm run test:ts -w @vaeb/canton-settlement

# MCP Canton tools tests (9 tests, live Canton)
cd packages/mcp-server
TS_NODE_PROJECT=tsconfig.test.json node --test -r ts-node/register tests/canton-tools.test.ts
```

### Stop Sandbox

```bash
docker stop canton-sandbox && docker rm canton-sandbox
```

## CLI Usage

The CLI demonstrates Canton's privacy model by querying the ledger as different parties.

```
COMMANDS:
  health                          Check Canton participant status
  attestations [--party <role>]   Query attestations (visibility varies by party)
  settlements  [--party <role>]   Query settlements (visibility varies by party)
  privacy-demo                    Full privacy model demonstration
  help                            Show help

PARTIES:
  custodian    Sees proofHash, claimDigest (signatory)
  buyer        Cannot see proof details (observer only)
  seller       Cannot see proof details (observer only)
```

## MCP Tools (AI Agent Interface)

4 tools exposed via VAEB's MCP server for AI agent orchestration:

| Tool | Description |
|------|-------------|
| `canton_health` | Check if Canton participant is reachable |
| `query_attestations` | List active CustodyAttestation contracts |
| `query_settlements` | List pending settlement contracts |
| `prepare_settlement` | Convert Canton settlement → VAEB actions |

AI agent flow:
```
Agent: canton_health()              → Canton is reachable
Agent: query_settlements()          → Found settlement #xyz (500 USDC)
Agent: query_attestations()         → Seller balance attested, valid
Agent: prepare_settlement(#xyz)     → Returns VAEB actions
Agent: create_intent(vaebActions)   → IntentBundle ready
User:  signs in MetaMask
Agent: execute_intent(signature)    → Groth16 proof + Base tx
```

## TypeScript Library

```typescript
import { CantonClient, SettlementBridge } from "@vaeb/canton-settlement";

const canton = new CantonClient({
  participantUrl: "http://localhost:7575",
  userId: "canton-zk-custody",
  actAs: ["Custodian::namespace"],
  readAs: [],
  ledgerId: "vaeb_participant",
  applicationId: "vaeb-canton",
});

const attestations = await canton.queryAttestations();
const settlements = await canton.querySettlements();

const bridge = new SettlementBridge({
  canton: { /* CantonConfig */ },
  partyToAddress: { "Seller::namespace": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
  addressToParty: { "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045": "Seller::namespace" },
  tokenAddresses: { "USDC": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  chain: "base_sepolia",
});

const { intent, vaebActions } = await bridge.prepareSettlement(settlementId);
```

## Testing

All tests run against a live Canton sandbox — no mocks, no skipping.

### Test Results (verified against Canton sandbox)

```
canton-settlement:  35 pass, 0 fail, 0 skipped  (1094ms)
mcp canton-tools:    9 pass, 0 fail, 0 skipped  ( 619ms)
─────────────────────────────────────────────────────────
Total:              44 pass, 0 fail, 0 skipped
```

### Test Coverage

| Suite | Tests | What it validates |
|-------|-------|-------------------|
| `canton-client.test.ts` | 11 | Client construction, v1/v2 API auto-detection, health check, live contract queries |
| `settlement-bridge.test.ts` | 15 | Attestation matching (chain/claimType/expiry), intent mapping, VAEB action generation |
| `e2e-workflow.test.ts` | 9 | Step 1→2→3→4 data flow, type consistency, dual ZK proof independence |
| `canton-tools.test.ts` (MCP) | 9 | Tool routing, health/query/prepare responses, config construction |

### Environment Variables

```bash
CANTON_PARTICIPANT_URL=http://localhost:7575   # JSON API endpoint
CANTON_AUTH_TOKEN=your-jwt-token               # optional (sandbox uses insecure tokens)
CANTON_USER_ID=canton-zk-custody
CANTON_ACT_AS=Custodian::namespace
CANTON_LEDGER_ID=vaeb_participant
```

## Project Structure

```
packages/canton-settlement/
├── daml/
│   ├── daml.yaml                          # Daml project config (SDK 2.10.3)
│   ├── src/
│   │   ├── CustodyAttestation.daml        # ZK attestation with privacy controls
│   │   ├── CrossChainSettlement.daml      # Multi-party settlement + receipt
│   │   └── ProofOfReserve.daml            # Aggregate portfolio view
│   └── .daml/dist/
│       └── canton-zk-custody-0.1.0.dar    # Compiled DAR (deployed to Canton)
├── src/
│   ├── canton-client.ts                   # TypeScript Canton JSON API client (v1/v2)
│   ├── settlement-bridge.ts               # Canton → VAEB bridge
│   ├── types.ts                           # Shared type definitions
│   ├── cli.ts                             # CLI demo (privacy model visualization)
│   └── index.ts                           # Library exports
├── tests/
│   ├── canton-client.test.ts              # 11 tests (live Canton)
│   ├── settlement-bridge.test.ts          # 15 tests (live Canton)
│   └── e2e-workflow.test.ts               # 9 tests (live Canton)
├── canton-sandbox.conf                    # Docker sandbox config
└── README.md                              # This file
```

## License

MIT
