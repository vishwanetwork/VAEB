import { useState, useCallback, useRef, useEffect } from 'react';
import { ethers } from 'ethers';
import { CHAIN_CONFIGS, DEFAULT_CHAIN, CONFIG } from './config';
import { fetchBalances, fetchTools, sendChatMessage, executeChatIntent, ChatResponse, ExecuteResponse, ToolCallInfo, ToolDef } from './api';
import { BTCWalletConnector, useBTCWallet, btcWalletStyles, sendBitcoinGlobal } from './btc-wallet';
import { executeX402Payment, X402PaymentDetails, X402Intent, x402Styles } from './x402-payment';

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
  if(addr){
    if (addr.length <= len * 2 + 2) return addr;
    return addr.slice(0, len + 2) + '...' + addr.slice(-len);
  } else {
    return ''
  }
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
  'function allowance(address owner, address spender) view returns (uint256)',
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

  // Tools
  const [toolDefs, setToolDefs] = useState<ToolDef[]>([]);
  const [toolsProvider, setToolsProvider] = useState('');
  const [showTools, setShowTools] = useState(false);

  // BTC Wallet
  const [showBTCConnector, setShowBTCConnector] = useState(false);
  const [btcWalletAddress, setBtcWalletAddress] = useState<string | null>(null);
  const [btcConnectReason, setBtcConnectReason] = useState<'stake' | 'transfer' | 'connect_only' | null>(null);


  // X402 Payment
  const [x402Payment, setX402Payment] = useState<X402PaymentDetails | null>(null);
  const [x402Intent, setX402Intent] = useState<X402Intent | null>(null);
  const [payingX402, setPayingX402] = useState(false);

  // BTC Deposit
  const [btcDepositInfo, setBtcDepositInfo] = useState<{
    depositAddress: string;
    amount: string;
    intentId: string;
  } | null>(null);
  const [confirmingBTC, setConfirmingBTC] = useState(false);
  const [signingBTC, setSigningBTC] = useState(false);

  // Pending stake info (after x402 payment, before wallet connection)
  const [pendingStakeInfo, setPendingStakeInfo] = useState<{
    depositAddress: string;
    amount: string;
    intentId: string;
  } | null>(null);

  // BTC Transfer
  const [btcTransferInfo, setBtcTransferInfo] = useState<{
    toAddress: string;
    amount: string;
    memo?: string;
    network: string;
  } | null>(null);
  const [sendingBTCTransfer, setSendingBTCTransfer] = useState(false);

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
      console.log('[Chat] intent result: ', response.intent);

      // Always show connector for new connection requests
      // setShowBTCConnector(true);
      // setBtcConnectReason('connect_only');

      // Store intent details for post-connection handling
      if (!btcWalletAddress && response.intent?.type === 'CONNECT_BTC_WALLET') {
        const intent = response.intent as any;
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          text: `Please connect your BTC wallet${intent.reason ? ` for ${intent.reason}` : ''}.`,
        }]);
      }

      // Handle SEND_BTC_TRANSFER intent
      if (response.intent?.type === 'SEND_BTC_TRANSFER') {
        const intent = response.intent as any;
        console.log('[Chat] SEND_BTC_TRANSFER intent:', intent);

        if (!btcWalletAddress) {
          // Wallet not connected - show connector first
          setShowBTCConnector(true);
          setBtcConnectReason('transfer');
          setBtcTransferInfo({
            toAddress: intent.toAddress,
            amount: intent.amount,
            memo: intent.memo,
            network: intent.network || 'testnet',
          });
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            text: `Please connect your BTC wallet first to send ${intent.amount} BTC.`,
          }]);
        } else {
          // Wallet connected - prepare transfer
          setBtcTransferInfo({
            toAddress: intent.toAddress,
            amount: intent.amount,
            memo: intent.memo,
            network: intent.network || 'testnet',
          });
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            text: `Ready to send ${intent.amount} BTC to ${intent.toAddress.slice(0, 10)}...`,
          }]);
        }
      }

      // Check if x402 payment is required
      if (response.intent?.type === 'BTC_STAKE_PAYMENT_REQUIRED') {
        const intent = response.intent as any;
        setX402Payment({
          amount: intent.paymentAmount,
          amountDisplay: `$${(parseInt(intent.paymentAmount) / 1000000)}`,
          asset: intent.paymentAsset,
          payTo: intent.payTo,
          network: 'base',
          description: 'Obtain BTC staking address',
          maxTimeoutSeconds: 60,
          resource: 'https://mcp-x402.vishwanetwork.xyz/api/bridge/sui/btc2btcvc',
        });
        setX402Intent({
          ...intent,
          intentId: intent.reviewId || intent.intentId,
        } as X402Intent);
      }

      // Check if BTC deposit address is ready (supports both BTC_STAKE and STAKE_BTC)
      if ((response.intent?.type === 'BTC_STAKE' || response.intent?.type === 'STAKE_BTC') && response.intent.depositAddress) {
        const intent = response.intent as any;
        // Show deposit card directly - user is ready to send BTC
        setBtcDepositInfo({
          depositAddress: intent.depositAddress,
          amount: intent.amount,
          intentId: intent.reviewId || intent.intentId,
        });
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          text: `Ready to deposit ${intent.amount} BTC. Click "Sign & Pay" to send from your connected wallet.`,
        }]);
      }

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

  const connectEvmWallet = useCallback(async () => {
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
        text: `Welcome! Your wallet is connected.\n\nI can help you stake BTC to receive BTCVC on Sui, or execute DeFi transactions with ZK verification.\n\nWhat would you like to do?`,
      }]);
      setShowSuggestions(true);

      // Load balances and tools non-blocking
      fetchBalances(addr, activeChain.key)
        .then(bals => setBalances(bals))
        .catch(err => console.error('Balance fetch failed:', err));
      fetchTools()
        .then(res => { setToolDefs(res.tools); setToolsProvider(res.provider); })
        .catch(err => console.error('Tools fetch failed:', err));

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
      // Approve AgentWallet to transferFrom user's USDC (skip if allowance already sufficient)
      if (intent.approvalToken && intent.approvalTarget && intent.approvalAmount) {
        const erc20 = new ethers.Contract(intent.approvalToken, ERC20_ABI, signer);
        const currentAllowance = await erc20.allowance(await signer.getAddress(), intent.approvalTarget);
        if (currentAllowance < BigInt(intent.approvalAmount)) {
          const approveTx = await erc20.approve(intent.approvalTarget, intent.approvalAmount, { gasLimit: 60000n });
          await approveTx.wait();
        }
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

  // ── X402 Payment ──────────────────────────────────────────

  const handleX402Pay = useCallback(async () => {
    if (!signer || !x402Payment || !x402Intent) return;

    setPayingX402(true);
    try {
      // Step 1: Generate EIP-712 signature for x402 payment (payai format)
      const paymentResult = await executeX402Payment(signer, x402Payment);

      // setMessages(prev => [...prev, {
      //   id: nextId(),
      //   role: 'system',
      //   text: `Payment signature generated, fetching BTC staking address...`,
      // }]);

      // Step 2: Route payment through the server (updates btcPaymentStore + calls bridge)
      console.log('[X402] Sending payment to server for intent:', x402Intent.intentId);

      const response = await fetch(`${CONFIG.apiUrl}/btc-payment/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentId: x402Intent.intentId,
          paymentHeader: paymentResult.paymentHeader,
          amountBtc: x402Intent.amount,
          network: x402Intent.network,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }

      const resultData = await response.json();
      console.log('[X402] Server response:', resultData);

      if (!resultData.success) {
        throw new Error(resultData.error || 'Payment failed on server');
      }

      // Add success message
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: `BTC staking address obtained! Preparing deposit details... BTC wallet connection`,
      }]);

      // if (!btcWalletAddress) {
      //   setMessages(prev => [...prev, {
      //     id: nextId(),
      //     role: 'system',
      //     text: `The BTC wallet has not been connected yet. Please connect the wallet first`,
      //   }]);
      //   setBtcConnectReason('stake');
      // }

      setShowBTCConnector(true);
      setBtcConnectReason("stake");

      // Clear payment UI
      setX402Payment(null);
      setX402Intent(null);

      // Save deposit info for later (will show card after wallet connection via MCP)
      const depositAddress = resultData.deposit_address;
      if (depositAddress) {
        setPendingStakeInfo({
          depositAddress,
          amount: x402Intent.amount,
          intentId: x402Intent.intentId,
        });
      }

    } catch (err: any) {
      console.error('[X402 Payment] Error:', err);
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: `Payment failed: ${err.message}`,
      }]);
    } finally {
      setPayingX402(false);
    }
  }, [signer, x402Payment, x402Intent]);

  const handleX402Cancel = useCallback(() => {
    setX402Payment(null);
    setX402Intent(null);
    sendMessage("I don't want to pay the service fee right now");
  }, [sendMessage]);

  // ── BTC Deposit Confirmation ──────────────────────────────

  const handleBTCDepositConfirm = useCallback(async () => {
    if (!btcDepositInfo) return;

    setConfirmingBTC(true);
    try {
      // Manual confirmation - user provides tx hash
      const txHash = prompt("Please enter your BTC transaction hash (txid):");

      if (!txHash) {
        setConfirmingBTC(false);
        return;
      }

      // Send confirmation message
      await sendMessage(
        `I have sent BTC, transaction hash is ${txHash}, intent_id is ${btcDepositInfo.intentId}, please confirm the deposit`,
        true
      );

      // Clear deposit UI
      setBtcDepositInfo(null);
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: `Confirmation failed: ${err.message}`,
      }]);
    } finally {
      setConfirmingBTC(false);
    }
  }, [btcDepositInfo, sendMessage]);

  // ── BTC Sign and Send ─────────────────────────────────────

  const handleBTCSignAndSend = useCallback(async (depositInfo?: null | {
    depositAddress: string;
    amount: string;
    intentId: string
  }) => {
    const info = depositInfo || btcDepositInfo;
    if (!info || !btcWalletAddress) return;

    setSigningBTC(true);
    try {
      // Convert BTC amount to satoshis
      const amountInSatoshi = Math.floor(parseFloat(info.amount) * 100000000);

      // Call wallet to sign and send (using global function)
      const txid = await sendBitcoinGlobal(info.depositAddress, amountInSatoshi);

      // Add success message
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: `BTC transaction broadcast! Tx hash: ${txid.slice(0, 10)}...`,
      }]);

      // Send confirmation to backend
      await sendMessage(
        `I have sent BTC, transaction hash is ${txid}, intent_id is ${info.intentId}, please confirm the deposit`,
        true
      );

      // Clear deposit UI
      setBtcDepositInfo(null);
    } catch (err: any) {
      console.error('[BTC Sign] Error:', err);
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: `BTC transaction failed: ${err.message}`,
      }]);
    } finally {
      setSigningBTC(false);
    }
  }, [btcDepositInfo, btcWalletAddress, sendMessage]);

  // ── Execute BTC Transfer ──────────────────────────────────

  const handleExecuteBTCTransfer = useCallback(async () => {
    if (!btcTransferInfo || !btcWalletAddress) return;

    setSendingBTCTransfer(true);
    try {
      // Convert BTC amount to satoshis
      const amountInSatoshi = Math.floor(parseFloat(btcTransferInfo.amount) * 100000000);

      // Call wallet to sign and send (using global function)
      const txid = await sendBitcoinGlobal(btcTransferInfo.toAddress, amountInSatoshi);

      // Add success message
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: `BTC transfer successful! Sent ${btcTransferInfo.amount} BTC to ${btcTransferInfo.toAddress.slice(0, 10)}... Tx hash: ${txid.slice(0, 16)}...`,
      }]);

      // Clear transfer info
      setBtcTransferInfo(null);

      // Notify backend
      await sendMessage(
        `I have successfully sent ${btcTransferInfo.amount} BTC to ${btcTransferInfo.toAddress}. Transaction hash: ${txid}`,
        true
      );
    } catch (err: any) {
      console.error('[BTC Transfer] Error:', err);
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: `BTC transfer failed: ${err.message}`,
      }]);
    } finally {
      setSendingBTCTransfer(false);
    }
  }, [btcTransferInfo, btcWalletAddress, sendMessage]);

  // ── BTC Wallet Connection ─────────────────────────────────

  const handleBTCConnect = useCallback(async (btcAddress: string, walletType: string) => {
    setBtcWalletAddress(btcAddress);
    setShowBTCConnector(false);

    // Notify the chat that BTC wallet is connected
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system',
      text: `BTC wallet connected: ${btcAddress.slice(0, 10)}...${btcAddress.slice(-8)} (${walletType})`,
    }]);

    // Handle different connection reasons
    const reason = btcConnectReason;
    setBtcConnectReason(null); // Reset reason after use

    console.log('[BTC Connect] Reason:', reason);

    switch (reason) {
      case 'stake':
        // BTC staking flow - send message to get STAKE_BTC intent from MCP
        if (pendingStakeInfo) {
          await sendMessage(
            `BTC wallet connected. I need to transfer ${pendingStakeInfo.amount} BTC to the staking address ${pendingStakeInfo.depositAddress}. Please initiate the transaction. Intent ID: ${pendingStakeInfo.intentId}`,
            false
          );
          // Clear pending info after sending
          setPendingStakeInfo(null);
        } else {
          // No pending stake info, just notify connection
          await sendMessage(`BTC wallet connected, address is ${btcAddress}`, false);
        }
        break;
      case 'transfer':
        // BTC transfer flow - execute transfer if we have transfer info
        if (btcTransferInfo) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            text: `Ready to send ${btcTransferInfo.amount} BTC.`,
          }]);
          await handleExecuteBTCTransfer();
        }
        break;

      case 'connect_only':
        setShowBTCConnector(true)
        break;
    }
  }, [sendMessage, btcConnectReason, pendingStakeInfo, btcTransferInfo, handleExecuteBTCTransfer]);

  const handleBTCCancel = useCallback(() => {
    setShowBTCConnector(false);
    sendMessage("I don't want to connect a BTC wallet right now");
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
            {connected && toolDefs && toolDefs.length > 0 && (
              <button
                className="tools-toggle"
                onClick={() => setShowTools(v => !v)}
                title="View MCP Tools"
              >
                {showTools ? 'Hide Tools' : `Tools (${toolDefs?.length || 0})`}
              </button>
            )}
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
          <button className="btn btn-primary btn-connect" onClick={connectEvmWallet}>
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

      {/* Tools Panel */}
            {showTools && toolDefs && toolDefs.length > 0 && (
        <div className="tools-panel fade-in">
          <div className="tools-panel-header">
            <span className="tools-panel-title">MCP Tools</span>
            <span className="tools-panel-provider">{toolsProvider}</span>
          </div>
          <div className="tools-panel-list">
            {toolDefs.map(t => (
              <div key={t.name} className="tools-panel-item">
                <div className="tools-panel-name">{t.name}</div>
                <div className="tools-panel-desc">{t.description}</div>
                {t.parameters && t.parameters.length > 0 && (
                  <div className="tools-panel-params">
                    {t.parameters.map(p => (
                      <span key={p.name} className="tools-panel-param">
                        {p.name}{p.required ? '*' : ''}: <em>{p.type}</em>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Chat */}
      {connected && (
        <div className="chat-container">
          <div className="messages">
            {messages.map((msg, index) => (
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
                  {/*{msg.toolCalls && msg.toolCalls.length > 0 && (*/}
                  {/*  <div className="tool-calls-card fade-in">*/}
                  {/*    <div className="tool-calls-header">*/}
                  {/*      <div className="tool-calls-dots">*/}
                  {/*        {[0, 1, 2].map(i => <span key={i} className="tool-calls-dot" />)}*/}
                  {/*      </div>*/}
                  {/*      <span className="tool-calls-label">MCP TOOL CALLS</span>*/}
                  {/*    </div>*/}
                  {/*    <div className="tool-calls-body">*/}
                  {/*      {msg.toolCalls.map((tc, i) => (*/}
                  {/*        <div key={i} className="tool-call-row">*/}
                  {/*          <div className="tool-call-indicator">*/}
                  {/*            <span className="tool-call-check">&#10003;</span>*/}
                  {/*          </div>*/}
                  {/*          <div className="tool-call-info">*/}
                  {/*            <div className="tool-call-name">{tc.tool}</div>*/}
                  {/*            <div className="tool-call-args">*/}
                  {/*              {Object.entries(tc.args).map(([k, v]) => (*/}
                  {/*                <span key={k} className="tool-call-arg">*/}
                  {/*                  {k}: {typeof v === 'string' ? v : JSON.stringify(v)}*/}
                  {/*                </span>*/}
                  {/*              ))}*/}
                  {/*            </div>*/}
                  {/*            <div className="tool-call-timing">{tc.durationMs}ms</div>*/}
                  {/*          </div>*/}
                  {/*        </div>*/}
                  {/*      ))}*/}
                  {/*    </div>*/}
                  {/*  </div>*/}
                  {/*)}*/}


                  {/* X402 Payment Card - only show for messages with BTC_STAKE_PAYMENT_REQUIRED intent */}
                  {msg.intent && msg.intent.type == 'BTC_STAKE_PAYMENT_REQUIRED' && x402Payment && (
                    <div className="intent-card fade-in">
                      <div className="intent-header">
                        <div className="intent-dots">
                          {[0, 1, 2].map(i => <span key={i} className="intent-dot" />)}
                        </div>
                        <span className="intent-label">x402 Payment</span>
                      </div>
                      <div className="intent-body">
                        <div className="intent-row">
                          <span className="intent-key">To</span>
                          <span
                            className="intent-val mono">{x402Payment?.payTo.slice(0, 8)}...{x402Payment?.payTo.slice(-6)}</span>
                        </div>
                        <div className="intent-row">
                          <span className="intent-key">Network</span>
                          <span className="intent-val mono">Base</span>
                        </div>
                        <div className="intent-row">
                          <span className="intent-key">Amount</span>
                          <span className="intent-val mono">{x402Payment?.amountDisplay}</span>
                        </div>
                      </div>
                      <div className="intent-actions">
                        <button className="btn btn-sm" onClick={() => handleX402Cancel()}>
                          Decline
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleX402Pay()}
                        >
                          Sign & Pay
                        </button>
                      </div>
                    </div>
                  )}


                  {/*<BTCDepositCard*/}
                  {/*  depositAddress={btcDepositInfo.depositAddress}*/}
                  {/*  amount={btcDepositInfo.amount}*/}
                  {/*  suiAddress={btcDepositInfo.suiAddress}*/}
                  {/*  fromAddress={btcWalletAddress || undefined}*/}
                  {/*  onConfirm={handleBTCDepositConfirm}*/}
                  {/*  onSignAndSend={btcWalletAddress ? handleBTCSignAndSend : undefined}*/}
                  {/*  confirming={confirmingBTC}*/}
                  {/*  signing={signingBTC}*/}
                  {/*  btcWalletConnected={!!btcWalletAddress}*/}
                  {/*/>*/}
                  {/* BTC Deposit Card - shown for messages with BTC_STAKE intent that has depositAddress */}
                  {/* This associates the card with the specific message that generated the deposit address */}


                  {msg.intent && msg.intent.type == 'STAKE_BTC' && (
                    <div className="intent-card fade-in">
                      <div className="intent-header">
                        <div className="intent-dots">
                          {[0, 1, 2].map(i => <span key={i} className="intent-dot"/>)}
                        </div>
                        <span className="intent-label">BTC Deposit</span>
                      </div>
                      <div className="intent-body">
                        <div className="intent-row">
                          <span className="intent-key">To</span>
                          <span className="intent-val mono">{msg.intent.depositAddress}</span>
                        </div>
                        <div className="intent-row">
                          <span className="intent-key">Amount</span>
                          <span className="intent-val mono">{msg.intent.amount} BTC</span>
                        </div>
                        <div className="intent-row">
                          <span className="intent-key">Receive Token</span>
                          <span className="intent-val mono">BTCvc (minted to vault)</span>
                        </div>
                      </div>
                      <div className="intent-actions">
                        <button className="btn btn-sm" onClick={() => handleBTCCancel()}>
                          Decline
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleBTCSignAndSend(btcDepositInfo)}
                          disabled={!btcWalletAddress || signingBTC}
                        >
                          {signingBTC ? 'Sending...' : 'Sign & Pay'}
                        </button>
                      </div>
                    </div>

                  )}


                  {/*/!* Intent approval card *!/*/}
                  {/*{msg.intent && msg.execStep === undefined && (*/}
                  {/*  <div className="intent-card fade-in">*/}
                  {/*    <div className="intent-header">*/}
                  {/*      <div className="intent-dots">*/}
                  {/*        {[0, 1, 2].map(i => <span key={i} className="intent-dot" />)}*/}
                  {/*      </div>*/}
                  {/*      <span className="intent-label">PAYMENT INTENT</span>*/}
                  {/*    </div>*/}
                  {/*    <div className="intent-body">*/}
                  {/*      <div className="intent-row">*/}
                  {/*        <span className="intent-key">Hire</span>*/}
                  {/*        <span className="intent-val">{msg.intent.humanName}</span>*/}
                  {/*      </div>*/}
                  {/*      <div className="intent-row">*/}
                  {/*        <span className="intent-key">Task</span>*/}
                  {/*        <span className="intent-val">{msg.intent.task}</span>*/}
                  {/*      </div>*/}
                  {/*      <div className="intent-row">*/}
                  {/*        <span className="intent-key">Amount</span>*/}
                  {/*        <span className="intent-val intent-amount">{msg.intent.amount} USDC</span>*/}
                  {/*      </div>*/}
                  {/*      <div className="intent-row">*/}
                  {/*        <span className="intent-key">To</span>*/}
                  {/*        <span className="intent-val mono">{truncAddr(msg.intent.recipient)}</span>*/}
                  {/*      </div>*/}
                  {/*      <div className="intent-row">*/}
                  {/*        <span className="intent-key">Expires</span>*/}
                  {/*        <span className="intent-val mono">{new Date(msg.intent.expiry * 1000).toLocaleTimeString()}</span>*/}
                  {/*      </div>*/}
                  {/*    </div>*/}
                  {/*    <div className="intent-actions">*/}
                  {/*      <button className="btn btn-sm" onClick={() => handleDecline(msg.id)}>*/}
                  {/*        Decline*/}
                  {/*      </button>*/}
                  {/*      <button*/}
                  {/*        className="btn btn-primary btn-sm"*/}
                  {/*        onClick={() => handleApprove(msg.id, msg.intent!)}*/}
                  {/*      >*/}
                  {/*        Sign & Pay*/}
                  {/*      </button>*/}
                  {/*    </div>*/}
                  {/*  </div>*/}
                  {/*)}*/}

                  {/* ZK Verification Log */}
                  {/*{msg.execStep !== undefined && (*/}
                  {/*  <div className="exec-log fade-in">*/}
                  {/*    <div className="exec-log-header">*/}
                  {/*      <div className="exec-log-dots">*/}
                  {/*        {[0, 1, 2].map(i => <span key={i} className="exec-log-dot" />)}*/}
                  {/*      </div>*/}
                  {/*      <span className="exec-log-label">EXECUTION LOG (PENDING)</span>*/}
                  {/*    </div>*/}
                  {/*    <div className="exec-log-body">*/}
                  {/*      {EXEC_STEPS.map((step, i) => (*/}
                  {/*        <div key={i} className={`exec-log-row ${*/}
                  {/*          i < msg.execStep! ? 'done' :*/}
                  {/*          i === msg.execStep! ? 'active' : 'pending'*/}
                  {/*        }`}>*/}
                  {/*          <div className="exec-log-indicator">*/}
                  {/*            {i < msg.execStep! ? (*/}
                  {/*              <span className="exec-log-check">&#10003;</span>*/}
                  {/*            ) : i === msg.execStep! ? (*/}
                  {/*              <span className="exec-log-spinner" />*/}
                  {/*            ) : (*/}
                  {/*              <span className="exec-log-circle" />*/}
                  {/*            )}*/}
                  {/*          </div>*/}
                  {/*          <div className="exec-log-info">*/}
                  {/*            <div className="exec-log-step-label">{step.label}</div>*/}
                  {/*            <div className="exec-log-step-desc">*/}
                  {/*              {i < msg.execStep! ? 'Completed' :*/}
                  {/*                i === msg.execStep! ? step.desc : 'Waiting...'}*/}
                  {/*            </div>*/}
                  {/*          </div>*/}
                  {/*        </div>*/}
                  {/*      ))}*/}
                  {/*    </div>*/}
                  {/*  </div>*/}
                  {/*)}*/}

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
                  "I want to stake 0.0001 BTC for BTCVC",
                  "What's my USDC balance?",
                  "What's the price of ETH?",
                  "Send 10 USDC to 0x...",
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
                placeholder="Stake BTC, check balances, or send tokens..."
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

      {/* BTC Wallet Connector Modal */}
      {showBTCConnector && (
        <BTCWalletConnector
          onConnect={handleBTCConnect}
          onCancel={handleBTCCancel}
          title="Connect BTC Wallet"
          description="Please connect your BTC wallet to complete the staking process. You will use this wallet to send BTC to the staking address."
        />
      )}


      {/* Footer */}
      <footer className="footer">
        <span className="footer-text">Verified Agent Execution Bundle</span>
        <div className="footer-links">
          <a href={activeChain.explorer} target="_blank" rel="noopener noreferrer">Explorer</a>
          <a href="https://github.com/vishwanetwork/VAEB" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
      </footer>

      {/* BTC Wallet Styles */}
      <style>{btcWalletStyles}</style>

      {/* X402 Payment Styles */}
      <style>{x402Styles}</style>
    </div>
  );
}
