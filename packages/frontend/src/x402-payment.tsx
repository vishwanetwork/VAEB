/**
 * X402 Payment Handler for VAEB Frontend
 *
 * Handles x402 micropayments on Base network
 */

import { ethers } from 'ethers';

export interface X402PaymentDetails {
  amount: string;
  amountDisplay: string;
  asset: string;
  payTo: string;
  network: string;
  description: string;
  maxTimeoutSeconds: number;
  resource: string;
}

export interface X402Intent {
  intentId: string;
  type: string;
  amount: string;
  suiAddress: string;
  network: string;
  requiresPayment: boolean;
  paymentAmount: string;
  paymentAsset: string;
  payTo: string;
  expiresAt: number;
  status: string;
}

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (uint8)',
];

/**
 * Execute x402 payment using connected EVM wallet (payai format with EIP-712 signature)
 *
 * X-PAYMENT header format for payai:
 * Base64 encoded JSON: { x402Version, scheme, network, payload: { signature, authorization } }
 */
export async function executeX402Payment(
  signer: ethers.JsonRpcSigner,
  payment: X402PaymentDetails,
  x402Version: number = 1
): Promise<{ success: boolean; txHash: string; paymentHeader: string; resultData: any }> {
  const address = await signer.getAddress();

  // Create USDC contract instance (read-only for checking)
  const usdc = new ethers.Contract(payment.asset, USDC_ABI, signer);

  // Check balance
  const balance = await usdc.balanceOf(address);
  const requiredAmount = BigInt(payment.amount);

  if (balance < requiredAmount) {
    throw new Error(
      `Insufficient USDC balance. Required: ${ethers.formatUnits(requiredAmount, 6)} USDC, ` +
      `Current: ${ethers.formatUnits(balance, 6)} USDC`
    );
  }

  // Generate authorization parameters
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 300; // 5 minutes ago
  const validBefore = now + 300; // 5 minutes from now

  const response402 = await fetch(payment.resource);

  const body402 = await response402.json();
  console.log('Payment requirements:', body402);

  const accepts = body402.accepts[0];
  const amount = accepts.maxAmountRequired || accepts.amount;
  const payTo = accepts.payTo;


  // EIP-712 Domain
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: 8453,
    verifyingContract: payment.asset,
  };

  // EIP-712 Types
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  // Sign typed data
  const value = {
    from: address,
    to: payTo,
    value: amount,
    validAfter,
    validBefore,
    nonce,
  };

  console.log('[X402] Signing typed data...', value);
  const signature = await signer.signTypedData(domain, types, value);

  // Build payment payload (payai format)
  const paymentPayload = {
    x402Version,
    scheme: 'exact',
    network: payment.network.toLowerCase(),
    payload: {
      signature,
      authorization: {
        from: address,
        to: payTo,
        value: amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  // Encode payment header
  const paymentHeader = btoa(JSON.stringify(paymentPayload));

  console.log('[X402] Payment header generated:', paymentHeader.slice(0, 50) + '...');

  return {
    success: true,
    txHash: '', // Will be returned by the service
    paymentHeader,
    resultData: paymentPayload,
  };
}

/**
 * Fetch resource with x402 payment header (payai format)
 */
export async function fetchWithX402Payment(
  url: string,
  paymentHeader: string,
  params: Record<string, string>
): Promise<Response> {
  const queryString = new URLSearchParams(params).toString();
  const fullUrl = `${url}?${queryString}`;

  console.log('[X402] Fetching:', fullUrl);
  console.log('[X402] Payment header length:', paymentHeader.length);

  const response = await fetch(fullUrl, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'X-PAYMENT': paymentHeader,
    },
  });

  console.log('[X402] Response status:', response.status);

  if (response.status === 402) {
    // Payment still required - parse error
    const errorData = await response.json();
    console.error('[X402] Payment required:', errorData);
    throw new Error(`Payment not accepted: ${errorData.error || 'Please check signature and network'}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[X402] Request failed:', response.status, errorText);
    throw new Error(`Request failed: ${response.status} - ${errorText}`);
  }

  return response;
}

/**
 * Check if user has sufficient USDC balance
 */
export async function checkUSDCBalance(
  provider: ethers.Provider,
  address: string,
  usdcAddress: string,
  requiredAmount: string
): Promise<{ sufficient: boolean; balance: string; required: string }> {
  const usdc = new ethers.Contract(usdcAddress, USDC_ABI, provider);
  const balance = await usdc.balanceOf(address);

  return {
    sufficient: balance >= BigInt(requiredAmount),
    balance: ethers.formatUnits(balance, 6),
    required: ethers.formatUnits(requiredAmount, 6),
  };
}

/**
 * Component: X402 Payment Card
 * Displays payment details and pay button
 */
export function X402PaymentCard({
  payment,
  intent,
  onPay,
  onCancel,
  paying,
}: {
  payment: X402PaymentDetails;
  intent: X402Intent;
  onPay: () => void;
  onCancel: () => void;
  paying: boolean;
}) {
  return (
    <div className="x402-payment-card">
      <div className="x402-payment-header">
        <div className="x402-payment-icon">💎</div>
        <span className="x402-payment-title">x402 Payment</span>
      </div>

      <div className="x402-payment-body">
        <p className="x402-payment-desc">
          Service fee required to obtain BTC staking address
        </p>

        <div className="x402-payment-details">
          <div className="x402-payment-row">
            <span className="x402-payment-label">Amount</span>
            <span className="x402-payment-value highlight">{payment.amountDisplay}</span>
          </div>

          <div className="x402-payment-row">
            <span className="x402-payment-label">Token</span>
            <span className="x402-payment-value">USDC</span>
          </div>

          <div className="x402-payment-row">
            <span className="x402-payment-label">Network</span>
            <span className="x402-payment-value">Base</span>
          </div>

          <div className="x402-payment-row">
            <span className="x402-payment-label">Recipient</span>
            <span className="x402-payment-value mono">
              {payment.payTo.slice(0, 8)}...{payment.payTo.slice(-6)}
            </span>
          </div>

          <div className="x402-payment-row">
            <span className="x402-payment-label">Purpose</span>
            <span className="x402-payment-value">{payment.description}</span>
          </div>
        </div>

        <div className="x402-payment-actions">
          <button
            className="x402-payment-btn x402-payment-btn-primary"
            onClick={onPay}
            disabled={paying}
          >
            {paying ? 'Paying...' : 'Confirm Payment'}
          </button>
          <button
            className="x402-payment-btn x402-payment-btn-secondary"
            onClick={onCancel}
            disabled={paying}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Component: BTC Deposit Card
 * Displays BTC deposit address and instructions with Sign button for wallet-connected users
 */
export function BTCDepositCard({
  depositAddress,
  amount,
  suiAddress,
  fromAddress,
  onConfirm,
  onSignAndSend,
  confirming,
  signing,
  btcWalletConnected = false,
}: {
  depositAddress: string;
  amount: string;
  suiAddress: string;
  fromAddress?: string;
  onConfirm: () => void;
  onSignAndSend?: () => Promise<void>;
  confirming: boolean;
  signing?: boolean;
  btcWalletConnected?: boolean;
}) {
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="btc-deposit-card">
      <div className="btc-deposit-header">
        <div className="btc-deposit-icon">₿</div>
        <span className="btc-deposit-title">BTC Transfer</span>
      </div>

      <div className="btc-deposit-body">
        {btcWalletConnected ? (
          <div className="btc-transaction-preview">
            <h4>Transaction Preview</h4>
            <div className="btc-tx-row">
              <span className="btc-tx-label">From</span>
              <span className="btc-tx-value mono">{fromAddress || 'Connected Wallet'}</span>
            </div>
            <div className="btc-tx-row">
              <span className="btc-tx-label">To</span>
              <span className="btc-tx-value mono">{depositAddress}</span>
            </div>
            <div className="btc-tx-row">
              <span className="btc-tx-label">Amount</span>
              <span className="btc-tx-value highlight">{amount} BTC</span>
            </div>
            <div className="btc-tx-row">
              <span className="btc-tx-label">Network</span>
              <span className="btc-tx-value">Bitcoin</span>
            </div>
            <p className="btc-tx-hint">
              Click the button below to confirm and sign the transaction in your wallet
            </p>
          </div>
        ) : (
          <p className="btc-deposit-desc">
            Please send <strong>{amount} BTC</strong> from your BTC wallet to the following address:
          </p>
        )}

        {!btcWalletConnected && (
          <div className="btc-deposit-address-box">
            <code className="btc-deposit-address">{depositAddress}</code>
            <button
              className="btc-deposit-copy-btn"
              onClick={() => copyToClipboard(depositAddress)}
            >
              Copy
            </button>
          </div>
        )}

        <div className="btc-deposit-info">
          <div className="btc-deposit-info-item">
            <span className="btc-deposit-info-label">Destination (Sui)</span>
            <span className="btc-deposit-info-value mono">
              {suiAddress.slice(0, 10)}...{suiAddress.slice(-8)}
            </span>
          </div>
          <div className="btc-deposit-info-item">
            <span className="btc-deposit-info-label">Receive Token</span>
            <span className="btc-deposit-info-value">BTCVC</span>
          </div>
        </div>

        <div className="btc-deposit-actions">
          {btcWalletConnected && onSignAndSend ? (
            <div>
              <button
                className="btc-deposit-btn btc-deposit-btn-primary"
                onClick={onSignAndSend}
                disabled={signing}
              >
                {signing ? 'Waiting for wallet confirmation...' : `Confirm Transaction in Wallet`}
              </button>
              {parseFloat(amount) < 0.00000546 && (
                <p className="btc-amount-warning">
                  Warning: Amount may be too small and could cause the transaction to fail. Recommend sending at least 0.00001 BTC
                </p>
              )}
            </div>
          ) : (
            <button
              className="btc-deposit-btn btc-deposit-btn-primary"
              onClick={onConfirm}
              disabled={confirming}
            >
              {confirming ? 'Confirming...' : 'I Have Sent BTC'}
            </button>
          )}
        </div>

        {!btcWalletConnected && (
          <div className="btc-deposit-instructions">
            <h4>Steps:</h4>
            <ol>
              <li>Open your BTC wallet (Xverse, Unisat, or Leather)</li>
              <li>Send <strong>{amount} BTC</strong> to the address above</li>
              <li>Wait for 1-3 network confirmations</li>
              <li>Click "I Have Sent BTC" to confirm</li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

// CSS Styles
export const x402Styles = `
/* X402 Payment Card */
.x402-payment-card {
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  border: 1px solid #0f3460;
  border-radius: 16px;
  padding: 24px;
  margin: 16px 0;
  color: #fff;
}

.x402-payment-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid #0f3460;
}

.x402-payment-icon {
  font-size: 32px;
}

.x402-payment-title {
  font-size: 20px;
  font-weight: 600;
  background: linear-gradient(90deg, #e94560, #ff6b6b);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.x402-payment-desc {
  color: #a0a0a0;
  margin-bottom: 20px;
  font-size: 14px;
}

.x402-payment-details {
  background: rgba(0, 0, 0, 0.3);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 20px;
}

.x402-payment-row {
  display: flex;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.x402-payment-row:last-child {
  border-bottom: none;
}

.x402-payment-label {
  color: #888;
  font-size: 14px;
}

.x402-payment-value {
  font-weight: 500;
}

.x402-payment-value.highlight {
  color: #e94560;
  font-size: 18px;
  font-weight: 700;
}

.x402-payment-value.mono {
  font-family: monospace;
  font-size: 12px;
}

.x402-payment-actions {
  display: flex;
  gap: 12px;
}

.x402-payment-btn {
  flex: 1;
  padding: 14px 24px;
  border-radius: 10px;
  border: none;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.x402-payment-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.x402-payment-btn-primary {
  background: linear-gradient(90deg, #e94560, #ff6b6b);
  color: white;
}

.x402-payment-btn-primary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 20px rgba(233, 69, 96, 0.4);
}

.x402-payment-btn-secondary {
  background: transparent;
  border: 1px solid #444;
  color: #888;
}

.x402-payment-btn-secondary:hover:not(:disabled) {
  border-color: #666;
  color: #fff;
}

/* BTC Deposit Card */
.btc-deposit-card {
  background: linear-gradient(135deg, #1a1a2e 0%, #1a2e1a 100%);
  border: 1px solid #0f6010;
  border-radius: 16px;
  padding: 24px;
  margin: 16px 0;
  color: #fff;
}

.btc-deposit-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid #0f6010;
}

.btc-deposit-icon {
  font-size: 32px;
  color: #f7931a;
}

.btc-deposit-title {
  font-size: 20px;
  font-weight: 600;
  background: linear-gradient(90deg, #f7931a, #ffd700);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.btc-deposit-desc {
  color: #a0a0a0;
  margin-bottom: 20px;
  font-size: 14px;
}

.btc-transaction-preview {
  background: rgba(247, 147, 26, 0.1);
  border: 1px solid rgba(247, 147, 26, 0.3);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 20px;
}

.btc-transaction-preview h4 {
  margin: 0 0 16px 0;
  color: #f7931a;
  font-size: 14px;
}

.btc-tx-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.btc-tx-row:last-child {
  border-bottom: none;
}

.btc-tx-label {
  color: #888;
  font-size: 13px;
}

.btc-tx-value {
  font-family: monospace;
  font-size: 12px;
  color: #fff;
}

.btc-tx-value.highlight {
  color: #f7931a;
  font-weight: 600;
  font-size: 14px;
}

.btc-tx-hint {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid rgba(247, 147, 26, 0.2);
  color: #a0a0a0;
  font-size: 13px;
  text-align: center;
}

.btc-amount-warning {
  margin-top: 12px;
  padding: 12px;
  background: rgba(255, 193, 7, 0.1);
  border: 1px solid rgba(255, 193, 7, 0.3);
  border-radius: 8px;
  color: #ffc107;
  font-size: 12px;
  text-align: center;
}

.btc-deposit-desc strong {
  color: #f7931a;
}

.btc-deposit-address-box {
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid #333;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 20px;
}

.btc-deposit-address {
  flex: 1;
  font-family: monospace;
  font-size: 13px;
  color: #f7931a;
  word-break: break-all;
}

.btc-deposit-copy-btn {
  padding: 8px 16px;
  background: #333;
  border: 1px solid #444;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}

.btc-deposit-copy-btn:hover {
  background: #444;
}

.btc-deposit-info {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 20px;
}

.btc-deposit-info-item {
  background: rgba(0, 0, 0, 0.3);
  padding: 12px;
  border-radius: 8px;
}

.btc-deposit-info-label {
  display: block;
  color: #888;
  font-size: 12px;
  margin-bottom: 4px;
}

.btc-deposit-info-value {
  font-weight: 500;
  font-size: 13px;
}

.btc-deposit-info-value.mono {
  font-family: monospace;
}

.btc-deposit-instructions {
  background: rgba(247, 147, 26, 0.1);
  border: 1px solid rgba(247, 147, 26, 0.3);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 20px;
}

.btc-deposit-instructions h4 {
  margin: 0 0 12px 0;
  color: #f7931a;
  font-size: 14px;
}

.btc-deposit-instructions ol {
  margin: 0;
  padding-left: 20px;
  color: #a0a0a0;
  font-size: 13px;
}

.btc-deposit-instructions li {
  margin-bottom: 8px;
}

.btc-deposit-instructions strong {
  color: #f7931a;
}

.btc-deposit-actions {
  display: flex;
  justify-content: center;
}

.btc-deposit-btn {
  padding: 16px 48px;
  border-radius: 12px;
  border: none;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btc-deposit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btc-deposit-btn-primary {
  background: linear-gradient(90deg, #f7931a, #ffd700);
  color: #000;
}

.btc-deposit-btn-primary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 20px rgba(247, 147, 26, 0.4);
}
`;
