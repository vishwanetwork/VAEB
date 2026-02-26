/**
 * Chat endpoint — MCP-to-LLM bridge
 *
 * This module bridges VAEB MCP tools to an AI agent (OpenAI, DeepSeek, or 0G Serving):
 *   1. Imports tool definitions from @vaeb/mcp-server
 *   2. Auto-converts MCP tool schemas to OpenAI function calling format
 *   3. Routes tool calls through MCP handlers
 *   4. Returns MCP tool call metadata in the API response
 *
 * Providers:
 *   LLM_PROVIDER=openai   → OpenAI GPT-4o-mini (default)
 *   LLM_PROVIDER=deepseek → DeepSeek
 *   LLM_PROVIDER=0g       → 0G decentralized AI serving network
 */

import { Router, Request, Response } from 'express';
import OpenAI from 'openai';
import { ethers } from 'ethers';
import { CONFIG, getChainConfig } from './config'; // must import first — loads dotenv
import {
  getToolDefinitions,
  handleToolCall,
  intentStore,
  type MCPConfig,
} from '@vaeb/mcp-server';

const router = Router();

// ─── LLM Client (OpenAI, DeepSeek, or 0G Serving) ───────────

const provider =
  (process.env.LLM_PROVIDER ||
    (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openai')).toLowerCase();

const deepseekKey = process.env.DEEPSEEK_API_KEY || '';
const openaiKey = process.env.OPENAI_API_KEY || '';
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';

// ─── 0G Serving State (lazy-initialized on first request) ────

let zgBroker: any = null;
let zgClient: OpenAI | null = null;
let zgProviderAddress = '';
let zgModel = '';
let zgInitPromise: Promise<void> | null = null;

async function initZG(): Promise<void> {
  if (zgClient) return; // already initialized
  if (zgInitPromise) return zgInitPromise; // init in progress

  zgInitPromise = (async () => {
    console.log('  Initializing 0G Serving broker...');
    const { createZGComputeNetworkBroker } = await import('@0glabs/0g-serving-broker');

    const zgRpcUrl = process.env.ZG_RPC_URL || 'https://evmrpc-testnet.0g.ai';
    const zgProvider = new ethers.JsonRpcProvider(zgRpcUrl);
    const zgWallet = new ethers.Wallet(CONFIG.agentPrivateKey, zgProvider);

    zgBroker = await createZGComputeNetworkBroker(zgWallet);

    // Discover chatbot services
    const services = await zgBroker.inference.listService();
    const chatServices = services.filter((s: any) => s.serviceType === 'chatbot');
    if (chatServices.length === 0) {
      throw new Error('No 0G chatbot services available. Check https://docs.0g.ai');
    }
    console.log(`  0G chatbot services: ${chatServices.map((s: any) => s.model).join(', ')}`);

    // Pick provider (explicit env var, or first available chatbot)
    const targetAddr = process.env.ZG_PROVIDER_ADDRESS;
    const service = targetAddr
      ? chatServices.find((s: any) => s.provider.toLowerCase() === targetAddr.toLowerCase())
      : chatServices[0];

    if (!service) {
      throw new Error(
        `0G provider ${targetAddr} not found. Available: ${chatServices.map((s: any) => s.provider).join(', ')}`
      );
    }

    zgProviderAddress = service.provider;
    console.log(`  0G provider: ${zgProviderAddress}`);
    console.log(`  0G model:    ${service.model || 'unknown'}`);

    // Get endpoint + model
    const metadata = await zgBroker.inference.getServiceMetadata(zgProviderAddress);
    zgModel = process.env.LLM_MODEL || metadata.model;

    // Create OpenAI client pointing to 0G endpoint
    zgClient = new OpenAI({
      baseURL: metadata.endpoint,
      apiKey: 'zg-serving', // placeholder — real auth via getRequestHeaders
    });

    // Ensure ledger exists with funds
    try {
      await zgBroker.ledger.getLedger();
      console.log('  0G ledger exists');
    } catch {
      console.log('  Creating 0G ledger with 0.1 A0GI...');
      await zgBroker.ledger.addLedger(0.1);
    }

    // Fund provider sub-account if needed (providers require >= 0.1 A0GI)
    let subAccountExists = false;
    try {
      const account = await zgBroker.inference.getAccount(zgProviderAddress);
      subAccountExists = true;
      const balance = BigInt(account.balance || '0');
      console.log(`  0G sub-account balance: ${ethers.formatEther(balance)} A0GI`);
      if (balance < ethers.parseEther('0.1')) {
        const needed = ethers.parseEther('0.1') - balance;
        console.log(`  Topping up sub-account with ${ethers.formatEther(needed)} A0GI...`);
        await zgBroker.ledger.transferFund(zgProviderAddress, 'inference', needed);
      }
    } catch (err: any) {
      if (!subAccountExists) {
        // Sub-account doesn't exist — create it
        console.log('  Creating 0G sub-account with 0.1 A0GI...');
        try {
          await zgBroker.ledger.transferFund(zgProviderAddress, 'inference', ethers.parseEther('0.1'));
        } catch (fundErr: any) {
          console.warn(`  0G sub-account funding failed: ${fundErr.message}`);
          console.warn('  Inference may fail — deposit more A0GI to the agent wallet');
        }
      } else {
        console.warn(`  0G sub-account top-up skipped: ${err.message}`);
      }
    }

    // Acknowledge provider signer (one-time)
    try {
      const acknowledged = await zgBroker.inference.acknowledged(zgProviderAddress);
      if (!acknowledged) {
        console.log('  Acknowledging 0G provider signer...');
        await zgBroker.inference.acknowledgeProviderSigner(zgProviderAddress);
      }
    } catch {
      // non-fatal — may already be acknowledged
    }

    console.log(`  0G Serving ready: ${metadata.endpoint} (model: ${zgModel})`);
  })();

  return zgInitPromise;
}

// ─── 0G Prompt-based Tool Calling ─────────────────────────────
// The 0G model (Qwen 2.5 7B) doesn't support native OpenAI-style
// `tools` parameter. Instead, we embed tool definitions in the system
// prompt and parse structured <tool_call> blocks from the response.

function buildZGToolPrompt(): string {
  const toolDefs = getToolDefinitions()
    .filter((t) => !INTERNAL_TOOLS.has(t.name))
    .map((t) => {
      const params = t.inputSchema?.properties
        ? Object.entries(t.inputSchema.properties as Record<string, any>)
            .map(([k, v]) => `${k}: ${v.type}${v.description ? ' — ' + v.description : ''}`)
            .join(', ')
        : '';
      return `- ${t.name}(${params}): ${t.description}`;
    })
    .join('\n');

  return `\nAVAILABLE TOOLS:
To call a tool, respond with EXACTLY this format (no other text before or after):
<tool_call>
{"name": "tool_name", "arguments": {"key": "value"}}
</tool_call>

You may call ONE tool at a time. After calling a tool, wait for the result before responding to the user.
Only call a tool when the user's request matches one. For general conversation, respond normally without tool calls.

Tools:
${toolDefs}`;
}

/**
 * Parse <tool_call> blocks from model text output.
 * Returns array of { name, arguments } objects.
 */
function parseToolCallsFromText(content: string): Array<{ name: string; arguments: Record<string, any> }> {
  // Match <tool_call>...</tool_call> or <tool_call>...EOF (model may omit closing tag)
  const regex = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/g;
  const calls: Array<{ name: string; arguments: Record<string, any> }> = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    try {
      const jsonStr = match[1].trim();
      if (!jsonStr) continue;
      const parsed = JSON.parse(jsonStr);
      if (parsed.name && typeof parsed.name === 'string') {
        calls.push({ name: parsed.name, arguments: parsed.arguments || {} });
      }
    } catch {
      // malformed JSON — skip
    }
  }
  return calls;
}

/**
 * Convert message history for 0G: tool_calls → text, tool → user message.
 * The 0G model doesn't understand OpenAI tool roles, so we convert them.
 */
function convertMessagesForZG(
  messages: OpenAI.ChatCompletionMessageParam[],
  toolPrompt: string
): OpenAI.ChatCompletionMessageParam[] {
  const converted: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      converted.push({
        role: 'system',
        content: (msg.content as string) + toolPrompt,
      });
    } else if (msg.role === 'assistant' && (msg as any).tool_calls) {
      // Convert native tool_calls back to text format
      const calls = (msg as any).tool_calls as any[];
      const text = calls
        .map((tc: any) => {
          const args = (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })();
          return `<tool_call>\n${JSON.stringify({ name: tc.function.name, arguments: args })}\n</tool_call>`;
        })
        .join('\n');
      converted.push({ role: 'assistant', content: text });
    } else if (msg.role === 'tool') {
      // Convert tool result to user message (0G doesn't support 'tool' role)
      converted.push({
        role: 'user',
        content: `[Tool Result]: ${(msg as any).content}`,
      });
    } else {
      converted.push(msg);
    }
  }

  return converted;
}

