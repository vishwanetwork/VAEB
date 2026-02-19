import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { CONFIG } from './config';
import { getProvider, getAgentSigner, getWalletContract, getUsdcContract } from './chain';

const router = Router();

// In-memory intent store
interface StoredIntent {
  nonce: string;
  expiry: number;
  calls: Array<{ target: string; value: bigint; data: string }>;
  callsHash: string;
  signerAddress: string;
  amount: string;
  token: string;
  recipient: string;
  createdAt: number;
}

const intentStore = new Map<string, StoredIntent>();

// ─── GET /api/health ─────────────────────────────────────────

router.get('/health', async (_req: Request, res: Response) => {
  try {
    const provider = getProvider();
    const network = await provider.getNetwork();
    res.json({
      status: 'ok',
      chain: 'base_sepolia',
      chainId: Number(network.chainId),
      agentWallet: CONFIG.contracts.AgentWallet,
      agent: getAgentSigner().address,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/balances/:address ──────────────────────────────

router.get('/balances/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!ethers.isAddress(address)) {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }

    const provider = getProvider();
    const usdc = getUsdcContract();

    const [userEth, userUsdc, agentEth, agentUsdc] = await Promise.all([
      provider.getBalance(address),
      usdc.balanceOf(address),
      provider.getBalance(CONFIG.contracts.AgentWallet),
      usdc.balanceOf(CONFIG.contracts.AgentWallet),
    ]);

    res.json({
      agentWallet: CONFIG.contracts.AgentWallet,
      user: {
        address,
        eth: ethers.formatEther(userEth),
        usdc: ethers.formatUnits(userUsdc, 6),
      },
      agent: {
        address: CONFIG.contracts.AgentWallet,
        eth: ethers.formatEther(agentEth),
        usdc: ethers.formatUnits(agentUsdc, 6),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/intent/review ─────────────────────────────────

router.post('/intent/review', async (req: Request, res: Response) => {
  try {
    const { actionType, token, amount, recipient, signerAddress } = req.body;

    // Validate inputs
    if (!actionType || !token || !amount || !recipient || !signerAddress) {
      res.status(400).json({ error: 'Missing required fields: actionType, token, amount, recipient, signerAddress' });
      return;
    }
    if (!ethers.isAddress(recipient)) {
      res.status(400).json({ error: 'Invalid recipient address' });
      return;
    }
    if (!ethers.isAddress(signerAddress)) {
      res.status(400).json({ error: 'Invalid signer address' });
      return;
    }

    const amountParsed = parseFloat(amount);
    if (isNaN(amountParsed) || amountParsed <= 0) {
      res.status(400).json({ error: 'Invalid amount' });
      return;
    }

    // Generate nonce (31 bytes to fit BN254 scalar field)
    const nonce = ethers.zeroPadValue(ethers.hexlify(ethers.randomBytes(31)), 32);
    const expiry = Math.floor(Date.now() / 1000) + 600; // 10 minutes

    // Build transfer calldata
    const amountWei = ethers.parseUnits(amount, 6); // USDC has 6 decimals
    const erc20Iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
    const transferCalldata = erc20Iface.encodeFunctionData('transfer', [recipient, amountWei]);

    const calls = [{ target: CONFIG.contracts.MockUSDC, value: 0n, data: transferCalldata }];

    // Compute callsHash (must match AgentWallet._hashCalls)
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const encodedCalls = coder.encode(
      ['tuple(address target, uint256 value, bytes data)[]'],
      [calls]
    );
    const callsHash = ethers.keccak256(encodedCalls);

    // Generate a review ID
    const reviewId = ethers.hexlify(ethers.randomBytes(16));

    // Store intent
    intentStore.set(reviewId, {
      nonce,
      expiry,
      calls,
      callsHash,
      signerAddress,
      amount,
      token,
      recipient,
      createdAt: Date.now(),
    });

    // Return EIP-712 typed data for MetaMask signing
    res.json({
      reviewId,
      action: actionType,
      token,
      amount,
      recipient,
      from: CONFIG.contracts.AgentWallet,
      nonce,
      expiry,
      expiryFormatted: new Date(expiry * 1000).toISOString(),
      eip712: {
        domain: {
          name: 'VAEB AgentWallet',
          version: '1',
          chainId: CONFIG.chainId,
          verifyingContract: CONFIG.contracts.AgentWallet,
        },
        types: {
          DirectExecution: [
            { name: 'nonce', type: 'bytes32' },
            { name: 'expiry', type: 'uint256' },
            { name: 'callsHash', type: 'bytes32' },
          ],
        },
        primaryType: 'DirectExecution',
        message: {
          nonce,
          expiry,
          callsHash,
        },
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/intent/execute ────────────────────────────────

router.post('/intent/execute', async (req: Request, res: Response) => {
  try {
    const { reviewId, signature } = req.body;

    if (!reviewId || !signature) {
      res.status(400).json({ error: 'Missing required fields: reviewId, signature' });
      return;
    }

    // Look up stored intent
    const intent = intentStore.get(reviewId);
    if (!intent) {
      res.status(404).json({ error: 'Intent not found. It may have expired.' });
      return;
    }

    // Check expiry
    if (Math.floor(Date.now() / 1000) > intent.expiry) {
      intentStore.delete(reviewId);
      res.status(400).json({ error: 'Intent has expired. Please create a new one.' });
      return;
    }

    // Get before-balance
    const usdc = getUsdcContract();
    const balanceBefore = await usdc.balanceOf(CONFIG.contracts.AgentWallet);

    // Execute on-chain via agent wallet
    const agentSigner = getAgentSigner();
    const walletContract = getWalletContract(agentSigner);

    const tx = await walletContract.executeDirectly(
      signature,
      intent.nonce,
      intent.expiry,
      intent.calls,
      { gasLimit: 300000 }
    );

    const receipt = await tx.wait();

    // Get after-balance
    const balanceAfter = await usdc.balanceOf(CONFIG.contracts.AgentWallet);

    // Clean up stored intent
    intentStore.delete(reviewId);

    res.json({
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      explorerUrl: `${CONFIG.explorer}/tx/${tx.hash}`,
      balanceBefore: ethers.formatUnits(balanceBefore, 6),
      balanceAfter: ethers.formatUnits(balanceAfter, 6),
    });
  } catch (err: any) {
    // Try to decode revert reason
    const revertData = err.data || err?.info?.error?.data;
    const knownErrors: Record<string, string> = {
      '0x09bde339': 'InvalidProof',
      '0x8baa579f': 'InvalidSignature — the wallet owner must sign the intent',
      '0x1fb09b80': 'NonceAlreadyUsed — this intent was already executed',
      '0x408b2234': 'IntentExpired — the intent has expired',
      '0x72cb8533': 'NotOwnerOrAgent — caller is not authorized',
    };

    let errorMsg = err.message;
    if (revertData && typeof revertData === 'string') {
      const selector = revertData.slice(0, 10);
      if (knownErrors[selector]) {
        errorMsg = knownErrors[selector];
      }
    }

    res.status(500).json({ error: errorMsg });
  }
});

export default router;
