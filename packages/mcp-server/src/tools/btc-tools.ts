/**
 * BTC Tools — Bitcoin staking to BTCVC on Sui via x402 payment protocol
 * 
 * This service requires x402 micropayment ($0.5 USDC on Base) to obtain
 * the BTC deposit address for staking.
 */

import { ethers } from "ethers";
import type { MCPConfig } from "../handlers";

// ─── Types ───────────────────────────────────────────────────

interface BTCPaymentIntent {
  id: string;
  amountBTC: string;
  amountSats: bigint;
  depositAddress?: string;
  suiAddress: string;
  status: "initialized" | "awaiting_payment" | "awaiting_deposit" | "deposit_received" | "completed" | "failed" | "expired";
  txHash?: string;
  bridgePaymentId?: string;
  x402Payment?: X402PaymentRequirement;
  createdAt: number;
  expiresAt: number;
  network: "mainnet" | "testnet";
}

interface TxData {
  status?: {
    confirmed?: boolean;
    block_height?: number;
  };
}

interface X402PaymentRequirement {
  version: number;
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: {
    name: string;
    version: string;
  };
}

// ─── In-memory store for BTC payment intents ─────────────────

const btcPaymentStore = new Map<string, BTCPaymentIntent>();

// ─── Constants ───────────────────────────────────────────────

const X402_BRIDGE_ENDPOINT = "https://mcp-x402.vishwanetwork.xyz/api/bridge/sui/btc2btcvc";
const BTC_TESTNET_API = "https://mempool.space/testnet/api";
const BTC_MAINNET_API = "https://mempool.space/api";

// USDC contract on Base
const USDC_CONTRACT_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// ─── Tool Handlers ───────────────────────────────────────────

export const btcTools = {
  async handle(
    name: string,
    args: any,
    config: MCPConfig
  ): Promise<{ result: any; intent?: any }> {
    switch (name) {
      case "init_btc_payment":
        return await handleInitBTCPayment(args, config);
      case "confirm_btc_transfer":
        return await handleConfirmBTCTransfer(args, config);
      case "get_btc_payment_status":
        return await handleGetBTCPaymentStatus(args, config);
      case "broadcast_btc_transaction":
        return await handleBroadcastBTCTransaction(args, config);
      case "request_btc_wallet":
        return await handleRequestBTCWallet(args, config);
      default:
        throw new Error(`Unknown BTC tool: ${name}`);
    }
  },
};

// ─── init_btc_payment ────────────────────────────────────────
// Step 1: Get x402 payment requirements and create intent

