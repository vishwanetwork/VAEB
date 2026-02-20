# VAEB — Verified Agent Execution Bundle

AI agents executing on-chain transactions shouldn't require blind trust. VAEB is a protocol where users sign an *intent* describing what they want ("pay 25 USDC to Alice for groceries"), the agent generates a ZK proof that the derived calldata faithfully matches that intent, and the smart contract wallet verifies the proof on-chain before executing anything.

The agent can't cheat — the ZK proof cryptographically binds the signed intent to the executed calldata. No trust required.

Built for ETH Denver 2026 on Base Sepolia. Authors of [ERC-8150](doc/eip8150.md) (Zero-Knowledge Agent Payment Verification).

---

## How it works

```
User signs intent          Agent derives calldata        Chain verifies + executes
─────────────────          ──────────────────────        ────────────────────────
"Send 100 USDC        →    transferFrom(payer,      →    Groth16Verifier confirms
 to 0x...dead"             0xdead, 100e6)                proof → ECDSA checks sig
 [EIP-712 sig]             + Groth16 proof               → nonce/expiry → multicall
```

The ZK circuit (Groth16, 10,790 constraints) proves:
- `Poseidon(intentBundle fields) == commitment` on the signed intent
- calldata is the canonical derivation of that intent
- chainId, payer address, nonce, and expiry all match

Only the commitment appears on-chain — the full intent stays private.

---

## Repository structure

```
vaeb/
├── circuits/
│   └── IntentVerifier.circom       # Groth16 circuit (10,790 constraints)
│       build/                      # Compiled .wasm, .zkey, verification_key.json
├── contracts/src/
│   ├── AgentWallet.sol             # ERC-8150 smart wallet — executeWithProof() / executeDirectly()
│   ├── AgentWalletFactory.sol      # CREATE2 factory — deterministic wallet deployment
│   ├── Groth16Verifier.sol         # snarkjs-generated on-chain pairing verifier
│   ├── Groth16VerifierAdapter.sol  # Bridges AgentWallet ↔ snarkjs verifier interface
│   └── mocks/MockERC20.sol         # Test USDC
├── packages/
│   ├── frontend/                   # React + Vite chat UI (MetaMask integration)
│   ├── intent-sdk/                 # TypeScript SDK — build IntentBundles, derive calldata
│   ├── mcp-server/                 # MCP server — 23 tools for AI agent integration
│   ├── prover-service/             # ZK prover service wrapping snarkjs
│   └── server/                     # Express backend — AI chat + tool execution bridge
├── scripts/
│   ├── deploy.js                   # Deploy contracts → deployments.json
│   ├── deploy-mcp.js               # Build and configure the MCP server
│   ├── demo-zkproof.js             # End-to-end ZK demo (real Groth16 on-chain)
│   └── demo-live.js                # Simple demo (executeDirectly, no ZK)
└── contracts/deployments/
    └── deployments.json            # Deployed contract addresses (source of truth)
```

---

## Deployed contracts — Base Sepolia

All deployed addresses live in [`contracts/deployments/deployments.json`](contracts/deployments/deployments.json). Scripts and packages read from this file automatically — no manual address copy-paste needed.

