import { CONFIG } from './config';

export async function fetchBalances(address: string) {
  const res = await fetch(`${CONFIG.apiUrl}/balances/${address}`);
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
      types: {
        DirectExecution: Array<{ name: string; type: string }>;
      };
      primaryType: string;
      message: {
        nonce: string;
        expiry: number;
        callsHash: string;
      };
    };
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
  sessionId?: string
): Promise<ChatResponse> {
  const res = await fetch(`${CONFIG.apiUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, walletAddress, sessionId }),
  });
  const data = await safeJson(res);
  if (!res.ok) {
    throw new Error(data.error || 'Chat request failed');
  }
  return data;
}

export async function executeChatIntent(
  reviewId: string,
  signature: string
): Promise<ExecuteResponse> {
  const res = await fetch(`${CONFIG.apiUrl}/chat/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewId, signature }),
  });
  const data = await safeJson(res);
  if (!res.ok) {
    throw new Error(data.error || 'Execution failed');
  }
  return data;
}
