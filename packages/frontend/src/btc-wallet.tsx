/**
 * BTC Wallet Integration for VAEB Frontend
 *
 * Supports multiple BTC wallets:
 * - MetaMask BTC
 * - Xverse
 * - Unisat
 * - Leather (Hiro)
 */

import { useState, useCallback } from 'react';

export type BTCWalletType = 'metamask' | 'xverse' | 'unisat' | 'leather' | null;

export interface BTCWalletInfo {
  address: string;
  type: string;
  connected: boolean;
  publicKey?: string;
}

interface BTCWalletProvider {
  name: string;
  icon: string;
  check: () => boolean;
  connect: () => Promise<string>;
  signMessage?: (message: string) => Promise<string>;
  sendBitcoin?: (toAddress: string, amountInSatoshi: number) => Promise<string>;
}

// ─── Global State for Cross-Component Sharing ───────────────

let globalWalletType: BTCWalletType = null;
let globalWalletAddress: string | null = null;

export function setGlobalBTCWallet(type: BTCWalletType, address: string | null) {
  globalWalletType = type;
  globalWalletAddress = address;
  console.log('[BTC Wallet] Global state updated:', { type, address });
}

export function getGlobalBTCWallet() {
  return { type: globalWalletType, address: globalWalletAddress };
}

export async function sendBitcoinGlobal(toAddress: string, amountInSatoshi: number): Promise<string> {
  console.log('[BTC Wallet] sendBitcoinGlobal called:', { toAddress, amountInSatoshi, globalWalletType });
  
  if (!globalWalletType) {
    throw new Error('No BTC wallet connected');
  }
  
  // Check for dust limit (typically 546 satoshis)
  const DUST_LIMIT = 546;
  if (amountInSatoshi < DUST_LIMIT) {
    throw new Error(`Amount too small (${amountInSatoshi} satoshis). Minimum is ${DUST_LIMIT} satoshis (0.00000546 BTC) to avoid dust limit.`);
  }
  
  const provider = WALLET_PROVIDERS[globalWalletType];
  if (!provider || !provider.sendBitcoin) {
    throw new Error(`${provider?.name || 'Wallet'} does not support sending Bitcoin`);
  }

  try {
    const txid = await provider.sendBitcoin(toAddress, amountInSatoshi);
    return txid;
  } catch (err: any) {
    throw new Error(`Failed to send Bitcoin: ${err.message}`);
  }
}

// ─── Wallet Provider Detection ───────────────────────────────

const WALLET_PROVIDERS: Record<string, BTCWalletProvider> = {
  // metamask: {
  //   name: 'MetaMask BTC',
  //   icon: '🦊',
  //   check: () => {
  //     const eth = (window as any).ethereum;
  //     return eth?.isMetaMask === true;
  //   },
  //   connect: async () => {
  //     const eth = (window as any).ethereum;
  //     if (!eth) throw new Error('MetaMask not installed');
  //     // For MetaMask, we use the same address as EVM
  //     const accounts = await eth.request({ method: 'eth_requestAccounts' });
  //     // Note: MetaMask BTC support is still limited, this is a placeholder
  //     return accounts[0];
  //   },
  // },
  xverse: {
    name: 'Xverse',
    icon: '🔵',
    check: () => typeof (window as any).XverseProviders !== 'undefined',
    connect: async () => {
      const xverse = (window as any).XverseProviders?.BitcoinProvider;
      if (!xverse) throw new Error('Xverse not installed');
      const response = await xverse.request('wallet_connect', null);
      return response.address;
    },
    sendBitcoin: async (toAddress: string, amountInSatoshi: number) => {
      const xverse = (window as any).XverseProviders?.BitcoinProvider;
      if (!xverse) throw new Error('Xverse not installed');
      const response = await xverse.request('sendTransfer', {
        recipients: [{
          address: toAddress,
          amount: amountInSatoshi
        }]
      });
      return response.txid;
    },
  },
  unisat: {
    name: 'Unisat',
    icon: '🟠',
    check: () => typeof (window as any).unisat !== 'undefined',
    connect: async () => {
      const unisat = (window as any).unisat;
      if (!unisat) throw new Error('Unisat not installed');
      const accounts = await unisat.requestAccounts();
      return accounts[0];
    },
    sendBitcoin: async (toAddress: string, amountInSatoshi: number) => {
      const unisat = (window as any).unisat;
      if (!unisat) throw new Error('Unisat not installed');
      const txid = await unisat.sendBitcoin(toAddress, amountInSatoshi);
      return txid;
    },
  },
  // leather: {
  //   name: 'Leather (Hiro)',
  //   icon: '⚫',
  //   check: () => typeof (window as any).LeatherProvider !== 'undefined',
  //   connect: async () => {
  //     const leather = (window as any).LeatherProvider;
  //     if (!leather) throw new Error('Leather not installed');
  //     const response = await leather.authenticationRequest('Connect to VAEB');
  //     return response.addresses[0].address;
  //   },
  // },
};

// ─── Hook ────────────────────────────────────────────────────

