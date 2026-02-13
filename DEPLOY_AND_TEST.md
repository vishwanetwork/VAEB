# VAEB — Verified Agent Execution Bundle

VAEB is a protocol that lets AI agents execute on-chain transactions on behalf of users with cryptographic guarantees. The user signs an intent describing *what* they want (e.g. "send 100 USDC to Alice"). The agent derives the exact calldata, generates a ZK proof that the calldata faithfully matches the intent, and submits it to a smart contract wallet that verifies everything on-chain before executing.

The ZK proof ensures the agent can't cheat — it cryptographically binds the signed intent to the executed calldata without revealing the intent itself on-chain.

Built for ETH Denver 2026 on Base Sepolia. Implements [ERC-8150](https://eips.ethereum.org/EIPS/eip-8150) (Agent Wallet).

## What's in the repo

```
vaeb/
├── circuits/                    # ZK circuit (circom)
│   └── IntentVerifier.circom    # Groth16 circuit: 10,790 constraints
├── contracts/src/               # Solidity contracts
│   ├── AgentWallet.sol          # Core ERC-8150 wallet
│   ├── Groth16Verifier.sol      # snarkjs-generated on-chain verifier
│   ├── Groth16VerifierAdapter.sol # Bridges AgentWallet ↔ snarkjs interface
│   └── mocks/                   # MockERC20 for testing
├── packages/
│   ├── intent-sdk/              # TypeScript SDK for constructing IntentBundles
│   ├── mcp-server/              # MCP server for AI agent tool integration
│   └── prover-service/          # ZK prover service wrapping snarkjs
├── scripts/
│   ├── demo-zkproof.js          # Full ZK demo (real Groth16 on Base Sepolia)
│   └── demo-live.js             # Simple demo (executeDirectly, no ZK)
└── DEPLOY_AND_TEST.md           # This file
```

## What works

- **Real Groth16 ZK proofs on-chain** — the circuit compiles, trusted setup completes, proofs generate and verify both off-chain and on-chain via the snarkjs-generated verifier contract on Base Sepolia.
- **`executeWithProof()`** — the full ZK path: proof generation → on-chain verification → atomic call execution. Verified working on Base Sepolia.
- **`executeDirectly()`** — the simpler path with just an owner signature (no ZK proof). Also works on Base Sepolia.
- **EIP-712 signatures** — owner signs intents, contract recovers and verifies the signer.
- **Nonce replay protection** — each intent can only execute once.
- **Expiry enforcement** — stale intents are rejected.
- **`@vaeb/intent-sdk`** — builds and passes 13 unit tests (bundle creation, serialization, calldata derivation).

## Quick start

If you just want to see the ZK demo run end-to-end, you need three things: Node.js, circom, and some Base Sepolia ETH.

```bash
# 1. Install dependencies
cd vaeb
npm install

# 2. Compile the circuit + trusted setup (see Step 3 below for details)
#    Skip if circuits/build/ already has .wasm, _final.zkey, and verification_key.json

# 3. Compile contracts
cd contracts
npx solcjs --abi --bin --include-path ../node_modules --base-path . \
  src/Groth16Verifier.sol src/Groth16VerifierAdapter.sol \
  src/AgentWallet.sol src/mocks/MockERC20.sol -o out/
cd ..

# 4. Configure .env (see Step 2 below)

# 5. Run the ZK demo
node scripts/demo-zkproof.js
```

---

## Step-by-step guide

### Step 1: Install dependencies

```bash
cd vaeb
npm install
```

This installs everything for the monorepo (root + all workspaces), including `snarkjs`, `circomlibjs`, `ethers`, and `dotenv`.

To build the TypeScript packages (optional — only needed if you're using the SDK or MCP server):

```bash
npm run build
```

### Step 2: Configure wallets

You need two wallets on Base Sepolia — an **owner** (the user) and an **agent** (the AI).

Generate them if needed:

```bash
node -e "const {ethers}=require('ethers'); const w=ethers.Wallet.createRandom(); console.log('Address:', w.address, '\nKey:', w.privateKey)"
```

Create `.env` from the example:

```env
OWNER_PRIVATE_KEY=0x<your-owner-key>
AGENT_PRIVATE_KEY=0x<your-agent-key>
OWNER_ADDRESS=0x<your-owner-address>
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
CHAIN_ID=84532
```

Fund both wallets with Base Sepolia ETH (owner needs ~0.01, agent needs ~0.001):

- https://www.alchemy.com/faucets/base-sepolia
- https://faucet.quicknode.com/base/sepolia

### Step 3: Compile the ZK circuit

Skip this step if `circuits/build/` already contains `IntentVerifier.wasm`, `IntentVerifier_final.zkey`, `verification_key.json`, and `Groth16Verifier.sol`.

#### 3a. Install circom

```bash
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
source ~/.cargo/env
git clone https://github.com/iden3/circom.git
cd circom && cargo build --release && cargo install --path circom
circom --version  # should print 2.1.x
```

#### 3b. Install circuit dependencies

```bash
cd vaeb/circuits
npm install   # installs circomlib (Poseidon, comparators, etc.)
```

#### 3c. Compile

```bash
cd vaeb/circuits
mkdir -p build
circom IntentVerifier.circom --r1cs --wasm --sym --output build -l node_modules
```

Produces `build/IntentVerifier.r1cs`, `build/IntentVerifier_js/IntentVerifier.wasm`, and `build/IntentVerifier.sym`. The circuit has 10,790 constraints.

#### 3d. Trusted setup

```bash
cd vaeb/circuits

# Phase 1: Powers of Tau
npx snarkjs powersoftau new bn128 14 build/pot14_0000.ptau -v
npx snarkjs powersoftau contribute build/pot14_0000.ptau build/pot14_0001.ptau --name="VAEB" -v
npx snarkjs powersoftau prepare phase2 build/pot14_0001.ptau build/pot14_final.ptau -v

# Phase 2: Circuit-specific
npx snarkjs groth16 setup build/IntentVerifier.r1cs build/pot14_final.ptau build/IntentVerifier_0000.zkey
npx snarkjs zkey contribute build/IntentVerifier_0000.zkey build/IntentVerifier_final.zkey --name="VAEB" -v
npx snarkjs zkey export verificationkey build/IntentVerifier_final.zkey build/verification_key.json
```

#### 3e. Generate the Solidity verifier

```bash
npx snarkjs zkey export solidityverifier build/IntentVerifier_final.zkey build/Groth16Verifier.sol
cp build/Groth16Verifier.sol ../contracts/src/
```

#### 3f. Clean up intermediates (optional)

```bash
rm -f build/pot14_0000.ptau build/pot14_0001.ptau build/IntentVerifier_0000.zkey
```

Only `pot14_final.ptau`, `IntentVerifier_final.zkey`, and `verification_key.json` are needed going forward.

### Step 4: Compile contracts

```bash
cd vaeb/contracts
npx solcjs --abi --bin --include-path ../node_modules --base-path . \
  src/Groth16Verifier.sol src/Groth16VerifierAdapter.sol \
  src/AgentWallet.sol src/mocks/MockERC20.sol -o out/
```

Check that `out/` contains `src_Groth16Verifier_sol_Groth16Verifier.abi` and `src_AgentWallet_sol_AgentWallet.abi` (among others).

### Step 5: Run the ZK demo

```bash
cd vaeb
node scripts/demo-zkproof.js
```

This does everything end-to-end:

1. Deploys 4 contracts to Base Sepolia (Groth16Verifier, Adapter, MockUSDC, AgentWallet)
2. Mints 1000 test USDC to the AgentWallet
3. Constructs an intent: "transfer 100 USDC to 0x...dead"
4. Computes the Poseidon commitment matching the circuit
5. Generates a real Groth16 proof (~10-30 seconds)
6. Verifies the proof off-chain first
7. Runs diagnostics comparing on-chain vs off-chain signals
8. Owner signs the intent (EIP-712), agent submits `executeWithProof()`
9. On-chain verifier cryptographically checks the proof — no mocks
10. Verifies final balances: wallet has 900 USDC, recipient has 100 USDC

Expected output:

```
✅ Proof generated in 12.3s
Off-chain verification: ✅ VALID

TEST 1: Direct call to Groth16Verifier (exact snarkjs signals)...
→ Result: ✅ TRUE

⚡ Agent calling executeWithProof()...
✅ CONFIRMED in block 37597574
Gas used: 358333
Status: SUCCESS ✓

AgentWallet USDC: 900.0 (was 1000.0)
Recipient USDC:   100.0 (was 0.0)
Nonce used:       true

✅ ALL CHECKS PASSED — real ZK proof verified on-chain!
```

### Step 6 (optional): Run the simple demo

```bash
node scripts/demo-live.js
```

This runs the `executeDirectly()` path — no ZK proof, just owner signature + agent submission. Useful for testing wallet basics without the circuit.

---

## Architecture

```
User (owner)                    Agent                        Base Sepolia
     |                            |                               |
     |  1. Sign IntentBundle      |                               |
     |  (EIP-712 typed data)      |                               |
     |--------------------------->|                               |
     |                            |  2. Derive calldata           |
     |                            |  3. Compute Poseidon          |
     |                            |     commitment (off-chain)    |
     |                            |  4. Generate Groth16 proof    |
     |                            |     (snarkjs.fullProve)       |
     |                            |                               |
     |                            |  5. Submit to AgentWallet:    |
     |                            |     executeWithProof(         |
     |                            |       proof, signature,       |
     |                            |       publicInputs, calls)    |
     |                            |------------------------------>|
     |                            |                               |
     |                            |     AgentWallet on-chain:     |
     |                            |     6. Groth16Verifier checks |
     |                            |        proof math (pairing)   |
     |                            |     7. ECDSA.recover checks   |
     |                            |        owner's signature      |
     |                            |     8. Nonce + expiry +       |
     |                            |        chainId checks         |
     |                            |     9. Execute calls          |
     |                            |        atomically             |
     |                            |                               |
     |                            |<------ receipt ---------------|
```

The ZK proof (step 6) guarantees that the calldata (step 9) was faithfully derived from the user's signed intent (step 1). The intent itself stays private — only the commitment appears on-chain.

### Contract stack

- **AgentWallet** — the core wallet. Holds assets, executes calls. Has two paths: `executeWithProof()` (ZK) and `executeDirectly()` (signature only). Implements ERC-8150.
- **Groth16VerifierAdapter** — bridges AgentWallet's `IGroth16Verifier` interface (`verifyProof(bytes, uint256[])`) to the snarkjs-generated verifier's interface (`verifyProof(uint[2], uint[2][2], uint[2], uint[7])`). Prepends the circuit's output signal (`valid = 1`) to the 6 public inputs.
- **Groth16Verifier** — auto-generated by snarkjs from the trusted setup. Pure assembly, does elliptic curve scalar multiplications and a pairing check. ~200K gas per verification.

### Circuit public signals

The IntentVerifier circuit has 6 public inputs and 1 output:

| Index | Signal | Description |
|-------|--------|-------------|
| 0 | `valid` (output) | Always 1 when constraints pass |
| 1 | `commitment` | Poseidon hash of the IntentBundle |
| 2 | `chainId` | Target chain (84532 for Base Sepolia) |
| 3 | `signerAddress` | Owner's address (uint160) |
| 4 | `multicallDataHash` | Poseidon hash of derived calldata |
| 5 | `nonce` | Replay prevention nonce |
| 6 | `expiry` | Intent expiration timestamp |

snarkjs orders signals as `[outputs, ...inputs]`, so the output comes first. The adapter handles this ordering.

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Missing circuit artifact: WASM` | Circuit not compiled | Run Step 3c |
| `Missing compiled Groth16Verifier` | Verifier not in `contracts/out/` | Run Step 4 |
| `Cannot find module 'circomlibjs'` | Missing Poseidon library | `npm install circomlibjs` |
| `InvalidProof()` on-chain | Proof rejected by verifier | Ensure `.zkey`, `.wasm`, and `Groth16Verifier.sol` came from the same trusted setup. Check Step 5b diagnostic output. |
| `InvalidSignature()` on-chain | EIP-712 signature mismatch | Domain separator or commitment doesn't match. Check wallet address in domain. |
| `deployed but has no code` | L2 RPC consistency delay | Script retries automatically (5 attempts). If persistent, try again. |
| `INSUFFICIENT_FUNDS` | Not enough testnet ETH | Owner needs ~0.01 ETH, agent needs ~0.001 ETH |
| Script hangs after completion | (Fixed) ethers provider keepalive | Update to latest `demo-zkproof.js` which calls `process.exit(0)` |
| Stale balances after success | L2 RPC load-balancing | Script retries reads automatically. Check BaseScan for ground truth. |

## What's not implemented

- **ERC-8004 contracts** (IdentityRegistry, ReputationRegistry) — MCP server uses hardcoded demo data
- **x402 payment gating** — MCP server defines paid tools but doesn't enforce HTTP 402
- **AgentWalletFactory** — compiled but not used in the demo (deploys AgentWallet directly)
- **Contract verification on BaseScan** — not set up
- **Production trusted setup** — uses a local ceremony; production would use Hermez ptau
