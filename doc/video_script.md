# VAEB — Kite Prize Video Script
**Target: ~3.5 minutes at a comfortable speaking pace**

---

## [0:00 – 0:30] HOOK & PROBLEM

【开始的ppt图片】
Hi, this is Team Vishwa, we built VAEB, the Verified Agent Execution Bundle, and we won first place for the Kite prize at ETH Denver 2026.

【这里可以放素材】

Every day, AI agents are being given wallets and told to spend money on our behalf. But here's the uncomfortable truth — when an AI agent executes an on-chain transaction, you have no cryptographic guarantee it did what you asked. You're trusting a black box.

We asked: what if you *never had to trust the agent at all?* What if you could prove it, mathematically, on-chain, every single time?

That's VAEB — Verified Agent Execution Bundle.

---

## [0:30 – 1:15] THE IDEA

"VAEB is a protocol where you sign an *intent* — a plain-language description of what you want, like 'send 25 USDC to Alice for groceries.' The agent then generates a **zero-knowledge proof** that the actual calldata it derived faithfully matches that intent."

"The smart contract verifies the proof before executing anything. The agent literally cannot cheat — the ZK proof cryptographically binds your signed intent to the exact transaction that runs."

"And it's fully non-custodial. You hold your own funds. The agent wallet never touches your tokens directly — it calls `transferFrom` only after you've approved the spend and signed the ZKIntent. We formalized this as **ERC-8150**, a new Ethereum standard for zero-knowledge agent payment verification."

---

## [1:15 – 2:15] KITE INTEGRATION

"We chose **Kite AI Testnet** as our primary deployment target, and it was the right call."

"Kite is purpose-built for AI-native applications — fast finality, low fees, and an infrastructure philosophy that aligns perfectly with what we were building. When your use case is *AI agents executing on-chain transactions in real-time*, you need a chain that doesn't get in the way."

"VAEB is deployed live on Kite AI Testnet. Every demo you'll see uses Kite as the default chain. Our ZK proof verification, the `executeWithProof()` contract call, the `transferFrom` — all of it runs on Kite."

"The ZK circuit generates a Groth16 proof in under half a second. The proof lands on Kite, gets verified by the on-chain Groth16 verifier, and the transfer executes — all within a single transaction. That kind of responsiveness is what makes this feel like a real product, not a proof of concept."

"We also deployed a full MCP server — 23 tools — that any AI agent, including Claude Desktop, can use to interact with VAEB on Kite. An agent can check balances, create intents, generate proofs, and execute verified payments, all through standard MCP tooling, all landing on Kite."

---

## [2:15 – 3:00] demo视频（从loom下载的）

"Here's what it looks like. I open the chat UI and connect MetaMask. On the left you can see the MCP tools dropdown — all 23 tools the agent has access to, everything from reading balances to creating intents to generating ZK proofs. This is the agent's full capability surface, visible at a glance."

"I type: *'I need someone to walk my dog.'*"

"The AI agent discovers available humans in the RentaHuman marketplace, generates a payment intent, and sends me a signature request."

"I sign the ZKIntent in MetaMask — this is just an EIP-712 signature, no gas, nothing leaves my wallet yet."

"The prover service generates the Groth16 proof. The agent submits it to Kite. The contract verifies the proof, checks my signature, checks the nonce, checks expiry — and then calls `transferFrom`. The USDC moves. The proof is on-chain. Forever."

"No trust required."

---

## [3:00 – 3:30] VISION

"We think this is what the next generation of agent infrastructure looks like. Not agents that hold your keys, not agents you have to trust — but agents that *prove* their behavior, cryptographically, on every action."

"VAEB gives you an intent SDK, an MCP server, a ZK prover service, and a non-custodial smart wallet — a complete stack for building verifiable AI agent applications."

【这里放联系方式】

"We thank Kite for building the infrastructure that makes this possible, and for recognizing what we're building here. Team Vishwa is committed to take this further and keep building VAEB — please contact us if you are interested in collaboration."

---

## Recording Notes

**Pacing:** ~130 words/minute = ~3.5 min. Slow down on technical terms (Groth16, EIP-712, transferFrom).

**Screen recording moments to prep:**
- Chat UI with MCP tools dropdown visible
- "I need someone to walk my dog" interaction
- MetaMask ZKIntent signature popup
- On-chain tx confirmation on Kite block explorer