/**
 * Create a chat completion via the appropriate provider.
 * For 0G, uses prompt-based tool calling (no native tools support).
 */
async function createCompletion(
  params: OpenAI.ChatCompletionCreateParamsNonStreaming
): Promise<OpenAI.ChatCompletion> {
  if (provider === '0g') {
    await initZG();

    // Strip `tools` — 0G model doesn't support it; we use prompt-based calling
    const { tools: _tools, ...paramsWithoutTools } = params;

    // Convert messages: augment system prompt with tool defs, convert tool roles
    const zgToolPrompt = buildZGToolPrompt();
    const convertedMessages = convertMessagesForZG(params.messages, zgToolPrompt);

    // Generate single-use billing headers
    const contentForBilling = convertedMessages
      .map((m: any) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .join('\n')
      .slice(0, 1000);

    const headers = await zgBroker.inference.getRequestHeaders(
      zgProviderAddress,
      contentForBilling
    );

    const result = await zgClient!.chat.completions.create(
      { ...paramsWithoutTools, messages: convertedMessages, model: zgModel },
      { headers: { ...headers } }
    );

    // Parse response for tool calls in text
    const responseContent = result.choices[0]?.message?.content || '';
    const parsedCalls = parseToolCallsFromText(responseContent);

    if (parsedCalls.length > 0) {
      // Transform into OpenAI-compatible tool_calls format so the existing loop works
      (result.choices[0] as any).finish_reason = 'tool_calls';
      (result.choices[0].message as any).tool_calls = parsedCalls.map((tc, i) => ({
        id: `call_0g_${Date.now()}_${i}`,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));
      result.choices[0].message.content = null;
    }

    // Cache fee estimate for auto-balance management
    try {
      const chatID = (result as any).headers?.get?.('ZG-Res-Key') || result.id;
      const usage = result.usage
        ? JSON.stringify({ prompt_tokens: result.usage.prompt_tokens, completion_tokens: result.usage.completion_tokens })
        : '';
      await zgBroker.inference.processResponse(zgProviderAddress, chatID, usage);
    } catch {
      // non-critical — fee caching failure doesn't block inference
    }

    return result;
  }

  // OpenAI / DeepSeek path
  return client.chat.completions.create(params);
}

// Resolved model name (may be overridden for 0G after init)
const model =
  process.env.LLM_MODEL ||
  (provider === 'deepseek' ? 'deepseek-chat' : provider === '0g' ? 'auto' : 'gpt-4o-mini');

if (provider === 'deepseek' && !deepseekKey) {
  console.error('WARNING: DEEPSEEK_API_KEY is not set in .env — chat will fail');
}
if (provider === 'openai' && !openaiKey) {
  console.error('WARNING: OPENAI_API_KEY is not set in .env — chat will fail');
}

// Standard client for OpenAI/DeepSeek (0G uses zgClient instead)
const client = new OpenAI({
  apiKey: provider === 'deepseek' ? deepseekKey || 'missing' : openaiKey || 'missing',
  ...(provider === 'deepseek' ? { baseURL: deepseekBaseUrl } : {}),
});

console.log(`  LLM provider: ${provider}`);
console.log(`  LLM model:    ${model}${provider === '0g' ? ' (resolved on first request)' : ''}`);

// ─── MCP Config (passed to tool handlers) ────────────────────
// Base config — chain-specific fields are set per-request via buildMcpConfig()

const baseMcpConfig: Omit<MCPConfig, 'contracts' | 'rpcUrl' | 'chainId' | 'explorer'> = {
  walletPrivateKey: CONFIG.agentPrivateKey,
  supportedChains: ['base_sepolia', 'kite_testnet'],
  defaultChain: 'base_sepolia',
  proverEndpoint: process.env.PROVER_ENDPOINT || 'http://localhost:3001',
  requireManualApproval: false,
  ownerAddress: CONFIG.ownerAddress,
};

function buildMcpConfig(chainKey?: string, walletAddress?: string): MCPConfig {
  const chain = getChainConfig(chainKey);
  return {
    ...baseMcpConfig,
    defaultChain: chain.key,
    contracts: chain.contracts,
    rpcUrl: chain.rpcUrl,
    chainId: chain.chainId,
    explorer: chain.explorer,
    ownerAddress: walletAddress || baseMcpConfig.ownerAddress,
  };
}

// ─── Auto-convert MCP tools → DeepSeek function format ───────
// MCP inputSchema is JSON Schema — same as OpenAI parameters.
// All MCP tools are exposed to the AI agent — no filtering.

// Tools that are only called programmatically (not by the AI agent)
const INTERNAL_TOOLS = new Set(['execute_payment']);

function mcpToolsToDeepSeekFunctions(): OpenAI.ChatCompletionTool[] {
  return getToolDefinitions()
    .filter((t) => !INTERNAL_TOOLS.has(t.name))
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
}

const tools = mcpToolsToDeepSeekFunctions();

const allDefs = getToolDefinitions();
const toolNames = allDefs.map(t => t.name);
console.log(`  MCP tools loaded: ${tools.length} AI-callable + ${INTERNAL_TOOLS.size} internal (${allDefs.length} total)`);
console.log(`  Active tools: ${toolNames.join(', ')}`);

// ─── GET /api/tools — Return available MCP tool definitions ──

router.get('/tools', (_req: Request, res: Response) => {
  const defs = getToolDefinitions();
  const toolList = defs
    .filter((t) => !INTERNAL_TOOLS.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema?.properties
        ? Object.entries(t.inputSchema.properties as Record<string, any>).map(([k, v]) => ({
            name: k,
            type: (v as any).type || 'any',
            description: (v as any).description || '',
            required: ((t.inputSchema?.required || []) as string[]).includes(k),
          }))
        : [],
    }));
  res.json({ tools: toolList, provider: provider === '0g' ? '0G Serving' : provider, count: toolList.length });
});

