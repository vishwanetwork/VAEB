import { CONFIG } from './config';

export async function fetchBalances(address: string, chain?: string) {
  const params = chain ? `?chain=${chain}` : '';
  const res = await fetch(`${CONFIG.apiUrl}/balances/${address}${params}`);
  return res.json();
}

// Tool definitions

export interface ToolParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: ToolParam[];
}

export interface ToolsResponse {
  tools: ToolDef[];
  provider: string;
  count: number;
}

export async function fetchTools(): Promise<ToolsResponse> {
  const res = await fetch(`${CONFIG.apiUrl}/tools`);
  return res.json();
}

// Chat API

export interface ToolCallInfo {
  tool: string;
  args: Record<string, any>;
  result: any;
  durationMs: number;
}

export interface ChatResponse {
  message: string;
  toolCalls?: ToolCallInfo[];
  intent?: {
    reviewId: string;
    humanName: string;
    humanId: string;
    humanRating: number;
    task: string;
    amount: string;
    recipient: string;
    nonce: string;
    expiry: number;
    expiryFormatted: string;
    eip712: {
      domain: {
        name: string;
        version: string;
        chainId: number;
        verifyingContract: string;
      };
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, any>;
    };
    // ERC-8150 non-custodial: user must approve AgentWallet to spend tokens
    requires_approval?: boolean;
    approvalTarget?: string;   // AgentWallet address (spender)
    approvalToken?: string;    // ERC20 address (USDC)
    approvalAmount?: string;   // Amount in base units
  };
  sessionId: string;
}

export interface ExecuteResponse {
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  explorerUrl: string;
  balanceBefore: string;
  balanceAfter: string;
  humanName: string;
  amount: string;
  task: string;
  executionPath?: 'executeWithProof' | 'executeDirectly';
  steps?: Array<{
    step: string;
    status: 'success' | 'fallback' | 'skipped';
    durationMs: number;
    detail?: string;
  }>;
  toolCalls?: ToolCallInfo[];
}

async function safeJson(res: globalThis.Response) {
  const text = await res.text();
  if (!text) throw new Error(`Empty response (status ${res.status})`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON: ${text.slice(0, 200)}`);
  }
}

export async function sendChatMessage(
  message: string,
  walletAddress: string,
  sessionId?: string,
  chain?: string
): Promise<ChatResponse> {
  const res = await fetch(`${CONFIG.apiUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, walletAddress, sessionId, chain }),
  });
  const data = await safeJson(res);
  if (!res.ok) {
    throw new Error(data.error || 'Chat request failed');
  }
  return data;
}

export async function executeChatIntent(
  reviewId: string,
  signature: string,
  chain?: string
): Promise<ExecuteResponse> {
  const res = await fetch(`${CONFIG.apiUrl}/chat/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewId, signature, chain }),
  });
  const data = await safeJson(res);
  if (!res.ok) {
    throw new Error(data.error || 'Execution failed');
  }
  return data;
}