async function handleInitBTCPayment(
  args: { 
    amount_btc: string; 
    sui_address: string;
    network?: "mainnet" | "testnet";
    expiry_minutes?: number;
    payer_address?: string;
    payment_header?: string;
    intent_id?: string;
  },
  config: MCPConfig
): Promise<{ result: any; intent?: any }> {
  const { 
    amount_btc, 
    sui_address,
    network = "mainnet",
    expiry_minutes = 60,
    payer_address,
    payment_header,
    intent_id: existingIntentId 
  } = args;

  // Validate amount
  const amountNum = parseFloat(amount_btc);
  if (isNaN(amountNum) || amountNum <= 0) {
    return {
      result: {
        success: false,
        error: `Invalid BTC amount: ${amount_btc}`,
      },
    };
  }

  // Validate Sui address
  if (!sui_address || !sui_address.match(/^0x[a-fA-F0-9]{64}$/)) {
    return {
      result: {
        success: false,
        error: `Invalid Sui address format. Expected: 0x followed by 64 hex characters`,
      },
    };
  }

  // Convert BTC to satoshis
  const amountSats = BigInt(Math.floor(amountNum * 100000000));

  // Generate unique intent ID
  const intentId = ethers.hexlify(ethers.randomBytes(16));

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiry_minutes * 60;

  // If payment_header is provided, this is the second call after payment
  if (payment_header && existingIntentId) {
    const existingIntent = btcPaymentStore.get(existingIntentId);
    if (!existingIntent) {
      return {
        result: {
          success: false,
          error: "Payment intent not found or expired",
        },
      };
    }

    // Call the endpoint with payment header to get BTC deposit address
    try {
      console.log(`[BTC Bridge] Calling with payment header for intent: ${existingIntentId}`);
      
      const params = new URLSearchParams({
        suiAddress: sui_address,
        amount: amount_btc,
        network: network,
      });

      const response = await fetch(`${X402_BRIDGE_ENDPOINT}?${params}`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "X-PAYMENT": payment_header,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          result: {
            success: false,
            error: `Post-payment request failed: HTTP ${response.status}`,
            details: errorText,
          },
        };
      }

      const responseData = await response.json() as {
        wallet?: string;
        data?: { wallet?: string };
        paymentId?: string;
      };

      if (responseData.wallet || responseData.data?.wallet) {
        const depositAddress = responseData.wallet || responseData.data?.wallet;
        const paymentId = responseData.paymentId || existingIntentId;

        existingIntent.depositAddress = depositAddress;
        existingIntent.bridgePaymentId = paymentId;
        existingIntent.status = "awaiting_deposit";
        btcPaymentStore.set(existingIntentId, existingIntent);

        return {
          result: {
            success: true,
            intent_id: existingIntentId,
            bridge_payment_id: paymentId,
            deposit_address: depositAddress,
            amount_btc,
            amount_sats: existingIntent.amountSats.toString(),
            sui_address,
            network,
            status: "awaiting_deposit",
            expires_at: new Date(existingIntent.expiresAt * 1000).toISOString(),
            message: `Payment successful! BTC staking initialized. Please send ${amount_btc} BTC to deposit address: ${depositAddress}`,
            instructions: {
              step1: `Send ${amount_btc} BTC to: ${depositAddress}`,
              step2: "Wait for Bitcoin network confirmation",
              step3: "Provide the transaction hash to confirm",
            },
          },
          intent: {
            reviewId: existingIntentId,
            type: "BTC_STAKE",
            depositAddress: depositAddress,
            amount: amount_btc,
            suiAddress: sui_address,
            network,
            bridgePaymentId: paymentId,
            expiresAt: existingIntent.expiresAt,
            status: "awaiting_deposit",
          },
        };
      }

      return {
        result: {
          success: false,
          error: "No valid BTC address returned after payment",
          response: responseData,
        },
      };
    } catch (error: any) {
      return {
        result: {
          success: false,
          error: `Post-payment request failed: ${error.message}`,
        },
      };
    }
  }

  // Initialize intent
  const intent: BTCPaymentIntent = {
    id: intentId,
    amountBTC: amount_btc,
    amountSats,
    suiAddress: sui_address,
    status: "initialized",
    createdAt: now,
    expiresAt,
    network,
  };

  try {
    console.log(`[BTC Bridge] Getting x402 payment requirements from ${X402_BRIDGE_ENDPOINT}`);

    // Step 1: Call GET endpoint to get x402 payment requirements
    const params = new URLSearchParams({
      suiAddress: sui_address,
      amount: amount_btc,
      network: network,
    });

    const discoveryResponse = await fetch(`${X402_BRIDGE_ENDPOINT}?${params}`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    });

    console.log(`[BTC Bridge] Discovery response status: ${discoveryResponse.status}`);

    if (discoveryResponse.status === 402) {
      // Expected: x402 payment required
      const x402Headers = discoveryResponse.headers.get("X-PAYMENT-REQUIRED");
      const responseBody = await discoveryResponse.json() as {
        x402Version: number;
        accepts: Array<{
          scheme: string;
          network: string;
          maxAmountRequired: string;
          resource: string;
          description: string;
          mimeType: string;
          payTo: string;
          maxTimeoutSeconds: number;
          asset: string;
          extra: { name: string; version: string };
        }>;
      };
      
      console.log(`[BTC Bridge] x402 payment required:`, JSON.stringify(responseBody, null, 2));

      if (responseBody.x402Version === 1 && responseBody.accepts) {
        const requirement = responseBody.accepts[0];
        
        intent.x402Payment = {
          version: responseBody.x402Version,
          scheme: requirement.scheme,
          network: requirement.network,
          maxAmountRequired: requirement.maxAmountRequired,
          resource: requirement.resource,
          description: requirement.description,
          mimeType: requirement.mimeType,
          payTo: requirement.payTo,
          maxTimeoutSeconds: requirement.maxTimeoutSeconds,
          asset: requirement.asset,
          extra: requirement.extra,
        };
        intent.status = "awaiting_payment";
        btcPaymentStore.set(intentId, intent);

        // Format price for display (500000 = $0.5)
        const priceInDollars = (parseInt(requirement.maxAmountRequired) / 1000000).toFixed(2);

        return {
          result: {
            success: true,
            requiresPayment: true,
            intent_id: intentId,
            amount_btc,
            amount_sats: amountSats.toString(),
            sui_address,
            network,
            status: "awaiting_payment",
            expires_at: new Date(expiresAt * 1000).toISOString(),
            payment: {
              amount: requirement.maxAmountRequired,
              amount_display: `$${priceInDollars}`,
              asset: requirement.asset === USDC_CONTRACT_BASE ? "USDC" : requirement.asset,
              network: requirement.network,
              description: requirement.description,
              pay_to: requirement.payTo,
              max_timeout_seconds: requirement.maxTimeoutSeconds,
            },
            message: `Initializing BTC staking service... The payment UI will appear automatically.`,
            ui_ready: true,
            auto_trigger: true,
          },
          intent: {
            reviewId: intentId,
            type: "BTC_STAKE_PAYMENT_REQUIRED",
            amount: amount_btc,
            suiAddress: sui_address,
            network,
            requiresPayment: true,
            paymentAmount: requirement.maxAmountRequired,
            paymentAsset: requirement.asset,
            payTo: requirement.payTo,
            expiresAt,
            status: "awaiting_payment",
          },
        };
      }

      return {
        result: {
          success: false,
          error: "Unable to parse x402 payment requirements",
          response: responseBody,
        },
      };
    }

    // If not 402, check if it's a successful response with wallet address
    if (discoveryResponse.ok) {
      const responseData = await discoveryResponse.json() as {
        wallet?: string;
        data?: { wallet?: string };
        paymentId?: string;
      };
      
      if (responseData.wallet || responseData.data?.wallet) {
        const depositAddress = responseData.wallet || responseData.data?.wallet;
        const paymentId = responseData.paymentId || intentId;

        intent.depositAddress = depositAddress;
        intent.bridgePaymentId = paymentId;
        intent.status = "awaiting_deposit";
        btcPaymentStore.set(intentId, intent);

        return {
          result: {
            success: true,
            intent_id: intentId,
            bridge_payment_id: paymentId,
            deposit_address: depositAddress,
            amount_btc,
            amount_sats: amountSats.toString(),
            sui_address,
            network,
            status: "awaiting_deposit",
            expires_at: new Date(expiresAt * 1000).toISOString(),
            message: `BTC staking address generated. The deposit UI will appear automatically.`,
            ui_ready: true,
            auto_trigger: true,
          },
          intent: {
            reviewId: intentId,
            type: "BTC_STAKE",
            depositAddress: depositAddress,
            amount: amount_btc,
            suiAddress: sui_address,
            network,
            bridgePaymentId: paymentId,
            expiresAt,
            status: "awaiting_deposit",
          },
        };
      }
    }

    // Unexpected response
    const errorText = await discoveryResponse.text();
    return {
      result: {
        success: false,
        error: `Bridge service returned unexpected response: HTTP ${discoveryResponse.status}`,
        details: errorText,
      },
    };

  } catch (error: any) {
    console.error(`[BTC Bridge] Error:`, error);
    return {
      result: {
        success: false,
        error: `Failed to call bridge service: ${error.message}`,
        stack: error.stack,
      },
    };
  }
}