| Contract | Address |
|---|---|
| AgentWallet | [`0x99D238c22499e679e9d45578245083FE690C8B5f`](https://sepolia.basescan.org/address/0x99D238c22499e679e9d45578245083FE690C8B5f) |
| AgentWalletFactory | [`0x9A92E10B3F62910254923CBfF59C3b1B4FFAcB41`](https://sepolia.basescan.org/address/0x9A92E10B3F62910254923CBfF59C3b1B4FFAcB41) |
| Groth16Verifier | [`0xB533793f4813822CFb326b75b8D459d8A9faCF4F`](https://sepolia.basescan.org/address/0xB533793f4813822CFb326b75b8D459d8A9faCF4F) |
| Groth16VerifierAdapter | [`0x4FD7cb52eE367B9eC7Ec84d862B28C2230CCdaEE`](https://sepolia.basescan.org/address/0x4FD7cb52eE367B9eC7Ec84d862B28C2230CCdaEE) |
| MockUSDC | [`0x93560481FE085E4Fd1A0f0bAb2E625118A67aC1D`](https://sepolia.basescan.org/address/0x93560481FE085E4Fd1A0f0bAb2E625118A67aC1D) |

---

## Quick start

### 1. Install

```bash
git clone https://github.com/vishwanetwork/VAEB
cd VAEB
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

```env
OWNER_PRIVATE_KEY=0x<owner-key>       # User who signs intents
AGENT_PRIVATE_KEY=0x<agent-key>       # Agent EOA that submits transactions
OWNER_ADDRESS=0x<owner-address>
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
CHAIN_ID=84532

# AI chat backend (pick one)
OPENAI_API_KEY=sk-...
# or
DEEPSEEK_API_KEY=sk-...
```

Generate wallets if needed:

```bash
node -e "const {ethers}=require('ethers'); const w=ethers.Wallet.createRandom(); console.log(w.address, w.privateKey)"
```

Fund both with Base Sepolia ETH (owner needs ~0.01, agent needs ~0.001):
- https://faucet.quicknode.com/base/sepolia
- https://www.alchemy.com/faucets/base-sepolia

### 3. Build TypeScript packages

```bash
npm run build
```

### 4. Run the ZK demo (standalone)

```bash
node scripts/demo-zkproof.js
```

Expected output:

```
✅ Proof generated in 12.3s
Off-chain verification: ✅ VALID
→ AgentWallet.executeWithProof() confirmed in block 37597574
AgentWallet USDC: 900.0 (was 1000.0)
Recipient USDC:   100.0 (was 0.0)
✅ ALL CHECKS PASSED — real ZK proof verified on-chain!
```

### 5. Run the full stack (chat UI + agent)

Open four terminals:

**Terminal 1 — Prover service** (generates Groth16 proofs):
```bash
cd packages/prover-service
npm start
# Listening on http://localhost:3001
# POST /prove  POST /verify  GET /health
```

**Terminal 2 — Express backend** (AI agent + MCP tool bridge):
```bash
cd packages/server
npm run dev
# Listening on http://localhost:3002
# Requires OPENAI_API_KEY or DEEPSEEK_API_KEY in .env
```

**Terminal 3 — Frontend** (React chat UI):
```bash
cd packages/frontend
npm run dev
# Open http://localhost:5173
```

Then open [http://localhost:5173](http://localhost:5173), connect MetaMask, and chat with the agent. Example prompts:

- *"What's my wallet balance?"*
- *"Hire Alice to buy groceries for 25 USDC"*
- *"Send 10 USDC to 0x..."*

The agent will ask you to sign the intent in MetaMask, then generate a ZK proof and execute it on-chain automatically.

---

## Packages

### `@vaeb/intent-sdk`

Builds IntentBundles, derives calldata, computes intent IDs.

```typescript
import { createIntentBundle, deriveCalldata, computeIntentId } from '@vaeb/intent-sdk';

const bundle = createIntentBundle({
  actions: [{ type: 'TRANSFER', token: 'USDC', amount: 100, recipient: '0x...' }],
  chainId: 84532,
  walletAddress: '0x...',
  expiryMinutes: 10,
});

const derived = deriveCalldata(bundle, 'base_sepolia');
const intentId = computeIntentId(bundle);
```

### `@vaeb/mcp-server`

MCP server exposing 23 tools to AI agents via Claude Desktop or any MCP client.

**Tool categories:**

| Category | Tools |
|---|---|
| Chain (read-only) | `get_wallet_balance`, `read_balance`, `check_nonce`, `get_price`, `estimate_gas`, `get_receipt` |
| Intent | `create_intent`, `execute_intent`, `simulate_intent`, `cancel_intent` |
| Wallet | `create_wallet`, `predict_wallet`, `get_wallets` |
| Trust | `discover_agents`, `get_agent_reputation`, `get_agent_validations`, `post_feedback`, `compare_agents` |
| Marketplace | `search_marketplace`, `hire_human`, `get_wallet_balance`, `execute_payment` |
| Verify | `prove_intent`, `verify_proof` |

**Deploy the MCP server:**

```bash
node scripts/deploy-mcp.js
```

This builds the server, validates env vars and deployed contracts, then prints the Claude Desktop config snippet:

```json
{
  "mcpServers": {
    "vaeb": {
      "command": "node",
      "args": ["/path/to/VAEB/packages/mcp-server/dist/index.js"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x...",
        "BASE_SEPOLIA_RPC_URL": "https://..."
      }
    }
  }
}
```

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

**Run in dev mode:**

```bash
cd packages/mcp-server
npm run dev
```

**Run integration tests:**

```bash
cd packages/mcp-server
npm run test:integration   # 36 tests across all tool categories
```

### `prover-service`

HTTP service wrapping snarkjs. The MCP server and Express backend call `POST /prove` to generate Groth16 proofs.

```bash
cd packages/prover-service
npm start   # default port 3001
```

The MCP server falls back to `executeDirectly()` (signature-only, no ZK proof) if the prover is unreachable.

### `server` + `frontend`

Full-stack demo: React chat UI where you can talk to an AI agent that executes real on-chain payments.

Requires the prover service running on port 3001 (see Quick start step 5).

```bash
# Terminal 1 — prover service (port 3001)
cd packages/prover-service && npm start

# Terminal 2 — Express backend (port 3002)
cd packages/server && npm run dev

# Terminal 3 — frontend (port 5173)
cd packages/frontend && npm run dev
```

The frontend connects MetaMask, shows wallet balances, and lets you chat with the agent. The agent uses the MCP tool pipeline to construct, prove, and execute intents.

---

## Execution flow

```
┌──────────┐   sign intent    ┌──────────┐  POST /prove   ┌──────────────────┐
│  User /  │ ──────────────▶  │  Agent   │ ─────────────▶ │  prover-service  │
│ Frontend │                  │(MCP/API) │ ◀───────────── │  (snarkjs)       │
└──────────┘                  └────┬─────┘  Groth16 proof └──────────────────┘
                                   │
                                   │ executeWithProof(proof, sig, publicInputs, calls)
                                   ▼
                          ┌────────────────────┐
                          │   AgentWallet.sol  │
                          │  1. verify proof   │
                          │  2. recover sig    │
                          │  3. check nonce    │
                          │  4. check expiry   │
                          │  5. multicall      │
                          └────────────────────┘
```

If the prover service is unavailable, execution falls back to `executeDirectly()` — ECDSA signature only, no ZK proof.

---

## Contracts

### AgentWallet

The core ERC-8150 smart wallet. Two execution paths:

```solidity
// Full ZK path
function executeWithProof(
    bytes calldata proof,
    bytes calldata signature,
    PublicInputs calldata publicInputs,
    Call[] calldata calls
) external;

// Fallback — signature only
function executeDirectly(
    bytes calldata signature,
    bytes32 nonce,
    uint256 expiry,
    Call[] calldata calls
) external;
```

### AgentWalletFactory

CREATE2 factory. The wallet address is deterministic before deployment.

```solidity
function createWallet(address owner, address agent, bytes32 salt) returns (address);
function predictWalletAddress(address owner, address agent, bytes32 salt) view returns (address);
function getWallets(address owner) view returns (address[]);
```

Use the `create_wallet` / `predict_wallet` / `get_wallets` MCP tools (or the scripts directly) to manage wallets.

### Groth16VerifierAdapter

Bridges AgentWallet's `IGroth16Verifier` interface to the snarkjs-generated verifier's function signature. Prepends the circuit output signal (`valid = 1`) to the 6 public inputs, mapping them to the format snarkjs exports.

---

## ZK circuit

The `IntentVerifier.circom` circuit proves (off-chain) that:

1. `Poseidon(intentBundle fields) == commitment`
2. calldata was correctly derived from each action in the bundle
3. `chainId`, `payer`, `nonce`, `expiry` in the bundle match the public inputs

**Public signals** (ordered as snarkjs exports them):

| Index | Signal | Description |
|---|---|---|
| 0 | `valid` (output) | Always 1 when constraints pass |
| 1 | `commitment` | Poseidon hash of the IntentBundle |
| 2 | `chainId` | 84532 for Base Sepolia |
| 3 | `signerAddress` | Owner address (uint160) |
| 4 | `multicallDataHash` | Poseidon hash of derived calldata |
| 5 | `nonce` | Replay-prevention nonce |
| 6 | `expiry` | Expiration timestamp |

### Rebuild the circuit

Skip this if `circuits/build/` already has `.wasm`, `.zkey`, and `verification_key.json`.

```bash
# Install circom
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
git clone https://github.com/iden3/circom && cd circom
cargo build --release && cargo install --path circom

# Compile
cd VAEB/circuits
npm install
mkdir -p build
circom IntentVerifier.circom --r1cs --wasm --sym --output build -l node_modules

# Trusted setup
npx snarkjs powersoftau new bn128 14 build/pot14_0000.ptau
npx snarkjs powersoftau contribute build/pot14_0000.ptau build/pot14_0001.ptau --name="VAEB"
npx snarkjs powersoftau prepare phase2 build/pot14_0001.ptau build/pot14_final.ptau
npx snarkjs groth16 setup build/IntentVerifier.r1cs build/pot14_final.ptau build/IntentVerifier_0000.zkey
npx snarkjs zkey contribute build/IntentVerifier_0000.zkey build/IntentVerifier_final.zkey --name="VAEB"
npx snarkjs zkey export verificationkey build/IntentVerifier_final.zkey build/verification_key.json

# Export Solidity verifier
npx snarkjs zkey export solidityverifier build/IntentVerifier_final.zkey build/Groth16Verifier.sol
cp build/Groth16Verifier.sol ../contracts/src/
```

---

## Scripts

| Script | What it does |
|---|---|
| `node scripts/deploy.js` | Deploy contracts to Base Sepolia, write `deployments.json` |
| `node scripts/deploy-mcp.js` | Build MCP server, print Claude Desktop config |
| `node scripts/deploy-mcp.js --no-build` | Skip build, just validate + print config |
| `node scripts/demo-zkproof.js` | Full end-to-end ZK demo on Base Sepolia |
| `node scripts/demo-live.js` | Simple demo using `executeDirectly()` |
| `node scripts/register-agent.js` | Register agent EOA with the factory |
| `node scripts/test-contracts.js` | Test deployed contracts |
| `node scripts/test-mcp-tools.js` | Smoke-test MCP tool calls |

---

## Troubleshooting

| Error | Fix |
|---|---|
| `Missing circuit artifact: WASM` | Rebuild the circuit (see above) |
| `InvalidProof()` on-chain | `.zkey`, `.wasm`, and `Groth16Verifier.sol` must come from the same trusted setup |
| `InvalidSignature()` on-chain | EIP-712 domain separator mismatch — check wallet address |
| `Tool X is already registered` | Duplicate in `tool-registry.ts` — check for repeated tool names |
| `deployed but has no code` | L2 RPC propagation delay — script retries automatically |
| `INSUFFICIENT_FUNDS` | Owner needs ~0.01 ETH, agent needs ~0.001 ETH on Base Sepolia |
| Prover unavailable | MCP server falls back to `executeDirectly()` automatically |
| `execution reverted` from factory | Check ABI — `walletCount(address owner)` not `walletCount()` |

---

## What's not yet implemented

- ERC-8004 on-chain reputation registry (trust tools use hardcoded demo data)
- x402 payment gating (MCP server defines paid tools but doesn't enforce HTTP 402)
- Contract verification on BaseScan
- Production trusted setup (uses local ceremony; production should use Hermez ptau)
