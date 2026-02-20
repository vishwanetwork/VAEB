/**
 * Chat endpoint — MCP-to-GPT bridge
 *
 * This module bridges VAEB MCP tools to the GPT-4o-mini AI agent:
 *   1. Imports tool definitions from @vaeb/mcp-server
 *   2. Auto-converts MCP tool schemas to OpenAI function calling format
 *   3. Routes tool calls through MCP handlers
 *   4. Returns MCP tool call metadata in the API response
 */

import { Router, Request, Response } from 'express';
import OpenAI from 'openai';
import { CONFIG } from './config'; // must import first — loads dotenv
import {
  getToolDefinitions,
  handleToolCall,
  intentStore,
  type MCPConfig,
} from '@vaeb/mcp-server';

const router = Router();

// ─── LLM Client (OpenAI or DeepSeek) ──────────────────────────

const provider =
  (process.env.LLM_PROVIDER ||
    (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openai')).toLowerCase();

const deepseekKey = process.env.DEEPSEEK_API_KEY || '';
const openaiKey = process.env.OPENAI_API_KEY || '';
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const model =
  process.env.LLM_MODEL ||
  (provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini');

if (provider === 'deepseek' && !deepseekKey) {
  console.error('WARNING: DEEPSEEK_API_KEY is not set in .env — chat will fail');
}
if (provider === 'openai' && !openaiKey) {
  console.error('WARNING: OPENAI_API_KEY is not set in .env — chat will fail');
}

const client = new OpenAI({
  apiKey: provider === 'deepseek' ? deepseekKey || 'missing' : openaiKey || 'missing',
  ...(provider === 'deepseek' ? { baseURL: deepseekBaseUrl } : {}),
});

console.log(`  LLM provider: ${provider}`);
console.log(`  LLM model:    ${model}`);

// ─── MCP Config (passed to tool handlers) ────────────────────

const mcpConfig: MCPConfig = {
  walletPrivateKey: CONFIG.agentPrivateKey,
  supportedChains: ['base_sepolia'],
  defaultChain: 'base_sepolia',
  proverEndpoint: process.env.PROVER_ENDPOINT || 'http://localhost:3001',
  requireManualApproval: false,
  contracts: CONFIG.contracts,
  rpcUrl: CONFIG.rpcUrl,
  chainId: CONFIG.chainId,
  ownerAddress: CONFIG.ownerAddress,
};

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

// ─── Conversation Store ──────────────────────────────────────

const conversationStore = new Map<string, Array<OpenAI.ChatCompletionMessageParam>>();

// ─── System Prompt ───────────────────────────────────────────

const SYSTEM_PROMPT = `You are VAEB Agent — an AI assistant powered by MCP (Model Context Protocol) tools for verified on-chain execution on Base Sepolia. You implement ERC-8150 (Zero-Knowledge Agent Payment Verification).

The wallet is fully funded with USDC and ready. Never tell the user to deposit or top up.

DECISION GUIDE — pick the right tool for the user's request:

"I need a dog walker / groceries / errands / hire someone"
  → search_marketplace → hire_human (Marketplace flow)

"Send 50 USDC to 0xABC" / "Swap ETH for USDC" / "Transfer tokens"
  → use eip 8150 intents: first check balance, then check nonce, then create_intent, optionally simulate_intent, then execute_payment after signing

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

IMPORTANT: NEVER execute a transaction directly. ALL on-chain actions MUST go through the full intent pipeline: create_intent → check balance → check_nonce → prove_intent → verify_proof → user signs → execute_payment.

MARKETPLACE FLOW (hiring humans for physical tasks):
1. User describes a need → IMMEDIATELY call search_marketplace. Don't wait.
2. Present results: name, rating, rate (USDC), skills, distance.
3. Recommend the best match. Wait for explicit confirmation ("yes", "hire them", "go ahead").
4. Call hire_human with the human's listed rate → this creates an intent bundle.
5. Then follow the EXECUTION PIPELINE below to complete payment.

INTENT FLOW (ERC-8150 ZK-verified DeFi — swap, transfer, stake):
1. User requests a DeFi action → call create_intent to build an intent bundle (nonce, expiry, actions, calldata).
2. Show the human-readable preview (amount, token, recipient). Ask for confirmation.
3. Optionally call simulate_intent to dry-run before committing.
4. On confirmation → follow the EXECUTION PIPELINE below.

EXECUTION PIPELINE (required for ALL on-chain transactions):
1. get_wallet_balance — verify the wallet has sufficient funds for the intent. Abort if insufficient.
2. check_nonce — verify the intent nonce hasn't been used on-chain. Abort if already used.
3. prove_intent — generate a Groth16 ZK proof (Poseidon commitment over the bundle via snarkjs prover service).
4. verify_proof — verify the ZK proof off-chain before asking the user to sign.
5. User signs the commitment via EIP-712 with their wallet.
6. execute_payment — submits executeWithProof() on-chain: re-checks nonce, verifies the ZK proof through the Groth16Verifier → Adapter chain, recovers the signer from the EIP-712 signature, and atomically executes the calls.

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
- When unsure which flow, ask the user to clarify`;

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
    const { message, walletAddress, sessionId } = req.body;

    if (!message || !walletAddress) {
      res.status(400).json({ error: 'Missing message or walletAddress' });
      return;
    }

    // Get or create conversation history
    const sid = sessionId || 'default';
    if (!conversationStore.has(sid)) {
      conversationStore.set(sid, []);
    }
    const history = conversationStore.get(sid)!;

    // Add user message
    history.push({ role: 'user', content: message });

    // Call DeepSeek with MCP-derived tools
    let response = await client.chat.completions.create({
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
        if (toolCall.type !== 'function') continue;

        const args = JSON.parse(toolCall.function.arguments);

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

        // Feed result back to DeepSeek
        const resultText =
          typeof mcpResult.result === 'string'
            ? mcpResult.result
            : JSON.stringify(mcpResult.result);

        history.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: resultText,
        });
      }

      // Continue conversation with tool results
      response = await client.chat.completions.create({
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
    const { reviewId, signature } = req.body;

    if (!reviewId || !signature) {
      res.status(400).json({ error: 'Missing reviewId or signature' });
      return;
    }

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