// ─── Conversation Store ──────────────────────────────────────

const conversationStore = new Map<string, Array<OpenAI.ChatCompletionMessageParam>>();

// ─── System Prompt ───────────────────────────────────────────

const SYSTEM_PROMPT = `You are VAEB Agent — an AI assistant powered by ${provider === '0g' ? '0G decentralized AI serving network and ' : ''}MCP (Model Context Protocol) tools for verified on-chain execution on Base Sepolia. You implement ERC-8150 (Zero-Knowledge Agent Payment Verification) and x402 (HTTP 402 agent-to-agent micropayments on Base).

The user holds their own USDC (non-custodial). When paying, the user first approves the AgentWallet to spend their tokens, then signs a ZKIntent commitment. The AgentWallet uses transferFrom to move funds on their behalf after ZK proof verification.

DECISION GUIDE — pick the right tool for the user's request:

"I need a dog walker / groceries / errands / hire someone"
  → search_marketplace → hire_human (Marketplace flow)

"Send 50 USDC to 0xABC" / "Swap ETH for USDC" / "Transfer tokens"
  → use eip 8150 intents: first check balance, then check nonce, then create_intent, optionally simulate_intent, then execute_payment after signing

"我想质押BTC" / "我想获得BTCVC" / "Stake BTC" / "质押比特币"
  → BTC STAKING FLOW: 询问sui地址和金额 → init_btc_payment (从x402获取BTC存款地址) → 用户从外部BTC钱包转账 → confirm_btc_transfer
  → IMPORTANT: 不要检查钱包余额！BTC来自用户外部钱包，不是连接的EVM钱包

"What's my balance?" / "How much USDC do I have?"
  → get_wallet_balance (for AgentWallet) or read_balance (for any wallet/token)

"What's the price of ETH?" / "ETH/USDC price"
  → get_price

"How much gas for a swap?" / "Estimate gas"
  → estimate_gas

"Check my transaction" / "What happened with tx 0x..."
  → get_receipt

"Find a good agent" / "Which agent should I use?"
  → discover_agents → compare_agents

"Is this agent reliable?" / "Agent #3 reputation"
  → get_agent_reputation → get_agent_validations

"Simulate before executing" / "Dry run this intent"
  → simulate_intent

"Cancel that intent" / "Nevermind, don't execute"
  → cancel_intent

"Is this nonce used?" / "Check nonce 0x..."
  → check_nonce

"Generate a ZK proof for this intent"
  → prove_intent

"Verify this proof"
  → verify_proof

"Check BTC transfer status" / "Where is my Bitcoin transaction?"
  → get_btc_payment_status

IMPORTANT: NEVER execute a transaction directly. ALL on-chain actions MUST go through the full intent pipeline: create_intent → check balance → check_nonce → prove_intent → verify_proof → user signs → execute_payment.

MARKETPLACE FLOW (hiring humans for physical tasks):
1. User describes a need → IMMEDIATELY call search_marketplace. Don't wait.
2. Present results: name, rating, rate (USDC), skills, distance. Recommend the best match.
3. When the user says "yes", "ok", "sure", "go ahead", "hire them", or ANY affirmative response → IMMEDIATELY call hire_human. Do NOT ask again. Do NOT say "shall we proceed?" — just call the tool.
4. hire_human creates a payment intent bundle for the user to sign.
5. Then follow the EXECUTION PIPELINE below to complete payment.

CRITICAL: When the user confirms, call hire_human RIGHT AWAY. Never ask for confirmation twice.

INTENT FLOW (ERC-8150 ZK-verified DeFi — swap, transfer, stake):
1. User requests a DeFi action → call create_intent to build an intent bundle (nonce, expiry, actions, calldata).
2. Show the human-readable preview (amount, token, recipient). Ask for confirmation.
3. Optionally call simulate_intent to dry-run before committing.
4. On confirmation → follow the EXECUTION PIPELINE below.

EXECUTION PIPELINE (required for ALL on-chain transactions):
1. get_wallet_balance — verify the user's EOA has sufficient USDC. Abort if insufficient.
2. check_nonce — verify the intent nonce hasn't been used on-chain. Abort if already used.
3. prove_intent — generate a Groth16 ZK proof (Poseidon commitment over the bundle via snarkjs prover service).
4. User approves USDC spending (ERC-20 approve) for the AgentWallet, then signs ZKIntent(nonce, expiry, commitment) via EIP-712.
5. execute_payment — submits executeWithProof() on-chain: re-checks nonce, verifies the ZK proof, recovers the signer from the EIP-712 signature, and atomically executes transferFrom calls.

BTC STAKING FLOW (BTC -> BTCVC on Sui) — CORRECT ORDER:
When user says "我想质押BTC获得BTCVC" or similar:

**STEP 1 — Collect Information:**
- Ask user: "您希望质押多少BTC？" (e.g., 0.001 BTC)
- Ask user: "请提供您的Sui地址来接收BTCVC" (format: 0x + 64 hex chars)

**STEP 2 — Initialize & Pay x402 (FIRST):**
- Call init_btc_payment with: amount_btc + sui_address
- **CRITICAL**: This will trigger x402 payment UI to pop up automatically
- User pays $0.5 USDC using their connected EVM wallet (one-click payment)
- Wait for payment to complete

**STEP 3 — Connect BTC Wallet (AFTER payment):**
- Once x402 payment succeeds, call request_btc_wallet
- This triggers BTC wallet connection modal (Xverse, Unisat, Leather)
- Tell user: "请连接您的BTC钱包以发送BTC存款"
- Wait for BTC wallet to be connected

**STEP 4 — BTC Deposit:**
- Once BTC wallet connected and BTC deposit address obtained: 
- Display: "请发送 [amount] BTC 到: [deposit_address]"
- User sends BTC from their connected BTC wallet
- Wait for user to confirm BTC sent

**STEP 5 — Confirm:**
- Call confirm_btc_transfer with intent_id + tx_hash
- BTCVC will be minted to Sui address

**CRITICAL RULES:**
- CORRECT ORDER: (1) Pay x402 FIRST, (2) Connect BTC wallet SECOND, (3) Send BTC LAST
- The frontend will AUTOMATICALLY show payment/connect UI cards - do NOT tell user to "look for buttons" or "manually do anything"
- NEVER check wallet balances
- When x402 payment succeeds, the system will automatically continue to BTC wallet connection

TRUST FLOW (evaluating agents):
1. User asks about agents → call discover_agents to find available agents.
2. For details on a specific agent → get_agent_reputation + get_agent_validations.
3. To compare options → compare_agents with multiple agent IDs.
4. After a successful execution → post_feedback to update reputation.

RULES:
- Be concise — 2-3 sentences max per response
- ALWAYS use the right tool — never make up data or balances
- Treat all USDC as real USDC — never mention "mock", "test", or "fake"
- Do NOT call get_wallet_balance unless the user specifically asks about balance
- When unsure which flow, ask the user to clarify
- **BTC STAKING RULE**: When user wants to stake BTC for BTCVC: (1) Collect amount and sui_address, (2) Call request_btc_wallet to trigger wallet connection UI, (3) Wait for user to confirm connection, (4) Then call init_btc_payment. DO NOT check wallet balances. BTC comes from EXTERNAL wallet. CRITICAL: NEVER tell user to "look for button" or "manually pay" - the frontend will AUTOMATICALLY show the payment/deposit UI cards with buttons after you call the tools.`;

