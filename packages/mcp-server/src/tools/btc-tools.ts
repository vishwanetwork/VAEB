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
const X402_CUSTODY_ENDPOINT = "https://mcp-x402.vishwanetwork.xyz/api/custody/btc/btc2btcvc";
const BTC_TESTNET_API = "https://mempool.space/testnet/api";
const BTC_MAINNET_API = "https://mempool.space/api";

// Timeout for external HTTP calls (bridge, mempool)
const FETCH_TIMEOUT_MS = 30_000;

/** fetch with AbortController timeout */
function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

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
      // case "init_btc_payment":
      //   return await handleInitBTCPayment(args, config);
      case "confirm_btc_transfer":
        return await handleConfirmBTCTransfer(args, config);
      case "get_btc_payment_status":
        return await handleGetBTCPaymentStatus(args, config);
      case "broadcast_btc_transaction":
        return await handleBroadcastBTCTransaction(args, config);
      case "connect_btc_wallet":
        return await handleConnectBTCWallet(args, config);
      case "send_btc_transfer":
        return await handleSendBTCTransfer(args, config);
      case "prepare_stake_btc":
        return await handlePrepareStakeBTC(args, config);
      case "apply_add_custody_address":
        return await handleApplyAddCustodyAddress(args, config);
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

      const response = await fetchWithTimeout(`${X402_BRIDGE_ENDPOINT}`, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "X-PAYMENT": payment_header,
        },
        body: JSON.stringify({
          amount: amount_btc,
          network: network,
        }),
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
            network,
            status: "awaiting_deposit",
            expires_at: new Date(existingIntent.expiresAt * 1000).toISOString(),
            message: `Payment successful! BTC staking initialized. Please send ${amount_btc} BTC to deposit address: ${depositAddress}`,
            instructions: {
              step1: `Send ${amount_btc} BTC to: ${depositAddress}`,
              step2: "Wait for Bitcoin network confirmation",
              step3: "Waiting for the mint of the token",
            },
          },
          intent: {
            reviewId: existingIntentId,
            type: "BTC_STAKE",
            depositAddress: depositAddress,
            amount: amount_btc,
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
    status: "initialized",
    createdAt: now,
    expiresAt,
    network,
  };

  try {
    console.log(`[BTC Bridge] Getting x402 payment requirements from ${X402_BRIDGE_ENDPOINT}`);

    // Step 1: Call POST endpoint to get x402 payment requirements
    const discoveryResponse = await fetchWithTimeout(`${X402_BRIDGE_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amount_btc,
        network: network,
      }),
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

      const txResponse = await fetchWithTimeout(`${apiBase}/tx/${tx_hash}`);

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
          message: `Transaction confirmed. BTCVC will be minted to the designated address.`,

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
      const txResponse = await fetchWithTimeout(`${apiBase}/tx/${tx_hash}`);

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

      const broadcastResponse = await fetchWithTimeout(`${apiBase}/tx`, {
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
      const txResponse = await fetchWithTimeout(`${apiBase}/tx/${intent.txHash}`);
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

// ─── Helper Functions ────────────────────────────────────────

function isValidBTCAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;

  if (address.match(/^(1|3)[a-zA-HJ-NP-Z0-9]{25,34}$/)) return true;
  if (address.match(/^bc1[a-z0-9]{39,59}$/i)) return true;
  if (address.match(/^(m|n|2)[a-zA-HJ-NP-Z0-9]{25,34}$/)) return true;
  if (address.match(/^tb1[a-z0-9]{39,59}$/i)) return true;

  return false;
}

// ─── In-memory store for custody address intents ─────────────

interface CustodyAddressIntent {
  id: string;
  btcAddress: string;
  network: "mainnet" | "testnet";
  status: "initialized" | "awaiting_payment" | "payment_completed" | "completed" | "failed";
  x402Payment?: X402PaymentRequirement;
  createdAt: number;
  expiresAt: number;
  paymentHeader?: string;
}

const custodyAddressStore = new Map<string, CustodyAddressIntent>();

// ─── apply_add_custody_address ────────────────────────────────
// Add BTC custody address and mint BTCvc via x402 payment

async function handleApplyAddCustodyAddress(
  args: {
    btc_address?: string;
    network?: "mainnet" | "testnet";
    expiry_minutes?: number;
    payment_header?: string;
    intent_id?: string;
  },
  config: MCPConfig
): Promise<{ result: any; intent?: any }> {
  return {
    result: {
      success: true,
    },
    intent: {
      intent_id: 'apply_add_custody_address',
    },
  };
}

// ─── connect_btc_wallet ─────────────────────────────────────
// Step 1: Connect BTC wallet and return address

async function handleConnectBTCWallet(
  args: {
    wallet_type?: "xverse" | "unisat" | "leather";
    reason?: string;
  },
  _config: MCPConfig
): Promise<{ result: any; intent?: any }> {
  const { wallet_type, reason = "BTC operations" } = args;

  return {
    result: {
      success: true,
      action: "connect_btc_wallet",
      wallet_type: wallet_type || "any",
      reason,
      message: `Please connect your BTC wallet to continue with ${reason}.`,
      supported_wallets: ["Xverse", "Unisat", "Leather"],
      instructions: {
        step1: wallet_type
          ? `Select the ${wallet_type} wallet option`
          : "Select your preferred BTC wallet from the popup",
        step2: "Authorize the connection",
        step3: "Your wallet address will be returned for verification",
      },
    },
    intent: {
      type: "CONNECT_BTC_WALLET",
      walletType: wallet_type || "any",
      reason,
      requiresBTCWallet: true,
      requiresConnection: true,
    },
  };
}

// ─── send_btc_transfer ──────────────────────────────────────
// Step 2: Send BTC to a specified address (requires connected wallet)

async function handleSendBTCTransfer(
  args: {
    to_address: string;
    amount_btc: string;
    from_address?: string;
    wallet_type?: string;
    memo?: string;
    network?: "mainnet" | "testnet";
  },
  _config: MCPConfig
): Promise<{ result: any; intent?: any }> {
  const {
    to_address,
    amount_btc,
    from_address,
    wallet_type,
    memo,
    network = "testnet",
  } = args;

  // Validate BTC address
  if (!isValidBTCAddress(to_address)) {
    return {
      result: {
        success: false,
        error: `Invalid BTC address: ${to_address}`,
      },
    };
  }

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

  // Convert to satoshis
  const amountSats = BigInt(Math.floor(amountNum * 100000000));

  // Check dust limit (typically 546 satoshis)
  const DUST_LIMIT = 546;
  if (amountSats < BigInt(DUST_LIMIT)) {
    return {
      result: {
        success: false,
        error: `Amount too small (${amountSats} satoshis). Minimum is ${DUST_LIMIT} satoshis (0.00000546 BTC).`,
      },
    };
  }

  return {
    result: {
      success: true,
      action: "send_btc_transfer",
      to_address,
      amount_btc,
      amount_sats: amountSats.toString(),
      from_address,
      network,
      memo,
      message: `Sending ${amount_btc} BTC to ${to_address}`,
      instructions: {
        step1: "Confirm the transaction in your BTC wallet",
        step2: "Wait for the wallet to sign and broadcast",
        step3: "Transaction hash will be returned upon success",
      },
    },
    intent: {
      type: "SEND_BTC_TRANSFER",
      toAddress: to_address,
      amount: amount_btc,
      amountSats: amountSats.toString(),
      fromAddress: from_address,
      network,
      memo,
      requiresBTCWallet: true,
      requiresSignature: true,
    },
  };
}

// ─── prepare_stake_btc ───────────────────────────────────────
// Prepare BTC staking after x402 payment and wallet connection

async function handlePrepareStakeBTC(
  args: {
    deposit_address: string;
    amount: string;
    intent_id: string;
  },
  _config: MCPConfig
): Promise<{ result: any; intent?: any }> {
  const { deposit_address, amount, intent_id } = args;

  // Validate inputs
  if (!deposit_address || !amount || !intent_id) {
    return {
      result: {
        success: false,
        error: "Missing required parameters: deposit_address, amount, or intent_id",
      },
    };
  }

  return {
    result: {
      success: true,
      action: "stake_btc",
      deposit_address,
      amount,
      intent_id,
      message: `Ready to stake ${amount} BTC. Please confirm the transaction in your wallet.`,
    },
    intent: {
      type: "STAKE_BTC",
      depositAddress: deposit_address,
      amount,
      intentId: intent_id,
      requiresBTCWallet: true,
      requiresSignature: true,
    },
  };
}

// Export store for external access
export { btcPaymentStore };