export function useBTCWallet() {
  const [connected, setConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [walletType, setWalletType] = useState<BTCWalletType>(null);
  const [error, setError] = useState<string | null>(null);

  const getAvailableWallets = useCallback(() => {
    return Object.entries(WALLET_PROVIDERS)
      .filter(([_, provider]) => provider.check())
      .map(([key, provider]) => ({ key: key as BTCWalletType, ...provider }));
  }, []);

  const connect = useCallback(async (type: BTCWalletType) => {
    if (!type) return;

    setError(null);
    const provider = WALLET_PROVIDERS[type];

    if (!provider) {
      setError(`Unknown wallet type: ${type}`);
      return;
    }

    if (!provider.check()) {
      setError(`${provider.name} not detected. Please install the extension.`);
      return;
    }

    try {
      const addr = await provider.connect();
      setAddress(addr);
      setWalletType(type);
      setConnected(true);
      // Set global state for cross-component access
      setGlobalBTCWallet(type, addr);
      return addr;
    } catch (err: any) {
      setError(err.message || 'Failed to connect BTC wallet');
      throw err;
    }
  }, []);

  const disconnect = useCallback(() => {
    setConnected(false);
    setAddress(null);
    setWalletType(null);
    setError(null);
    setGlobalBTCWallet(null, null);
  }, []);

  const sendBitcoin = useCallback(async (toAddress: string, amountInSatoshi: number) => {
    if (!walletType) {
      throw new Error('No BTC wallet connected');
    }
    
    const provider = WALLET_PROVIDERS[walletType];
    if (!provider || !provider.sendBitcoin) {
      throw new Error(`${provider?.name || 'Wallet'} does not support sending Bitcoin`);
    }

    try {
      const txid = await provider.sendBitcoin(toAddress, amountInSatoshi);
      return txid;
    } catch (err: any) {
      throw new Error(`Failed to send Bitcoin: ${err.message}`);
    }
  }, [walletType]);

  return {
    connected,
    address,
    walletType,
    error,
    connect,
    disconnect,
    sendBitcoin,
    getAvailableWallets,
  };
}

// ─── Component ───────────────────────────────────────────────

interface BTCWalletConnectorProps {
  onConnect: (address: string, walletType: string) => void;
  onCancel: () => void;
  title?: string;
  description?: string;
}

export function BTCWalletConnector({
  onConnect,
  onCancel,
  title = "Connect BTC Wallet",
  description = "Select a wallet to connect your Bitcoin address for staking"
}: BTCWalletConnectorProps) {
  const { connect, getAvailableWallets, error } = useBTCWallet();
  const [connecting, setConnecting] = useState(false);
  const availableWallets = getAvailableWallets();

  const handleConnect = async (walletKey: BTCWalletType) => {
    if (!walletKey) return;
    setConnecting(true);
    try {
      const address = await connect(walletKey);
      if (address) {
        onConnect(address, walletKey);
      }
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="btc-wallet-modal">
      <div className="btc-wallet-content">
        <h3>{title}</h3>
        <p className="btc-wallet-desc">{description}</p>

        {error && (
          <div className="btc-wallet-error">
            {error}
          </div>
        )}

        <div className="btc-wallet-list">
          {availableWallets.length === 0 ? (
            <div className="btc-wallet-empty">
              <p>No BTC wallet extensions detected.</p>
              <p className="btc-wallet-hint">
                Please install one of: Xverse, Unisat, or Leather
              </p>
            </div>
          ) : (
            availableWallets.map((wallet) => (
              <button
                key={wallet.key}
                className="btc-wallet-option"
                onClick={() => handleConnect(wallet.key)}
                disabled={connecting}
              >
                <span className="btc-wallet-icon">{wallet.icon}</span>
                <span className="btc-wallet-name">{wallet.name}</span>
                <span className="btc-wallet-arrow">→</span>
              </button>
            ))
          )}
        </div>

        <button
          className="btc-wallet-cancel"
          onClick={onCancel}
          disabled={connecting}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── CSS Styles (to be added to App.css) ─────────────────────

export const btcWalletStyles = `
.btc-wallet-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.btc-wallet-content {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 12px;
  padding: 24px;
  max-width: 400px;
  width: 90%;
}

.btc-wallet-content h3 {
  margin: 0 0 8px 0;
  color: #fff;
  font-size: 18px;
}

.btc-wallet-desc {
  color: #888;
  margin: 0 0 20px 0;
  font-size: 14px;
}

.btc-wallet-error {
  background: rgba(255, 107, 107, 0.1);
  border: 1px solid #ff6b6b;
  color: #ff6b6b;
  padding: 12px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 13px;
}

.btc-wallet-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.btc-wallet-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: #0a0a0a;
  border: 1px solid #333;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  color: #fff;
  font-size: 14px;
}

.btc-wallet-option:hover {
  background: #1f1f1f;
  border-color: #555;
}

.btc-wallet-option:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btc-wallet-icon {
  font-size: 20px;
}

.btc-wallet-name {
  flex: 1;
  text-align: left;
}

.btc-wallet-arrow {
  color: #666;
}

.btc-wallet-empty {
  text-align: center;
  padding: 24px;
  color: #666;
}

.btc-wallet-hint {
  font-size: 12px;
  color: #888;
  margin-top: 8px;
}

.btc-wallet-cancel {
  width: 100%;
  padding: 12px;
  background: transparent;
  border: 1px solid #333;
  border-radius: 8px;
  color: #888;
  cursor: pointer;
  transition: all 0.2s;
}

.btc-wallet-cancel:hover {
  border-color: #555;
  color: #fff;
}
`;
