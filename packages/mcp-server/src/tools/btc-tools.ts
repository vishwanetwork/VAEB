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
    network = "testnet", 
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
        error: `无效的 BTC 金额: ${amount_btc}`,
      },
    };
  }

  // Validate Sui address
  if (!sui_address || !sui_address.match(/^0x[a-fA-F0-9]{64}$/)) {
    return {
      result: {
        success: false,
        error: `无效的 Sui 地址格式。应为: 0x 后跟 64 位十六进制字符`,
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
          error: "支付意图未找到或已过期",
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
            error: `支付后请求失败: HTTP ${response.status}`,
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
            message: `支付成功！BTC质押已初始化。请将 ${amount_btc} BTC 发送到质押地址: ${depositAddress}`,
            instructions: {
              step1: `发送 ${amount_btc} BTC 到: ${depositAddress}`,
              step2: "等待比特币网络确认",
              step3: "提供交易哈希完成确认",
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
          error: "支付后未返回有效的BTC地址",
          response: responseData,
        },
      };
    } catch (error: any) {
      return {
        result: {
          success: false,
          error: `支付后请求失败: ${error.message}`,
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
            message: `正在初始化 BTC 质押服务...系统将自动弹出支付界面。`,
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
          error: "无法解析 x402 支付要求",
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
            message: `BTC 质押地址已生成。系统将自动显示存款界面。`,
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
        error: `桥接服务返回意外响应: HTTP ${discoveryResponse.status}`,
        details: errorText,
      },
    };

  } catch (error: any) {
    console.error(`[BTC Bridge] Error:`, error);
    return {
      result: {
        success: false,
        error: `调用桥接服务失败: ${error.message}`,
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
        error: `BTC 支付意图未找到: ${intent_id}`,
      },
    };
  }

  if (Math.floor(Date.now() / 1000) > intent.expiresAt) {
    intent.status = "expired";
    btcPaymentStore.set(intent_id, intent);
    return {
      result: {
        success: false,
        error: "支付意图已过期",
        expired_at: new Date(intent.expiresAt * 1000).toISOString(),
      },
    };
  }

  if (intent.status !== "awaiting_deposit") {
    return {
      result: {
        success: false,
        error: `无效状态: ${intent.status}。应为: awaiting_deposit`,
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
            error: `交易未找到: ${tx_hash}。请验证交易哈希后重试。`,
          },
        };
      }

      const txData = await txResponse.json() as TxData;
      
      intent.txHash = tx_hash;
      intent.status = "deposit_received";
      btcPaymentStore.set(intent_id, intent);

      const confirmationStatus = txData.status?.confirmed 
        ? (txData.status.block_height ? "已确认" : "待确认") 
        : "待确认";

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
          message: `交易已确认。BTCVC 将发放到 Sui 地址: ${intent.suiAddress}`,
          next_steps: `后端服务将自动处理 BTCVC 发放`,
        },
      };
    } catch (error: any) {
      return {
        result: {
          success: false,
          error: `确认转账失败: ${error.message}`,
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
      message: "等待 BTC 存款。请发送 BTC 到质押地址并提供交易哈希。",
      instructions: {
        step1: `发送 ${intent.amountBTC} BTC 到: ${intent.depositAddress}`,
        step2: "等待网络确认",
        step3: `调用 confirm_btc_transfer 并提供 tx_hash`,
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
            error: `在 ${network} 上未找到交易: ${tx_hash}`,
          },
        };
      }

      const txData = await txResponse.json() as TxData;
      
      return {
        result: {
          success: true,
          tx_hash,
          network,
          status: txData.status?.confirmed ? "已确认" : "待确认",
          confirmations: txData.status?.block_height || 0,
          explorer_url: `${apiBase}/tx/${tx_hash}`,
        },
      };
    } catch (error: any) {
      return {
        result: {
          success: false,
          error: `验证交易失败: ${error.message}`,
        },
      };
    }
  }

  if (!intent) {
    return {
      result: {
        success: false,
        error: `BTC 支付意图未找到: ${intent_id}`,
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
            error: `广播失败: ${errorText}`,
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
          message: "交易广播成功。",
        },
      };
    } catch (error: any) {
      intent.status = "failed";
      btcPaymentStore.set(intent_id, intent);
      return {
        result: {
          success: false,
          error: `广播失败: ${error.message}`,
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
        error: `BTC 支付意图未找到: ${intent_id}`,
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
  const { reason = "BTC 质押", sui_address } = args;

  return {
    result: {
      success: true,
      action: "request_btc_wallet_connection",
      reason,
      sui_address,
      message: `请连接您的 BTC 钱包以${reason}。`,
      instructions: {
        step1: "点击'连接BTC钱包'按钮",
        step2: "在弹出窗口中选择您的 BTC 钱包（Xverse、Unisat 或 Leather）",
        step3: "授权连接后即可继续",
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
