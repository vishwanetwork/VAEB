# VAEB — Verified Agent Execution Bundle

AI agents executing on-chain transactions shouldn't require blind trust. VAEB is a protocol where users sign an *intent* describing what they want ("pay 25 USDC to Alice for groceries"), the agent generates a ZK proof that the derived calldata faithfully matches that intent, and the smart contract wallet verifies the proof on-chain before executing anything.

The agent can't cheat — the ZK proof cryptographically binds the signed intent to the executed calldata. No trust required.

**Non-custodial (ERC-8150)** — The user holds their own funds. The AgentWallet never touches user tokens directly — it calls `transferFrom(user, recipient, amount)` after the user approves spending and signs a ZKIntent commitment. The agent submits the transaction on behalf of the owner.

**Powered by 0G Serving** — The AI agent runs on [0G's decentralized AI inference network](https://0g.ai), not centralized APIs. 0G Serving provides an OpenAI-compatible endpoint backed by distributed GPU providers, so the entire stack — from AI reasoning to on-chain execution — is decentralized and verifiable.

Built for ETH Denver 2026 and the [0G DeFAI Hackathon](https://0g.ai). Deployed on **Kite AI Testnet** and **Base Sepolia**. Authors of [ERC-8150](doc/eip8150.md) (Zero-Knowledge Agent Payment Verification).

**x402 compatible** — VAEB MCP tools are designed to be gated by [x402](https://github.com/coinbase/x402) (HTTP 402 Payment Required). AI agents pay per tool call in USDC, directly from their wallet. The included **RentaHuman** marketplace demo shows this end-to-end: an AI agent discovers available humans, pays via x402 to hire them, and the payment is ZK-verified on-chain before execution.

---

## How it works

```
User signs intent          Agent derives calldata        Chain verifies + executes
─────────────────          ──────────────────────        ────────────────────────
"Send 100 USDC        →    transferFrom(user,       →    Groth16Verifier confirms
 to 0x...dead"             0xdead, 100e6)                proof → ECDSA checks sig
 [EIP-712 ZKIntent]        + Groth16 proof               → nonce/expiry → multicall
```

The ZK circuit (Groth16, 10,790 constraints) proves:
- `Poseidon(intentBundle fields) == commitment` on the signed intent
- calldata is the canonical derivation of that intent
- chainId, payer address, nonce, and expiry all match

Only the commitment appears on-chain — the full intent stays private.

### Non-custodial execution (ERC-8150)

```
1. User holds USDC in their own wallet (EOA)
2. User approves AgentWallet to spend USDC (ERC-20 approve)
3. User signs ZKIntent(nonce, expiry, commitment) via EIP-712
4. Agent generates Groth16 ZK proof
5. Agent calls AgentWallet.executeWithProof()
6. Contract verifies proof + signature → calls transferFrom(user, recipient, amount)
```

The agent spends money on behalf of the owner — but only what was approved, and only for the exact intent the user signed.

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
OWNER_PRIVATE_KEY=0x<owner-key>       # User who signs intents and holds funds
AGENT_PRIVATE_KEY=0x<agent-key>       # Agent EOA that submits transactions
OWNER_ADDRESS=0x<owner-address>

# AI provider — 0G decentralized inference (recommended)
LLM_PROVIDER=0g
ZG_RPC_URL=https://evmrpc-testnet.0g.ai

# Or use OpenAI / DeepSeek instead:
# LLM_PROVIDER=openai
# OPENAI_API_KEY=sk-...
# LLM_PROVIDER=deepseek
# DEEPSEEK_API_KEY=sk-...

# Chain RPCs
DEFAULT_CHAIN=kite_testnet
KITE_TESTNET_RPC_URL=https://rpc-testnet.gokite.ai
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
```

Generate wallets if needed:

```bash
node -e "const {ethers}=require('ethers'); const w=ethers.Wallet.createRandom(); console.log(w.address, w.privateKey)"
```

Fund wallets for the chain you're using:
- **Kite AI Testnet** (default): https://faucet.gokite.ai
- **Base Sepolia**: https://faucet.quicknode.com/base/sepolia
- **0G Testnet** (for AI inference): https://faucet.0g.ai — fund the agent address with A0GI

### 3. Build

```bash
npm run build
```

### 4. Deploy contracts

```bash
node scripts/deploy.js
```

This deploys Groth16Verifier, Groth16VerifierAdapter, MockUSDC, and AgentWallet. It also:
- Mints 1000 USDC to the owner (non-custodial)
- Approves AgentWallet to spend owner's USDC
- Updates `.env`, frontend config, and server config with new addresses

Deploy to other chains via `DEFAULT_CHAIN`:

```bash
DEFAULT_CHAIN=kite_testnet node scripts/deploy.js  # Kite AI Testnet (default)
DEFAULT_CHAIN=base_sepolia node scripts/deploy.js  # Base Sepolia
```

### 5. Run the ZK demo (standalone)

```bash
node scripts/demo-zkproof.js
```

This deploys fresh contracts with a real Groth16 verifier (not mock) and runs the full pipeline end-to-end:

```
✅ Minted 1000 USDC to owner (non-custodial)
✅ Owner approved AgentWallet to spend up to 1000 USDC
✅ Proof generated in 0.4s
✅ Owner signed ZKIntent(nonce, expiry, commitment)
✅ CONFIRMED — executeWithProof() succeeded
   Owner USDC: 900.0 (was 1000.0)
   Recipient:  100.0 (was 0.0)
✅ ALL CHECKS PASSED — real ZK proof verified on-chain (non-custodial)!
```

### 6. Run the full stack (chat UI + agent)

**Terminal 1 — Prover service** (port 3001, generates Groth16 proofs):
```bash
cd packages/prover-service && npm start
```

**Terminal 2 — Express backend** (port 3002, AI agent + MCP tool bridge):
```bash
cd packages/server && npm run dev
```

**Terminal 3 — Frontend** (port 5173, React chat UI):
```bash
cd packages/frontend && npm run dev
```

Or run all at once:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173), connect MetaMask (use the owner wallet from `.env`), and chat:

- *"I need someone to walk my dog"* — marketplace flow
- *"What's my balance?"* — check USDC balance
- *"Send 10 USDC to 0x..."* — direct transfer intent

The UI shows available MCP tools, real-time execution logs, and on-chain transaction results. The agent will:
1. Check existing USDC allowance (skips approve if already sufficient)
2. Request your EIP-712 signature on the ZKIntent
3. Generate a ZK proof and execute on-chain

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
│   ├── frontend/                   # React + Vite chat UI (MetaMask + tools panel)
│   ├── intent-sdk/                 # TypeScript SDK — build IntentBundles, derive calldata
│   ├── mcp-server/                 # MCP server — 23 tools for AI agent integration
│   ├── prover-service/             # ZK prover service wrapping snarkjs
│   └── server/                     # Express backend — 0G/OpenAI chat + MCP tool bridge
├── scripts/
│   ├── deploy.js                   # Deploy contracts (chain-configurable via DEFAULT_CHAIN)
│   ├── deploy-kite.js              # Deploy to Kite AI Testnet
│   ├── setup-kite.js               # Mint USDC + approve on Kite (post-deploy fix)
│   ├── deploy-mcp.js               # Build and configure the MCP server
│   ├── demo-zkproof.js             # End-to-end ZK demo (real Groth16 on-chain)
│   └── demo-live.js                # Simple demo (executeDirectly, no ZK)
└── contracts/deployments/
    └── deployments.json            # Deployed contract addresses (all chains)
```

---

## Packages

### `@vaeb/intent-sdk`

Builds IntentBundles, derives calldata, computes Poseidon commitments, generates ZKIntent EIP-712 typed data.

```typescript
import { createIntentBundle, deriveCalldata, getZKIntentTypedData } from '@vaeb/intent-sdk';

const bundle = createIntentBundle({
  actions: [{ type: 'TRANSFER', token: 'USDC', amount: 100, recipient: '0x...' }],
  chainId: 84532,
  walletAddress: '0x...agentWallet',
  expiryMinutes: 10,
});

// Non-custodial: derives transferFrom(owner, recipient, amount) calldata
const derived = deriveCalldata(bundle, 'base_sepolia', '0x...ownerAddress');

// EIP-712 typed data for user to sign
const eip712 = getZKIntentTypedData(nonce, expiry, commitmentHex, walletAddress, chainId);
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

### `prover-service`

HTTP service wrapping snarkjs. The MCP server and Express backend call `POST /prove` to generate Groth16 proofs.

```bash
cd packages/prover-service
npm start   # default port 3001
```

The MCP server falls back to `executeDirectly()` (signature-only, no ZK proof) if the prover is unreachable.

### `server` + `frontend`

Full-stack demo: React chat UI where you can talk to an AI agent that executes real on-chain payments.

**AI Providers** — Set `LLM_PROVIDER` in `.env`:

| Provider | Model | How it works |
|---|---|---|
| `0g` | Qwen 2.5 7B (auto-discovered) | 0G decentralized AI serving — OpenAI-compatible API via distributed GPU providers. Uses prompt-based tool calling. |
| `openai` | GPT-4o-mini | OpenAI API with native function calling |
| `deepseek` | deepseek-chat | DeepSeek API with native function calling |

The 0G provider uses `@0glabs/0g-serving-broker` to discover available inference services, manage sub-account funding (A0GI tokens), and route requests through 0G's decentralized network. The agent wallet's private key (`AGENT_PRIVATE_KEY`) doubles as the 0G wallet.

The frontend flow:
1. Connect MetaMask → chat with agent
2. Agent creates intent → frontend shows payment card with MCP tool call log
3. User clicks "Sign & Pay" → signs ZKIntent → agent executes with ZK proof

### RentaHuman — x402 marketplace demo

The built-in **RentaHuman** marketplace shows how VAEB combines ZK-verified execution with [x402](https://github.com/coinbase/x402) (HTTP 402 Payment Required):

1. AI agent calls `search_marketplace` to find available humans
2. Agent calls `hire_human` — this triggers an **x402 payment request** before the intent is created
3. User approves USDC spending for the AgentWallet (ERC-20 approve)
4. User signs `ZKIntent(nonce, expiry, commitment)` via EIP-712 in MetaMask
5. VAEB generates a Groth16 ZK proof binding the payment intent to the calldata
6. `AgentWallet.executeWithProof()` verifies the proof on-chain and calls `transferFrom(user, recipient, amount)`

Try it in the chat UI: *"I need someone to walk my dog"*

---

## Execution flow

```
┌──────────┐   approve + sign   ┌──────────┐  POST /prove   ┌──────────────────┐
│  User /  │ ──────────────────▶ │  Agent   │ ─────────────▶ │  prover-service  │
│ Frontend │  1. ERC-20 approve │(MCP/API) │ ◀───────────── │  (snarkjs)       │
│          │  2. ZKIntent sig   └────┬─────┘  Groth16 proof └──────────────────┘
└──────────┘                         │
                                     │ executeWithProof(proof, sig, publicInputs, calls)
                                     ▼
                            ┌────────────────────┐
                            │   AgentWallet.sol  │
                            │  1. verify proof   │
                            │  2. recover sig    │
                            │  3. check nonce    │
                            │  4. check expiry   │
                            │  5. transferFrom   │
                            │     (user→recip)   │
                            └────────────────────┘
```

If the prover service is unavailable, execution falls back to `executeDirectly()` — ECDSA signature only, no ZK proof.

---

## Contracts

### AgentWallet

The core ERC-8150 smart wallet. Non-custodial — the agent executes on behalf of the owner.

```solidity
// Full ZK path — agent submits proof, contract calls transferFrom(owner, ...)
function executeWithProof(
    bytes calldata proof,
    bytes calldata signature,
    PublicInputs calldata publicInputs,
    Call[] calldata calls
) external;

// Fallback — signature only, no ZK proof
function executeDirectly(
    bytes calldata signature,
    bytes32 nonce,
    uint256 expiry,
    Call[] calldata calls
) external;
```

The user signs `ZKIntent(bytes32 nonce, uint256 expiry, bytes32 commitment)` via EIP-712, where `commitment` is the Poseidon hash of the intent bundle.

### AgentWalletFactory

CREATE2 factory. The wallet address is deterministic before deployment.

```solidity
function createWallet(address owner, address agent, bytes32 salt) returns (address);
function predictWalletAddress(address owner, address agent, bytes32 salt) view returns (address);
function getWallets(address owner) view returns (address[]);
```

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
| 2 | `chainId` | Chain ID (84532 for Base Sepolia, 2368 for Kite AI Testnet) |
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
| `node scripts/deploy.js` | Deploy contracts (chain-configurable via `DEFAULT_CHAIN`) |
| `node scripts/deploy-kite.js` | Deploy to Kite AI Testnet specifically |
| `node scripts/setup-kite.js` | Mint USDC to owner + approve AgentWallet on Kite |
| `node scripts/deploy-mcp.js` | Build MCP server, print Claude Desktop config |
| `node scripts/demo-zkproof.js` | Full end-to-end ZK demo (real Groth16, non-custodial) |
| `node scripts/demo-live.js` | Simple demo using `executeDirectly()` |
| `node scripts/test-mcp-tools.js` | Smoke-test MCP tool calls |

---

## Troubleshooting

| Error | Fix |
|---|---|
| `Missing circuit artifact: WASM` | Rebuild the circuit (see above) |
| `InvalidProof()` on-chain | `.zkey`, `.wasm`, and `Groth16Verifier.sol` must come from the same trusted setup |
| `InvalidSignature()` on-chain | EIP-712 domain separator mismatch — check wallet address and ZKIntent types |
| `deployed but has no code` | L2 RPC propagation delay — deploy script retries automatically |
| `INSUFFICIENT_FUNDS` | Owner needs gas on the target chain (KITE for Kite, ETH for Base Sepolia) |
| `eth_sendTransaction` 405 | RPC doesn't support `eth_sendTransaction` — run `node scripts/setup-kite.js` to pre-approve via private key |
| Prover unavailable | Falls back to `executeDirectly()` automatically |
| `NonceAlreadyUsed` | Intent was already executed — each nonce is single-use |
| 0G "No chatbot services" | No inference providers available — check https://docs.0g.ai or switch to `LLM_PROVIDER=openai` |

---

## Supported chains

| Chain | Chain ID | Default | RPC |
|---|---|---|---|
| Kite AI Testnet | 2368 | Yes | `https://rpc-testnet.gokite.ai` |
| Base Sepolia | 84532 | | `https://sepolia.base.org` |

Set `DEFAULT_CHAIN` in `.env` to switch. The frontend chain selector lets users switch at runtime.

---

## What's not yet implemented

- ERC-8004 on-chain reputation registry (trust tools use hardcoded demo data)
- x402 enforcement on MCP tools (tools are marked as paid with fees defined, but HTTP 402 gating is not yet wired — the RentaHuman marketplace flow demonstrates the pattern)
- Contract verification on block explorers
- Production trusted setup (uses local ceremony; production should use Hermez ptau)
