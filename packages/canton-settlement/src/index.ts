/**
 * @vaeb/canton-settlement — Canton coordination layer for VAEB
 *
 * Privacy-preserving multi-party settlement using Canton (Daml) + VAEB (ERC-8150).
 * Canton records agreements and ZK attestations. VAEB executes verified transfers on EVM.
 */

export { CantonClient } from "./canton-client";
export { SettlementBridge } from "./settlement-bridge";
export type {
  CantonConfig,
  ContractRef,
  CustodyAttestation,
  Settlement,
  ExecutionReceipt,
  SettlementIntent,
  SettlementResult,
  ChainId,
  ClaimType,
} from "./types";
export type { BridgeConfig } from "./settlement-bridge";
