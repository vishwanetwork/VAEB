import { useState, useCallback, useRef, useEffect } from 'react';
import { ethers } from 'ethers';
import { CHAIN_CONFIGS, DEFAULT_CHAIN } from './config';
import { fetchBalances, sendChatMessage, executeChatIntent, ChatResponse, ExecuteResponse, ToolCallInfo } from './api';

// ── Types ─────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  toolCalls?: ToolCallInfo[];
  intent?: ChatResponse['intent'];
  txResult?: ExecuteResponse;
  signing?: boolean;
  execStep?: number; // 0=signing, 1=executing
}

interface WalletBalances {
  user: { eth: string; usdc: string; address: string };
  agent: { eth: string; usdc: string; address: string };
}

// ── Helpers ───────────────────────────────────────────────────

function truncAddr(addr: string, len = 6): string {
  if (addr.length <= len * 2 + 2) return addr;
  return addr.slice(0, len + 2) + '...' + addr.slice(-len);
}

let msgCounter = 0;
function nextId() {
  return `msg-${++msgCounter}-${Date.now()}`;
}

declare global {
  interface Window { ethereum?: any; }
}

// Return the MetaMask provider specifically (skips Coinbase Wallet and other injectors)
function getMetaMask(): any {
  const eth = (window as any).ethereum;
  if (!eth) return null;
  // When multiple wallets are installed, each is listed in eth.providers
  if (Array.isArray(eth.providers)) {
    return eth.providers.find((p: any) => p.isMetaMask && !p.isCoinbaseWallet) ?? null;
  }
  // Single provider — accept only if it's MetaMask
  if (eth.isMetaMask && !eth.isCoinbaseWallet) return eth;
  return null;
}

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
];

const EXEC_STEPS = [
  { label: 'Token Approval', desc: 'Approving USDC spending for AgentWallet...' },
  { label: 'EIP-712 Signature', desc: 'Requesting ZKIntent signature from wallet...' },
  { label: 'Backend Execution', desc: 'Submitting to MCP backend for on-chain execution...' },
];

// ── App ───────────────────────────────────────────────────────