// ─── Tool Call Info (returned to frontend) ───────────────────

interface CollectedToolCall {
  tool: string;
  args: Record<string, any>;
  result: any;
  durationMs: number;
}

// ─── POST /api/chat ──────────────────────────────────────────

router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { message, walletAddress, sessionId, chain } = req.body;

    if (!message || !walletAddress) {
      res.status(400).json({ error: 'Missing message or walletAddress' });
      return;
    }

    // Build per-request MCP config with chain-specific values
    const mcpConfig = buildMcpConfig(chain, walletAddress);

    // Get or create conversation history
    const sid = sessionId || 'default';
    if (!conversationStore.has(sid)) {
      conversationStore.set(sid, []);
    }
    const history = conversationStore.get(sid)!;

    // Add user message
    history.push({ role: 'user', content: message });

    // Call LLM with MCP-derived tools
    let response = await createCompletion({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
      ],
      tools,
    });

    // Handle tool use loop
    let intent = null;
    const collectedToolCalls: CollectedToolCall[] = [];

    while (response.choices[0]?.finish_reason === 'tool_calls') {
      const assistantMessage = response.choices[0].message;
      history.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls;
      if (!toolCalls || toolCalls.length === 0) break;

      // Process each tool call through MCP handlers
      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') {
          // Must respond to every tool_call_id or the API returns 400
          history.push({ role: 'tool', tool_call_id: toolCall.id, content: 'unsupported tool type' });
          continue;
        }

        const args = JSON.parse(toolCall.function.arguments);

        let resultText: string;
        try {
          // Route through MCP
          const mcpResult = await handleToolCall(
            toolCall.function.name,
            args,
            mcpConfig
          );

          // Collect metadata for frontend display
          collectedToolCalls.push({
            tool: mcpResult.toolMeta.tool,
            args: mcpResult.toolMeta.args,
            result: mcpResult.result,
            durationMs: mcpResult.toolMeta.durationMs,
          });

          // Capture intent if produced (hire_human)
          if (mcpResult.intent) {
            intent = mcpResult.intent;
          }

          // Check if this is a request_btc_wallet call to trigger frontend UI
          if (toolCall.function.name === 'request_btc_wallet' && mcpResult.result?.action === 'request_btc_wallet_connection') {
            intent = {
              ...mcpResult.intent,
              type: 'REQUEST_BTC_WALLET',
              suiAddress: args.sui_address,
              reason: args.reason || 'BTC staking',
            };
          }

          resultText =
            typeof mcpResult.result === 'string'
              ? mcpResult.result
              : JSON.stringify(mcpResult.result);
        } catch (toolErr: any) {
          resultText = `Error: ${toolErr.message}`;
        }

        // Always push a tool response — even on error — to keep history valid
        history.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: resultText,
        });
      }

      // Continue conversation with tool results
      response = await createCompletion({
        model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history,
        ],
        tools,
      });
    }

    // Extract text response
    const assistantMsg = response.choices[0]?.message;
    if (assistantMsg && assistantMsg.tool_calls) {
      history.push(assistantMsg);
    }
    const agentMessage = assistantMsg?.content || 'I encountered an issue. Please try again.';

    if (!assistantMsg?.tool_calls) {
      history.push({ role: 'assistant', content: agentMessage });
    }

    // Keep history manageable
    if (history.length > 30) {
      history.splice(0, history.length - 20);
    }

    res.json({
      message: agentMessage,
      toolCalls: collectedToolCalls,
      intent,
      sessionId: sid,
    });
  } catch (err: any) {
    console.error('Chat error:', err?.message || err);
    if (err?.status) console.error('API status:', err.status);
    if (err?.error) console.error('API error body:', JSON.stringify(err.error));
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ─── POST /api/chat/execute ──────────────────────────────────
// Routes through MCP execute_payment tool so execution appears as an MCP tool call

router.post('/chat/execute', async (req: Request, res: Response) => {
  try {
    const { reviewId, signature, chain } = req.body;

    if (!reviewId || !signature) {
      res.status(400).json({ error: 'Missing reviewId or signature' });
      return;
    }

    // Build per-request MCP config with chain-specific values
    const mcpConfig = buildMcpConfig(chain);

    // Route through MCP tool handler
    const mcpResult = await handleToolCall(
      'execute_payment',
      { review_id: reviewId, signature },
      mcpConfig
    );

    const toolCall: CollectedToolCall = {
      tool: mcpResult.toolMeta.tool,
      args: mcpResult.toolMeta.args,
      result: mcpResult.result,
      durationMs: mcpResult.toolMeta.durationMs,
    };

    res.json({
      ...mcpResult.result,
      toolCalls: [toolCall],
    });
  } catch (err: any) {
    const knownErrors: Record<string, string> = {
      '0x09bde339': 'InvalidProof',
      '0x8baa579f': 'InvalidSignature — the wallet owner must sign the intent',
      '0x1fb09b80': 'NonceAlreadyUsed — this intent was already executed',
      '0x408b2234': 'IntentExpired',
      '0x72cb8533': 'NotOwnerOrAgent',
    };

    let errorMsg = err.message;
    const revertData = err.data || err?.info?.error?.data;
    if (revertData && typeof revertData === 'string') {
      const selector = revertData.slice(0, 10);
      if (knownErrors[selector]) errorMsg = knownErrors[selector];
    }

    res.status(500).json({ error: errorMsg });
  }
});

export default router;
