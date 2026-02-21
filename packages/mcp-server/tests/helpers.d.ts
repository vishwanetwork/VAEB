export declare const TEST_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f094538eed6e0e9b8d2a1f2a62f1c4a8f7f7e6d0";
export declare const TEST_ADDRESSES: {
    agentWallet: string;
    factory: string;
    usdc: string;
    owner: string;
    agent: string;
};
export declare class FakeProvider {
    private balances;
    private receipts;
    private gasPrice;
    constructor(opts?: {
        balances?: Record<string, bigint>;
        receipts?: Record<string, any | null>;
        gasPrice?: bigint;
    });
    getBalance(address: string): Promise<bigint>;
    getFeeData(): Promise<{
        gasPrice: bigint;
    }>;
    getTransactionReceipt(hash: string): Promise<any | null>;
}
export declare function makeContractFactory(fixtures?: {
    usedNonces?: Set<string>;
    usdcBalance?: bigint;
    usdcDecimals?: number;
    usdcSymbol?: string;
    predictedAddress?: string;
    walletsByOwner?: Record<string, string[]>;
    deployedWallets?: Set<string>;
    txHash?: string;
    gasUsed?: bigint;
    blockNumber?: number;
}): () => {
    isNonceUsed: (nonce: string) => Promise<boolean>;
    executeWithProof: () => Promise<{
        hash: string;
        wait: () => Promise<{
            gasUsed: bigint;
            logs: never[];
            blockNumber: number;
        }>;
    }>;
    executeDirectly: () => Promise<{
        hash: string;
        wait: () => Promise<{
            gasUsed: bigint;
            logs: never[];
            blockNumber: number;
        }>;
    }>;
    balanceOf: () => Promise<bigint>;
    decimals: () => Promise<number>;
    symbol: () => Promise<string>;
    name: () => Promise<string>;
    predictWalletAddress: () => Promise<string>;
    isWallet: (addr: string) => Promise<boolean>;
    getWallets: (owner: string) => Promise<string[]>;
    createWallet: () => Promise<{
        hash: string;
        wait: () => Promise<{
            gasUsed: bigint;
            logs: never[];
            blockNumber: number;
        }>;
    }>;
};
export declare function baseConfig(overrides?: Partial<any>): {
    walletPrivateKey: string;
    supportedChains: string[];
    defaultChain: string;
    proverEndpoint: string;
    requireManualApproval: boolean;
    rpcUrl: string;
    chainId: number;
    contracts: {
        AgentWallet: string;
        MockUSDC: string;
        AgentWalletFactory: string;
    };
};
