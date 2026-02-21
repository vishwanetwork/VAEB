import { ethers } from 'ethers';
import { CONFIG, type ChainConfig } from './config';

const WALLET_ABI = [
  'function owner() view returns (address)',
  'function agent() view returns (address)',
  'function domainSeparator() view returns (bytes32)',
  'function isNonceUsed(bytes32 nonce) view returns (bool)',
  'function executeDirectly(bytes signature, bytes32 nonce, uint256 expiry, tuple(address target, uint256 value, bytes data)[] calls)',
  'function executeWithProof(bytes proof, bytes signature, tuple(bytes32 commitment, uint256 chainId, address signerAddress, bytes32 multicallDataHash, bytes32 nonce, uint256 expiry) publicInputs, tuple(address target, uint256 value, bytes data)[] calls)',
  'event IntentExecuted(bytes32 indexed intentId, address indexed signer, bytes32 nonce, uint256 callCount, uint256 gasUsed)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

// Cache providers and signers by RPC URL
const providerCache = new Map<string, ethers.JsonRpcProvider>();
const signerCache = new Map<string, ethers.Wallet>();

export function getProvider(rpcUrl?: string): ethers.JsonRpcProvider {
  const url = rpcUrl || CONFIG.rpcUrl;
  if (!providerCache.has(url)) {
    providerCache.set(url, new ethers.JsonRpcProvider(url));
  }
  return providerCache.get(url)!;
}

export function getAgentSigner(rpcUrl?: string): ethers.Wallet {
  const url = rpcUrl || CONFIG.rpcUrl;
  if (!signerCache.has(url)) {
    signerCache.set(url, new ethers.Wallet(CONFIG.agentPrivateKey, getProvider(url)));
  }
  return signerCache.get(url)!;
}

export function getWalletContract(signerOrProvider?: ethers.Signer | ethers.Provider, contractAddress?: string): ethers.Contract {
  return new ethers.Contract(
    contractAddress || CONFIG.contracts.AgentWallet,
    WALLET_ABI,
    signerOrProvider || getProvider()
  );
}

export function getUsdcContract(signerOrProvider?: ethers.Signer | ethers.Provider, contractAddress?: string): ethers.Contract {
  return new ethers.Contract(
    contractAddress || CONFIG.contracts.MockUSDC,
    ERC20_ABI,
    signerOrProvider || getProvider()
  );
}

// ─── Chain-aware helpers ─────────────────────────────────────

export function getProviderForChain(chain: ChainConfig): ethers.JsonRpcProvider {
  return getProvider(chain.rpcUrl);
}

export function getAgentSignerForChain(chain: ChainConfig): ethers.Wallet {
  return getAgentSigner(chain.rpcUrl);
}

export function getWalletContractForChain(chain: ChainConfig, signerOrProvider?: ethers.Signer | ethers.Provider): ethers.Contract {
  return getWalletContract(signerOrProvider || getProviderForChain(chain), chain.contracts.AgentWallet);
}

export function getUsdcContractForChain(chain: ChainConfig, signerOrProvider?: ethers.Signer | ethers.Provider): ethers.Contract {
  return getUsdcContract(signerOrProvider || getProviderForChain(chain), chain.contracts.MockUSDC);
}
