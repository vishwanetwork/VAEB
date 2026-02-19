import { CONFIG } from './config';

export async function fetchHealth() {
  const res = await fetch(`${CONFIG.apiUrl}/health`);
  return res.json();
}

export async function fetchBalances(address: string) {
  const res = await fetch(`${CONFIG.apiUrl}/balances/${address}`);
  return res.json();
}

export interface ReviewParams {
  actionType: string;
  token: string;
  amount: string;
  recipient: string;
  signerAddress: string;
}

export interface ReviewResponse {
  reviewId: string;
  action: string;
  token: string;
  amount: string;
  recipient: string;
  from: string;
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
}

export interface ExecuteResponse {
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  explorerUrl: string;
  balanceBefore: string;
  balanceAfter: string;
}

export async function reviewIntent(params: ReviewParams): Promise<ReviewResponse> {
  const res = await fetch(`${CONFIG.apiUrl}/intent/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Review failed');
  }
  return res.json();
}

export async function executeIntent(params: { reviewId: string; signature: string }): Promise<ExecuteResponse> {
  const res = await fetch(`${CONFIG.apiUrl}/intent/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Execution failed');
  }
  return res.json();
}