// ─── confirm_btc_transfer ────────────────────────────────────

async function handleConfirmBTCTransfer(
  args: { 
    intent_id: string; 
    tx_hash?: string;
    signed_tx?: string;
  },
  config: MCPConfig
): Promise<{ result: any }> {
  const { intent_id, tx_hash, signed_tx } = args;

  const intent = btcPaymentStore.get(intent_id);
  if (!intent) {
    return {
      result: {
        success: false,
        error: `BTC payment intent not found: ${intent_id}`,
      },
    };
  }

  if (Math.floor(Date.now() / 1000) > intent.expiresAt) {
    intent.status = "expired";
    btcPaymentStore.set(intent_id, intent);
    return {
      result: {
        success: false,
        error: "Payment intent expired",
        expired_at: new Date(intent.expiresAt * 1000).toISOString(),
      },
    };
  }

  if (intent.status !== "awaiting_deposit") {
    return {
      result: {
        success: false,
        error: `Invalid status: ${intent.status}. Expected: awaiting_deposit`,
      },
    };
  }

  if (tx_hash) {
    try {
      const apiBase = intent.network === "mainnet" ? BTC_MAINNET_API : BTC_TESTNET_API;
      
      const txResponse = await fetch(`${apiBase}/tx/${tx_hash}`);
      
      if (!txResponse.ok) {
        return {
          result: {
            success: false,
            error: `Transaction not found: ${tx_hash}. Please verify the transaction hash and try again.`,
          },
        };
      }

      const txData = await txResponse.json() as TxData;
      
      intent.txHash = tx_hash;
      intent.status = "deposit_received";
      btcPaymentStore.set(intent_id, intent);

      const confirmationStatus = txData.status?.confirmed 
        ? (txData.status.block_height ? "confirmed" : "pending")
        : "pending";

      return {
        result: {
          success: true,
          intent_id,
          tx_hash,
          confirmations: confirmationStatus,
          deposit_address: intent.depositAddress,
          amount_btc: intent.amountBTC,
          network: intent.network,
          status: "deposit_received",
          explorer_url: `${apiBase}/tx/${tx_hash}`,
          message: `Transaction confirmed. BTCVC will be minted to Sui address: ${intent.suiAddress}`,
          next_steps: `The backend will automatically process BTCVC distribution`,
        },
      };
    } catch (error: any) {
      return {
        result: {
          success: false,
          error: `Failed to confirm transfer: ${error.message}`,
        },
      };
    }
  }

  if (signed_tx) {
    return handleBroadcastBTCTransaction({ 
      intent_id, 
      signed_tx, 
      network: intent.network 
    }, config);
  }

  return {
    result: {
      success: true,
      intent_id,
      status: intent.status,
      deposit_address: intent.depositAddress,
      amount_btc: intent.amountBTC,
      message: "Awaiting BTC deposit. Please send BTC to the staking address and provide the transaction hash.",
      instructions: {
        step1: `Send ${intent.amountBTC} BTC to: ${intent.depositAddress}`,
        step2: "Wait for network confirmation",
        step3: `Call confirm_btc_transfer with tx_hash`,
      },
    },
  };
}

