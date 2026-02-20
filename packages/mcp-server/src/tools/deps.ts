import { ethers } from "ethers";
import { CHAINS } from "@vaeb/intent-sdk";

export type ProviderFactory = (chainKey: string, rpcOverride?: string) => ethers.JsonRpcProvider;
export type ContractFactory = (address: string, abi: any, providerOrSigner: any) => any;

export function getProvider(
  chainKey: string,
  rpcOverride?: string,
  providerFactory?: ProviderFactory
): ethers.JsonRpcProvider {
  if (providerFactory) return providerFactory(chainKey, rpcOverride);
  const chain = CHAINS[chainKey];
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainKey}. Supported: ${Object.keys(CHAINS).join(", ")}`);
  }
  return new ethers.JsonRpcProvider(rpcOverride || chain.rpcUrl);
}

export function getContract(
  address: string,
  abi: any,
  providerOrSigner: any,
  contractFactory?: ContractFactory
) {
  if (contractFactory) return contractFactory(address, abi, providerOrSigner);
  return new ethers.Contract(address, abi, providerOrSigner);
}