export default function App() {
  // Chain
  const [selectedChainKey, setSelectedChainKey] = useState(DEFAULT_CHAIN);
  const activeChain = CHAIN_CONFIGS[selectedChainKey];

  // Wallet
  const [address, setAddress] = useState<string | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Balances
  const [balances, setBalances] = useState<WalletBalances | null>(null);

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when connected
  useEffect(() => {
    if (connected) inputRef.current?.focus();
  }, [connected]);

  // ── Send message (defined early so connectWallet can use it) ──

  const sendMessageRef = useRef<(text?: string, showInChat?: boolean) => Promise<void>>();

  const sendMessage = useCallback(async (text?: string, showInChat = true) => {
    const msg = text || input.trim();
    if (!msg || !address || loading) return;

    if (showInChat) {
      const userMsg: ChatMessage = { id: nextId(), role: 'user', text: msg };
      setMessages(prev => [...prev, userMsg]);
    }
    setInput('');
    setLoading(true);
    setShowSuggestions(false);

    try {
      const response = await sendChatMessage(msg, address, sessionId, selectedChainKey);
      setSessionId(response.sessionId);

      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        text: response.message,
        toolCalls: response.toolCalls,
        intent: response.intent,
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: `Error: ${err.message}`,
      }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, address, loading, sessionId]);

  sendMessageRef.current = sendMessage;

  // ── Connect Wallet ────────────────────────────────────────

  const handleChainChange = useCallback(async (chainKey: string) => {
    const chain = CHAIN_CONFIGS[chainKey];
    if (!chain) return;
    setSelectedChainKey(chainKey);
    const mm = getMetaMask();
    if (!mm || !connected) return;
    try {
      await mm.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainIdHex }] });
    } catch (e: any) {
      if (e.code === 4902) {
        await mm.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: chain.chainIdHex,
            chainName: chain.chainName,
            rpcUrls: [chain.rpcUrl],
            blockExplorerUrls: [chain.explorer],
            nativeCurrency: chain.nativeCurrency,
          }],
        });
      }
    }
  }, [connected]);

  const connectWallet = useCallback(async () => {
    setConnectError(null);
    const mm = getMetaMask();
    if (!mm) {
      setConnectError('MetaMask not detected. Please install MetaMask.');
      return;
    }

    try {
      await mm.request({ method: 'eth_requestAccounts' });

      const chainId = await mm.request({ method: 'eth_chainId' });
      if (chainId !== activeChain.chainIdHex) {
        try {
          await mm.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: activeChain.chainIdHex }],
          });
        } catch (switchError: any) {
          if (switchError.code === 4902) {
            await mm.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: activeChain.chainIdHex,
                chainName: activeChain.chainName,
                rpcUrls: [activeChain.rpcUrl],
                blockExplorerUrls: [activeChain.explorer],
                nativeCurrency: activeChain.nativeCurrency,
              }],
            });
          } else {
            throw switchError;
          }
        }
      }

      const provider = new ethers.BrowserProvider(mm);
      const s = await provider.getSigner();
      const addr = await s.getAddress();

      setSigner(s);
      setAddress(addr);
      setConnected(true);

      // Show welcome immediately — balance loads in background
      setMessages([{
        id: nextId(),
        role: 'assistant',
        text: `Welcome! Your agent wallet is ready.\n\nI'm connected to the Rent a Human marketplace — I can find and hire real people to handle physical tasks for you. Groceries, dog walking, deliveries, you name it.\n\nWhat do you need done today?`,
      }]);
      setShowSuggestions(true);

      // Load balances non-blocking
      fetchBalances(addr, activeChain.key)
        .then(bals => setBalances(bals))
        .catch(err => console.error('Balance fetch failed:', err));

      mm.on('accountsChanged', () => location.reload());
      mm.on('chainChanged', () => location.reload());
    } catch (err: any) {
      console.error('Connection failed:', err);
      setConnectError(err?.message || 'Connection failed. Check console for details.');
    }
  }, [activeChain]);

  // ── Handle suggestion click ────────────────────────────────

  const handleSuggestion = useCallback((text: string) => {
    setShowSuggestions(false);
    sendMessageRef.current?.(text);
  }, []);

  // ── Refresh balances ──────────────────────────────────────

  const refreshBalances = useCallback(async () => {
    if (!address) return;
    try {
      const bals = await fetchBalances(address, activeChain.key);
      setBalances(bals);
    } catch (err) {
      console.error('Balance refresh failed:', err);
    }
  }, [address, activeChain]);

  // ── Sign & Execute intent with ZK verification log ─────────

  const handleApprove = useCallback(async (msgId: string, intent: NonNullable<ChatResponse['intent']>) => {
    if (!signer) return;

    // Step 0: Token Approval (ERC-8150 non-custodial: user approves AgentWallet to spend USDC)
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, execStep: 0, intent: undefined } : m
    ));

    try {
      // Approve AgentWallet to transferFrom user's USDC
      if (intent.approvalToken && intent.approvalTarget && intent.approvalAmount) {
        const erc20 = new ethers.Contract(intent.approvalToken, ERC20_ABI, signer);
        const approveTx = await erc20.approve(intent.approvalTarget, intent.approvalAmount);
        await approveTx.wait();
      }

      // Step 1: EIP-712 Signature (ZKIntent: nonce, expiry, commitment)
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, execStep: 1 } : m
      ));

      const { domain, types, message } = intent.eip712;
      const signature = await signer.signTypedData(domain, types, message);

      // Step 2: Backend Execution
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, execStep: 2 } : m
      ));

      const result = await executeChatIntent(intent.reviewId, signature, selectedChainKey);

      // Done — attach result + MCP tool calls from execution
      setMessages(prev => prev.map(m =>
        m.id === msgId ? {
          ...m,
          execStep: undefined,
          txResult: result,
          toolCalls: [...(m.toolCalls || []), ...(result.toolCalls || [])],
        } : m
      ));

      const execNote =
        result.executionPath === 'executeWithProof'
          ? 'ZK proof verified on-chain.'
          : 'Executed via signature-only fallback.';

      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'assistant',
        text: `Payment confirmed! ${result.amount} USDC sent to ${result.humanName} for "${result.task}". ${execNote}`,
      }]);

      await refreshBalances();
    } catch (err: any) {
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, execStep: undefined } : m
      ));
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: `Transaction failed: ${err.reason || err.message}`,
      }]);
    }
  }, [signer, refreshBalances]);

  const handleDecline = useCallback((msgId: string) => {
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, intent: undefined } : m
    ));
    sendMessage("I changed my mind, let's not do that.");
  }, [sendMessage]);

  // ── Key handler ───────────────────────────────────────────

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-top">
          <div className="logo">VAEB</div>
          <div className="header-right">
            <div className="network-badge">
              <span className={`network-dot${connected ? ' live' : ''}`} />
              <select
                value={selectedChainKey}
                onChange={e => handleChainChange(e.target.value)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'inherit',
                  font: 'inherit',
                  fontSize: '11px',
                  cursor: 'pointer',
                  outline: 'none',
                  padding: 0,
                }}
              >
                {Object.values(CHAIN_CONFIGS).map(chain => (
                  <option key={chain.key} value={chain.key} style={{ background: '#0a0a0a' }}>
                    {chain.chainName}
                  </option>
                ))}
              </select>
            </div>
            {connected && balances && (
              <div className="balance-pill">
                <span className="balance-pill-val">{balances.user.usdc}</span>
                <span className="balance-pill-unit">USDC</span>
              </div>
            )}
          </div>
        </div>
        {!connected && (
          <p className="tagline">
            Tell an agent what you want.<br />
            It <em>proves</em> it won't cheat,<br />
            then executes on-chain.
          </p>
        )}
      </header>

      {/* Connect */}
      {!connected && (
        <section className="connect-section">
          <button className="btn btn-primary btn-connect" onClick={connectWallet}>
            Connect Wallet
          </button>
          <p className="connect-hint">Connect MetaMask to start chatting with your agent</p>
          {connectError && (
            <p style={{ color: '#ff6b6b', marginTop: '12px', fontSize: '13px', textAlign: 'center' }}>
              {connectError}
            </p>
          )}
        </section>
      )}

      {/* Chat */}
      {connected && (
        <div className="chat-container">
          <div className="messages">
            {messages.map(msg => (
              <div key={msg.id} className={`message message-${msg.role} fade-in`}>
                {msg.role === 'assistant' && (
                  <div className="message-avatar">
                    <div className="avatar-dot" />
                  </div>
                )}
                <div className="message-content">
                  {msg.role === 'system' ? (
                    <div className="system-msg">{msg.text}</div>
                  ) : (
                    <div className="message-text">{msg.text}</div>
                  )}

                  {/* MCP Tool Calls */}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="tool-calls-card fade-in">
                      <div className="tool-calls-header">
                        <div className="tool-calls-dots">
                          {[0, 1, 2].map(i => <span key={i} className="tool-calls-dot" />)}
                        </div>
                        <span className="tool-calls-label">MCP TOOL CALLS</span>
                      </div>
                      <div className="tool-calls-body">
                        {msg.toolCalls.map((tc, i) => (
                          <div key={i} className="tool-call-row">
                            <div className="tool-call-indicator">
                              <span className="tool-call-check">&#10003;</span>
                            </div>
                            <div className="tool-call-info">
                              <div className="tool-call-name">{tc.tool}</div>
                              <div className="tool-call-args">
                                {Object.entries(tc.args).map(([k, v]) => (
                                  <span key={k} className="tool-call-arg">
                                    {k}: {typeof v === 'string' ? v : JSON.stringify(v)}
                                  </span>
                                ))}
                              </div>
                              <div className="tool-call-timing">{tc.durationMs}ms</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Intent approval card */}
                  {msg.intent && msg.execStep === undefined && (
                    <div className="intent-card fade-in">
                      <div className="intent-header">
                        <div className="intent-dots">
                          {[0, 1, 2].map(i => <span key={i} className="intent-dot" />)}
                        </div>
                        <span className="intent-label">PAYMENT INTENT</span>
                      </div>
                      <div className="intent-body">
                        <div className="intent-row">
                          <span className="intent-key">Hire</span>
                          <span className="intent-val">{msg.intent.humanName}</span>
                        </div>
                        <div className="intent-row">
                          <span className="intent-key">Task</span>
                          <span className="intent-val">{msg.intent.task}</span>
                        </div>
                        <div className="intent-row">
                          <span className="intent-key">Amount</span>
                          <span className="intent-val intent-amount">{msg.intent.amount} USDC</span>
                        </div>
                        <div className="intent-row">
                          <span className="intent-key">To</span>
                          <span className="intent-val mono">{truncAddr(msg.intent.recipient)}</span>
                        </div>
                        <div className="intent-row">
                          <span className="intent-key">Expires</span>
                          <span className="intent-val mono">{new Date(msg.intent.expiry * 1000).toLocaleTimeString()}</span>
                        </div>
                      </div>
                      <div className="intent-actions">
                        <button className="btn btn-sm" onClick={() => handleDecline(msg.id)}>
                          Decline
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleApprove(msg.id, msg.intent!)}
                        >
                          Sign & Pay
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ZK Verification Log */}
                  {msg.execStep !== undefined && (
                    <div className="exec-log fade-in">
                      <div className="exec-log-header">
                        <div className="exec-log-dots">
                          {[0, 1, 2].map(i => <span key={i} className="exec-log-dot" />)}
                        </div>
                        <span className="exec-log-label">EXECUTION LOG (PENDING)</span>
                      </div>
                      <div className="exec-log-body">
                        {EXEC_STEPS.map((step, i) => (
                          <div key={i} className={`exec-log-row ${
                            i < msg.execStep! ? 'done' :
                            i === msg.execStep! ? 'active' : 'pending'
                          }`}>
                            <div className="exec-log-indicator">
                              {i < msg.execStep! ? (
                                <span className="exec-log-check">&#10003;</span>
                              ) : i === msg.execStep! ? (
                                <span className="exec-log-spinner" />
                              ) : (
                                <span className="exec-log-circle" />
                              )}
                            </div>
                            <div className="exec-log-info">
                              <div className="exec-log-step-label">{step.label}</div>
                              <div className="exec-log-step-desc">
                                {i < msg.execStep! ? 'Completed' :
                                  i === msg.execStep! ? step.desc : 'Waiting...'}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Actual execution steps (from backend) */}
                  {msg.txResult?.steps && (
                    <div className="exec-log fade-in">
                      <div className="exec-log-header">
                        <div className="exec-log-dots">
                          {[0, 1, 2].map(i => <span key={i} className="exec-log-dot" />)}
                        </div>
                        <span className="exec-log-label">EXECUTION PATH (ACTUAL)</span>
                      </div>
                      <div className="exec-log-body">
                        {msg.txResult.steps.map((step, i) => {
                          const statusClass =
                            step.status === 'success' || step.status === 'fallback'
                              ? 'done'
                              : 'pending';
                          const label = step.step.replace(/_/g, ' ');
                          const detail = step.detail || (step.status === 'fallback'
                            ? 'Fallback path used'
                            : step.status === 'skipped'
                              ? 'Skipped'
                              : 'Success');
                          return (
                            <div key={i} className={`exec-log-row ${statusClass}`}>
                              <div className="exec-log-indicator">
                                {(step.status === 'success' || step.status === 'fallback') ? (
                                  <span className="exec-log-check">&#10003;</span>
                                ) : (
                                  <span className="exec-log-circle" />
                                )}
                              </div>
                              <div className="exec-log-info">
                                <div className="exec-log-step-label">{label}</div>
                                <div className="exec-log-step-desc">{detail}</div>
                                <div className="exec-log-detail">
                                  <span>duration: {step.durationMs}ms</span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Transaction result */}
                  {msg.txResult && (
                    <div className="tx-result fade-in">
                      <div className="tx-result-header">
                        <div className="tx-check">&#10003;</div>
                        <span>Transaction confirmed</span>
                      </div>
                      <div className="tx-result-body">
                        <div className="tx-row">
                          <span className="tx-key">Hash</span>
                          <a
                            className="tx-val mono"
                            href={msg.txResult.explorerUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {truncAddr(msg.txResult.txHash, 10)}
                          </a>
                        </div>
                        <div className="tx-row">
                          <span className="tx-key">Paid</span>
                          <span className="tx-val">{msg.txResult.amount} USDC to {msg.txResult.humanName}</span>
                        </div>
                        <div className="tx-balances">
                          <span className="tx-bal">{msg.txResult.balanceBefore}</span>
                          <span className="tx-arrow">&rarr;</span>
                          <span className="tx-bal">{msg.txResult.balanceAfter} USDC</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Suggestion chips */}
            {showSuggestions && !loading && (
              <div className="suggestions fade-in">
                {[
                  "I need someone to pick up groceries for me",
                  "Can you find a dog walker nearby?",
                  "I need help moving some furniture this weekend",
                  "Who can run a few errands around town?",
                ].map((text, i) => (
                  <button
                    key={i}
                    className="suggestion-chip"
                    onClick={() => handleSuggestion(text)}
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}

            {/* Loading indicator */}
            {loading && (
              <div className="message message-assistant fade-in">
                <div className="message-avatar">
                  <div className="avatar-dot thinking" />
                </div>
                <div className="message-content">
                  <div className="thinking-dots">
                    <span /><span /><span />
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="chat-input-container">
            <div className="chat-input-bar">
              <input
                ref={inputRef}
                className="chat-input"
                type="text"
                placeholder="Tell me what errand you need..."
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={loading}
              />
              <button
                className="send-btn"
                onClick={() => sendMessage()}
                disabled={!input.trim() || loading}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M14 2L7 9M14 2L9.5 14L7 9M14 2L2 6.5L7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <div className="chat-input-hint">
              {connected && address && (
                <span className="input-wallet">{truncAddr(address)}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="footer">
        <span className="footer-text">Verified Agent Execution Bundle</span>
        <div className="footer-links">
          <a href={activeChain.explorer} target="_blank" rel="noopener noreferrer">Explorer</a>
          <a href="https://github.com/vishwanetwork/VAEB" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
      </footer>
    </div>
  );
}