// ─── broadcast_btc_transaction ───────────────────────────────

async function handleBroadcastBTCTransaction(
  args: { 
    intent_id: string; 
    signed_tx?: string; 
    network?: "mainnet" | "testnet";
    tx_hash?: string;
  },
  config: MCPConfig
): Promise<{ result: any }> {
  const { intent_id, signed_tx, network = "testnet", tx_hash } = args;

  const intent = btcPaymentStore.get(intent_id);
  
  if (!intent && tx_hash) {
    try {
      const apiBase = network === "mainnet" ? BTC_MAINNET_API : BTC_TESTNET_API;
      const txResponse = await fetch(`${apiBase}/tx/${tx_hash}`);
      
      if (!txResponse.ok) {
        return {
          result: {
            success: false,
            error: `Transaction not found on ${network}: ${tx_hash}`,
          },
        };
      }

      const txData = await txResponse.json() as TxData;
      
      return {
        result: {
          success: true,
          tx_hash,
          network,
          status: txData.status?.confirmed ? "confirmed" : "pending",
          confirmations: txData.status?.block_height || 0,
          explorer_url: `${apiBase}/tx/${tx_hash}`,
        },
      };
    } catch (error: any) {
      return {
        result: {
          success: false,
          error: `Failed to verify transaction: ${error.message}`,
        },
      };
    }
  }

  if (!intent) {
    return {
      result: {
        success: false,
        error: `BTC payment intent not found: ${intent_id}`,
      },
    };
  }

  if (signed_tx) {
    // Status remains awaiting_deposit until broadcast completes
    btcPaymentStore.set(intent_id, intent);

    try {
      const apiBase = intent.network === "mainnet" ? BTC_MAINNET_API : BTC_TESTNET_API;
      
      const broadcastResponse = await fetch(`${apiBase}/tx`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: signed_tx,
      });

      if (!broadcastResponse.ok) {
        const errorText = await broadcastResponse.text();
        intent.status = "failed";
        btcPaymentStore.set(intent_id, intent);
        return {
          result: {
            success: false,
            error: `Broadcast failed: ${errorText}`,
          },
        };
      }

      const broadcastTxHash = await broadcastResponse.text();
      intent.txHash = broadcastTxHash;
      intent.status = "deposit_received";
      btcPaymentStore.set(intent_id, intent);

      return {
        result: {
          success: true,
          intent_id,
          tx_hash: broadcastTxHash,
          network: intent.network,
          status: "broadcasted",
          explorer_url: `${apiBase}/tx/${broadcastTxHash}`,
          message: "Transaction broadcast successful.",
        },
      };
    } catch (error: any) {
      intent.status = "failed";
      btcPaymentStore.set(intent_id, intent);
      return {
        result: {
          success: false,
          error: `Broadcast failed: ${error.message}`,
        },
      };
    }
  }

  return {
    result: {
      success: true,
      intent_id,
      status: intent.status,
      tx_hash: intent.txHash,
      deposit_address: intent.depositAddress,
    },
  };
}

