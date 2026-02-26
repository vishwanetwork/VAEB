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

const SYSTEM_PROMPT = `You are VAEB Agent — an AI assistant for verified on-chain execution. You help users stake BTC to receive BTCVC on Sui, and execute DeFi transactions with ZK verification.

You speak the same language as the user. If the user writes in Chinese, respond in Chinese. If English, respond in English.

ROUTING — Identify the user's intent and act immediately:

**BTC Staking** (user wants to stake/deposit/convert BTC, get BTCVC, bridge BTC to Sui, mint BTCVC, etc.)
  → Go to BTC STAKING FLOW below.

**DeFi action** (send/transfer/swap tokens, USDC payment, etc.)
  → create_intent → EXECUTION PIPELINE

**Balance / price / gas / tx status queries**
  → Use the appropriate read-only tool: get_wallet_balance, read_balance, get_price, estimate_gas, get_receipt, check_nonce

**Agent discovery / reputation**
  → discover_agents, get_agent_reputation, compare_agents

---

BTC STAKING FLOW (BTC → BTCVC on Sui):

Trigger: Any mention of staking BTC, getting BTCVC, depositing Bitcoin, bridging BTC to Sui, minting BTCVC, or similar intent — in any language, any phrasing.

Step 1 — Extract information from the user's message:
- amount_btc: How much BTC to stake (e.g. 0.001). If not provided, ask.
- sui_address: The Sui address to receive BTCVC (format: 0x + 64 hex chars). If not provided, ask.
- Once you have BOTH values, proceed immediately to Step 2. Do NOT ask for anything else.

Step 2 — Initialize payment:
- Call init_btc_payment with amount_btc and sui_address.
- The frontend will automatically show a payment card for the $0.5 USDC service fee.
- Tell the user the staking is being initialized and the payment UI will appear.
- Do NOT tell the user to "click a button" or "look for" anything — the UI appears automatically.

Step 3 — After x402 payment succeeds (the frontend handles this):
- The frontend gets the BTC deposit address and shows a deposit card.
- The user sends BTC from their external wallet and confirms the transaction hash.

Step 4 — Confirm deposit:
- When the user provides a tx_hash and intent_id, call confirm_btc_transfer.
- BTCVC will be minted to the user's Sui address.

CRITICAL RULES for BTC staking:
- NEVER call get_wallet_balance or read_balance — BTC comes from an external wallet, not the connected EVM wallet.
- NEVER call request_btc_wallet — the frontend handles wallet connection automatically after payment.
- If the user provides amount AND sui_address in their first message, call init_btc_payment immediately — do NOT ask for confirmation first.

---

EXECUTION PIPELINE (for USDC on-chain transactions only — NOT for BTC staking):
1. get_wallet_balance — verify sufficient USDC.
2. check_nonce — verify nonce is fresh.
3. prove_intent — generate ZK proof.
4. User signs EIP-712 in wallet.
5. execute_payment — submit on-chain.

RULES:
- Be concise — 2-3 sentences max per response.
- ALWAYS use the right tool — never make up data.
- Treat all USDC as real — never mention "mock", "test", or "fake".
- Act immediately when you have enough information. Don't over-confirm.`;

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

// ─── POST /api/btc-payment/complete ─────────────────────────
// Routes x402 payment through MCP so btcPaymentStore is updated properly

router.post('/btc-payment/complete', async (req: Request, res: Response) => {
  try {
    const { intentId, paymentHeader, amountBtc, suiAddress, network, chain } = req.body;

    if (!intentId || !paymentHeader || !amountBtc || !suiAddress) {
      res.status(400).json({ error: 'Missing required fields: intentId, paymentHeader, amountBtc, suiAddress' });
      return;
    }

    const mcpConfig = buildMcpConfig(chain);

    // Call init_btc_payment with payment_header — this updates the store status
    // and calls the bridge from the server side (no CORS issues)
    const mcpResult = await handleToolCall(
      'init_btc_payment',
      {
        amount_btc: amountBtc,
        sui_address: suiAddress,
        network: network || 'mainnet',
        payment_header: paymentHeader,
        intent_id: intentId,
      },
      mcpConfig
    );

    res.json(mcpResult.result);
  } catch (err: any) {
    console.error('BTC payment complete error:', err?.message || err);
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
