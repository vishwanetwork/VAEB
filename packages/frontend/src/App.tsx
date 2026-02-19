import { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { CONFIG } from './config';
import { fetchBalances, reviewIntent, executeIntent, ReviewResponse, ExecuteResponse } from './api';

// ── Types ─────────────────────────────────────────────────────

type FlowStep = 'idle' | 'reviewing' | 'signing' | 'executing' | 'confirmed' | 'error';

interface WalletBalances {
  eth: string;
  usdc: string;
  address: string;
}

interface Balances {
  user: WalletBalances;
  agent: WalletBalances;
}

// ── Helpers ───────────────────────────────────────────────────

function truncAddr(addr: string, len = 6): string {
  if (addr.length <= len * 2 + 2) return addr;
  return addr.slice(0, len + 2) + '...' + addr.slice(-len);
}

// Extend window for MetaMask
declare global {
  interface Window {
    ethereum?: any;
  }
}

// ── App ───────────────────────────────────────────────────────

export default function App() {
  // Wallet
  const [address, setAddress] = useState<string | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [connected, setConnected] = useState(false);

  // Balances
  const [balances, setBalances] = useState<Balances | null>(null);

  // Intent form
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');

  // Flow
  const [step, setStep] = useState<FlowStep>('idle');
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [result, setResult] = useState<ExecuteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Connect Wallet ────────────────────────────────────────

  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      alert('Please install MetaMask to use this app.');
      return;
    }

    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });

      // Switch to Base Sepolia
      const chainId = await window.ethereum.request({ method: 'eth_chainId' });
      if (chainId !== CONFIG.chainIdHex) {
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: CONFIG.chainIdHex }],
          });
        } catch (switchError: any) {
          if (switchError.code === 4902) {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: CONFIG.chainIdHex,
                chainName: CONFIG.chainName,
                rpcUrls: [CONFIG.rpcUrl],
                blockExplorerUrls: [CONFIG.explorer],
                nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              }],
            });
          } else {
            throw switchError;
          }
        }
      }

      const provider = new ethers.BrowserProvider(window.ethereum);
      const s = await provider.getSigner();
      const addr = await s.getAddress();

      setSigner(s);
      setAddress(addr);
      setConnected(true);

      // Load balances
      const bals = await fetchBalances(addr);
      setBalances(bals);

      // Listen for changes
      window.ethereum.on('accountsChanged', () => location.reload());
      window.ethereum.on('chainChanged', () => location.reload());
    } catch (err) {
      console.error('Connection failed:', err);
    }
  }, []);

  // ── Refresh balances ──────────────────────────────────────

  const refreshBalances = useCallback(async () => {
    if (!address) return;
    try {
      const bals = await fetchBalances(address);
      setBalances(bals);
    } catch (err) {
      console.error('Balance refresh failed:', err);
    }
  }, [address]);

  // ── Review Intent ─────────────────────────────────────────

  const handleReview = useCallback(async () => {
    if (!address) return;

    try {
      setStep('reviewing');
      setError(null);

      const data = await reviewIntent({
        actionType: 'TRANSFER',
        token: 'USDC',
        amount,
        recipient,
        signerAddress: address,
      });

      setReview(data);
    } catch (err: any) {
      setError(err.message);
      setStep('error');
    }
  }, [address, amount, recipient]);

  // ── Sign & Execute ────────────────────────────────────────

  const handleSignAndExecute = useCallback(async () => {
    if (!signer || !review) return;

    try {
      // Step: signing
      setStep('signing');
      setError(null);

      // Sign EIP-712 typed data via MetaMask
      const { domain, types, message } = review.eip712;
      const signature = await signer.signTypedData(domain, types, message);

      // Step: executing
      setStep('executing');

      const execResult = await executeIntent({
        reviewId: review.reviewId,
        signature,
      });

      setResult(execResult);
      setStep('confirmed');

      // Refresh balances
      await refreshBalances();
    } catch (err: any) {
      console.error('Execution failed:', err);
      setError(err.reason || err.message || 'Transaction failed');
      setStep('error');
    }
  }, [signer, review, refreshBalances]);

  // ── Reset ─────────────────────────────────────────────────

  const resetFlow = useCallback(() => {
    setStep('idle');
    setReview(null);
    setResult(null);
    setError(null);
  }, []);

  const resetAll = useCallback(() => {
    resetFlow();
    setAmount('');
    setRecipient('');
    refreshBalances();
  }, [resetFlow, refreshBalances]);

  // ── Form validation ───────────────────────────────────────

  const isFormValid = amount.trim() !== '' &&
    parseFloat(amount) > 0 &&
    recipient.trim().length === 42 &&
    recipient.startsWith('0x');

  // ── Compute active step number for dots ───────────────────

  const activeStep = step === 'idle' ? 0
    : step === 'reviewing' ? 1
    : step === 'signing' ? 2
    : step === 'executing' ? 3
    : step === 'confirmed' ? 4
    : 0;

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="app">

      {/* Header */}
      <header className="header">
        <div className="header-top">
          <div className="logo">VAEB</div>
          <div className="network-badge">
            <span className={`network-dot${connected ? ' live' : ''}`} />
            Base Sepolia
          </div>
        </div>
        <p className="tagline">
          Tell an agent what you want.<br />
          It <em>proves</em> it won't cheat,<br />
          then executes on-chain.
        </p>
      </header>

      {/* 01 — Connect */}
      <section className="section">
        <div className="section-label">01 &mdash; Connect</div>
        <div className="wallet-bar">
          <div className="wallet-info">
            <div className={`wallet-dot${connected ? ' connected' : ''}`} />
            <span className="wallet-address">
              {connected ? truncAddr(address!) : 'Not connected'}
            </span>
          </div>
          <button
            className="btn"
            onClick={connectWallet}
            disabled={connected}
          >
            {connected ? 'Connected' : 'Connect'}
          </button>
        </div>

        {balances && (
          <div className="balances fade-in">
            <div className="balance-card">
              <div className="balance-label">YOUR WALLET</div>
              <div className="balance-row">
                <span className="balance-value">{parseFloat(balances.user.eth).toFixed(4)}</span>
                <span className="balance-unit">ETH</span>
              </div>
              <div className="balance-row">
                <span className="balance-value">{balances.user.usdc}</span>
                <span className="balance-unit">USDC</span>
              </div>
              <div className="balance-sub">{truncAddr(address!)}</div>
            </div>
            <div className="balance-card">
              <div className="balance-label">AGENT WALLET</div>
              <div className="balance-row">
                <span className="balance-value">{parseFloat(balances.agent.eth).toFixed(4)}</span>
                <span className="balance-unit">ETH</span>
              </div>
              <div className="balance-row">
                <span className="balance-value">{balances.agent.usdc}</span>
                <span className="balance-unit">USDC</span>
              </div>
              <div className="balance-sub">{truncAddr(CONFIG.contracts.AgentWallet)}</div>
            </div>
          </div>
        )}
      </section>

      {/* 02 — Intent */}
      {connected && step === 'idle' && (
        <section className="section fade-in">
          <div className="section-label">02 &mdash; Intent</div>

          <div className="form-group">
            <label className="form-label">Action</label>
            <select className="input" disabled>
              <option>Transfer</option>
            </select>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Token</label>
              <select className="input" disabled>
                <option>USDC</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Amount</label>
              <input
                className="input input-mono"
                type="text"
                placeholder="0.00"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Recipient</label>
            <input
              className="input input-mono"
              type="text"
              placeholder="0x..."
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
            />
          </div>

          <div className="btn-row">
            <button
              className="btn btn-primary"
              onClick={handleReview}
              disabled={!isFormValid}
            >
              Review Intent
            </button>
          </div>
        </section>
      )}

      {/* 03 — Execute */}
      {step !== 'idle' && (
        <section className="section fade-in">
          <div className="section-label">03 &mdash; Execute</div>

          {/* Progress dots */}
          <div className="flow-steps">
            {[1, 2, 3, 4].map(i => (
              <span key={`step-${i}`}>
                <span className={`step-dot${i < activeStep ? ' done' : i === activeStep ? ' active' : ''}`} />
                {i < 4 && <span className={`step-line${i < activeStep ? ' done' : ''}`} />}
              </span>
            ))}
          </div>
          <div className="step-labels">
            {['Review', 'Sign', 'Prove', 'Execute'].map((label, i) => (
              <span
                key={label}
                className={`step-label${i + 1 < activeStep ? ' done' : i + 1 === activeStep ? ' active' : ''}`}
              >
                {label}
              </span>
            ))}
          </div>

          {/* Review panel */}
          {step === 'reviewing' && review && (
            <div style={{ marginTop: 32 }}>
              <div className="review-panel">
                <div className="review-row">
                  <span className="review-key">Action</span>
                  <span className="review-val">{review.action}</span>
                </div>
                <div className="review-row">
                  <span className="review-key">Token</span>
                  <span className="review-val">{review.token}</span>
                </div>
                <div className="review-row">
                  <span className="review-key">Amount</span>
                  <span className="review-val">{review.amount} {review.token}</span>
                </div>
                <div className="review-row">
                  <span className="review-key">Recipient</span>
                  <span className="review-val">{truncAddr(review.recipient)}</span>
                </div>
                <div className="review-row">
                  <span className="review-key">From</span>
                  <span className="review-val">{truncAddr(review.from)}</span>
                </div>
                <div className="review-row">
                  <span className="review-key">Nonce</span>
                  <span className="review-val">{review.nonce.slice(0, 14)}...</span>
                </div>
                <div className="review-row">
                  <span className="review-key">Expires</span>
                  <span className="review-val">{new Date(review.expiry * 1000).toLocaleTimeString()}</span>
                </div>
              </div>
              <div className="btn-row">
                <button className="btn" onClick={resetFlow}>Cancel</button>
                <button className="btn btn-primary" onClick={handleSignAndExecute}>
                  Sign & Execute
                </button>
              </div>
            </div>
          )}

          {/* Signing / Executing status */}
          {(step === 'signing' || step === 'executing') && (
            <div style={{ marginTop: 32 }}>
              <div className="exec-status">
                <div className="exec-step">
                  <span className={`exec-dot${step === 'signing' ? ' active' : ' done'}`} />
                  <span className={`exec-text${step === 'signing' ? ' active' : ' done'}`}>
                    {step === 'signing' ? 'Requesting EIP-712 signature...' : 'Signature obtained'}
                  </span>
                </div>
                <div className="exec-step">
                  <span className={`exec-dot${step === 'executing' ? ' active' : ''}`} />
                  <span className={`exec-text${step === 'executing' ? ' active' : ''}`}>
                    {step === 'executing' ? 'Submitting transaction on-chain...' : 'Waiting...'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Error */}
          {step === 'error' && error && (
            <div style={{ marginTop: 32 }}>
              <div className="error-msg">{error}</div>
              <div className="btn-row">
                <button className="btn" onClick={resetFlow}>Try again</button>
              </div>
            </div>
          )}

          {/* Result */}
          {step === 'confirmed' && result && (
            <div style={{ marginTop: 32 }}>
              <div className="result-panel fade-in">
                <div className="result-dots">
                  {[0, 1, 2, 3, 4].map(i => <div key={i} className="dot" />)}
                </div>
                <div className="result-title">Transaction confirmed</div>
                <div className="result-tx">{truncAddr(result.txHash, 16)}</div>
                <div className="result-tx">
                  <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer">
                    View on BaseScan
                  </a>
                </div>
                <div className="result-balances">
                  <div className="result-balance">
                    <div className="result-balance-label">Before</div>
                    <div className="result-balance-val">{result.balanceBefore} USDC</div>
                  </div>
                  <div className="result-arrow">&rarr;</div>
                  <div className="result-balance">
                    <div className="result-balance-label">After</div>
                    <div className="result-balance-val">{result.balanceAfter} USDC</div>
                  </div>
                </div>
              </div>
              <div className="btn-row">
                <button className="btn" onClick={resetAll}>New intent</button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Footer */}
      <footer className="footer">
        <span className="footer-text">Verified Agent Execution Bundle</span>
        <div className="footer-links">
          <a href="https://sepolia.basescan.org" target="_blank" rel="noopener noreferrer">BaseScan</a>
          <a href="https://github.com/vishwanetwork/VAEB" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
      </footer>
    </div>
  );
}
