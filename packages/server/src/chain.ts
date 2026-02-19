import { ethers } from 'ethers';
import { CONFIG } from './config';

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

let provider: ethers.JsonRpcProvider;
let agentSigner: ethers.Wallet;

export function getProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  }
  return provider;
}

export function getAgentSigner(): ethers.Wallet {
  if (!agentSigner) {
    agentSigner = new ethers.Wallet(CONFIG.agentPrivateKey, getProvider());
  }
  return agentSigner;
}

export function getWalletContract(signerOrProvider?: ethers.Signer | ethers.Provider): ethers.Contract {
  return new ethers.Contract(
    CONFIG.contracts.AgentWallet,
    WALLET_ABI,
    signerOrProvider || getProvider()
  );
}

export function getUsdcContract(signerOrProvider?: ethers.Signer | ethers.Provider): ethers.Contract {
  return new ethers.Contract(
    CONFIG.contracts.MockUSDC,
    ERC20_ABI,
    signerOrProvider || getProvider()
  );
}