// ─── get_btc_payment_status ──────────────────────────────────

async function handleGetBTCPaymentStatus(
  args: { intent_id: string },
  _config: MCPConfig
): Promise<{ result: any }> {
  const { intent_id } = args;

  const intent = btcPaymentStore.get(intent_id);
  if (!intent) {
    return {
      result: {
        success: false,
        error: `BTC payment intent not found: ${intent_id}`,
      },
    };
  }

  const isExpired = Math.floor(Date.now() / 1000) > intent.expiresAt;
  const apiBase = intent.network === "mainnet" ? BTC_MAINNET_API : BTC_TESTNET_API;

  let blockchainStatus: { confirmed: boolean; confirmations: number; explorer_url: string } | null = null;
  if (intent.txHash) {
    try {
      const txResponse = await fetch(`${apiBase}/tx/${intent.txHash}`);
      if (txResponse.ok) {
        const txData = await txResponse.json() as TxData;
        blockchainStatus = {
          confirmed: txData.status?.confirmed || false,
          confirmations: txData.status?.block_height || 0,
          explorer_url: `${apiBase}/tx/${intent.txHash}`,
        };
      }
    } catch {
      // Ignore fetch errors
    }
  }

  return {
    result: {
      success: true,
      intent_id,
      status: intent.status,
      is_expired: isExpired,
      deposit_address: intent.depositAddress,
      sui_address: intent.suiAddress,
      amount_btc: intent.amountBTC,
      amount_sats: intent.amountSats.toString(),
      tx_hash: intent.txHash,
      bridge_payment_id: intent.bridgePaymentId,
      network: intent.network,
      created_at: new Date(intent.createdAt * 1000).toISOString(),
      expires_at: new Date(intent.expiresAt * 1000).toISOString(),
      blockchain_status: blockchainStatus,
      x402_payment: intent.x402Payment,
    },
  };
}

// ─── request_btc_wallet ─────────────────────────────────────

async function handleRequestBTCWallet(
  args: { 
    reason?: string;
    sui_address?: string;
  },
  _config: MCPConfig
): Promise<{ result: any; intent?: any }> {
  const { reason = "BTC staking", sui_address } = args;

  return {
    result: {
      success: true,
      action: "request_btc_wallet_connection",
      reason,
      sui_address,
      message: `Please connect your BTC wallet for ${reason}.`,
      instructions: {
        step1: "Click the 'Connect BTC Wallet' button",
        step2: "Select your BTC wallet (Xverse, Unisat, or Leather) in the popup",
        step3: "Authorize the connection to continue",
      },
    },
    intent: {
      type: "REQUEST_BTC_WALLET",
      reason,
      suiAddress: sui_address,
      requiresBTCWallet: true,
    },
  };
}

// ─── Helper Functions ────────────────────────────────────────

function isValidBTCAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  
  if (address.match(/^(1|3)[a-zA-HJ-NP-Z0-9]{25,34}$/)) return true;
  if (address.match(/^bc1[a-z0-9]{39,59}$/i)) return true;
  if (address.match(/^(m|n|2)[a-zA-HJ-NP-Z0-9]{25,34}$/)) return true;
  if (address.match(/^tb1[a-z0-9]{39,59}$/i)) return true;
  
  return false;
}

// Export store for external access
export { btcPaymentStore };
