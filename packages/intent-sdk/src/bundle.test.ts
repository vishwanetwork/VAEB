import {
  generateNonce,
  calculateExpiry,
  createIntentBundle,
  computeIntentId,
  serializeBundle,
  deserializeBundle,
  bundleToJSON,
  bundleFromJSON,
  deriveCalldata,
  describeIntent,
} from "./bundle";
import { ActionType, IntentBundle } from "./types";
import { CHAINS } from "./constants";

describe("Intent SDK", () => {
  // ─── Nonce Generation ───────────────────────────────────────

  describe("generateNonce", () => {
    it("should generate a valid bytes32 hex string", () => {
      const nonce = generateNonce();
      expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("should generate unique nonces", () => {
      const n1 = generateNonce();
      const n2 = generateNonce();
      expect(n1).not.toEqual(n2);
    });
  });

  // ─── Expiry Calculation ─────────────────────────────────────

  describe("calculateExpiry", () => {
    it("should return timestamp in the future", () => {
      const now = Math.floor(Date.now() / 1000);
      const expiry = calculateExpiry(10);
      expect(expiry).toBeGreaterThan(now);
      expect(expiry).toBeLessThanOrEqual(now + 600 + 1);
    });

    it("should respect custom minutes", () => {
      const now = Math.floor(Date.now() / 1000);
      const expiry = calculateExpiry(30);
      expect(expiry - now).toBeGreaterThanOrEqual(1799);
      expect(expiry - now).toBeLessThanOrEqual(1801);
    });
  });

  // ─── Bundle Creation ───────────────────────────────────────

  describe("createIntentBundle", () => {
    it("should create a valid SWAP intent bundle", () => {
      const bundle = createIntentBundle({
        actions: [
          {
            type: ActionType.SWAP,
            fromToken: "USDC",
            toToken: "ETH",
            amount: 100,
            maxSlippage: 0.005,
          },
        ],
        chainId: 84532,
        walletAddress: "0x1234567890123456789012345678901234567890",
      });

      expect(bundle.version).toBe("1.0");
      expect(bundle.chainId).toBe(84532);
      expect(bundle.nonce).toMatch(/^0x[0-9a-f]{64}$/);
      expect(bundle.expiry).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(bundle.actions).toHaveLength(1);
      expect(bundle.actions[0].actionType).toBe(ActionType.SWAP);
      expect(bundle.actions[0].amount).toBe(100000000n); // 100 USDC = 100 * 10^6
    });

    it("should create a valid TRANSFER intent bundle", () => {
      const bundle = createIntentBundle({
        actions: [
          {
            type: ActionType.TRANSFER,
            token: "USDC",
            amount: 50,
            recipient: "0xRecipient000000000000000000000000000000Ab",
          },
        ],
        chainId: 84532,
        walletAddress: "0x1234567890123456789012345678901234567890",
      });

      expect(bundle.actions[0].actionType).toBe(ActionType.TRANSFER);
      expect(bundle.actions[0].amount).toBe(50000000n); // 50 USDC
    });

    it("should throw for unsupported chain", () => {
      expect(() =>
        createIntentBundle({
          actions: [{ type: ActionType.TRANSFER, token: "USDC", amount: 1, recipient: "0x1234567890123456789012345678901234567890" }],
          chainId: 99999,
          walletAddress: "0x1234567890123456789012345678901234567890",
        })
      ).toThrow("Unsupported chainId");
    });
  });

  // ─── Intent ID ──────────────────────────────────────────────

  describe("computeIntentId", () => {
    it("should compute a deterministic intent ID", () => {
      const bundle: IntentBundle = {
        version: "1.0",
        chainId: 84532,
        nonce: "0x" + "ab".repeat(32),
        expiry: 1700000000,
        payer: "0x1234567890123456789012345678901234567890",
        actions: [
          {
            actionType: ActionType.SWAP,
            token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            to: "0x4200000000000000000000000000000000000006",
            amount: 100000000n,
          },
        ],
      };

      const id1 = computeIntentId(bundle);
      const id2 = computeIntentId(bundle);
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  // ─── Serialization Roundtrip ────────────────────────────────

  describe("serialization", () => {
    const testBundle: IntentBundle = {
      version: "1.0",
      chainId: 84532,
      nonce: "0x" + "cd".repeat(32),
      expiry: 1700000000,
      payer: "0x1234567890123456789012345678901234567890",
      actions: [
        {
          actionType: ActionType.TRANSFER,
          token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          to: "0xABCDABCDABCDABCDABCDABCDABCDABCDABCDABCD",
          amount: 50000000n,
        },
      ],
    };

    it("should serialize and deserialize correctly", () => {
      const serialized = serializeBundle(testBundle);
      const deserialized = deserializeBundle(serialized);

      expect(deserialized.version).toBe(testBundle.version);
      expect(deserialized.chainId).toBe(testBundle.chainId);
      expect(deserialized.nonce).toBe(testBundle.nonce);
      expect(deserialized.expiry).toBe(testBundle.expiry);
      expect(deserialized.payer.toLowerCase()).toBe(
        testBundle.payer.toLowerCase()
      );
      expect(deserialized.actions[0].amount).toBe(testBundle.actions[0].amount);
    });

    it("should roundtrip through JSON", () => {
      const json = bundleToJSON(testBundle);
      const restored = bundleFromJSON(json);

      expect(restored.version).toBe(testBundle.version);
      expect(restored.actions[0].amount).toBe(testBundle.actions[0].amount);
    });
  });

  // ─── Calldata Derivation ────────────────────────────────────

  describe("deriveCalldata", () => {
    it("should derive transfer calldata", async () => {
      const bundle: IntentBundle = {
        version: "1.0",
        chainId: 84532,
        nonce: "0x" + "ee".repeat(32),
        expiry: 1700000000,
        payer: "0x1234567890123456789012345678901234567890",
        actions: [
          {
            actionType: ActionType.TRANSFER,
            token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            to: "0xABCDABCDABCDABCDABCDABCDABCDABCDABCDABCD",
            amount: 50000000n,
          },
        ],
      };

      const derived = await deriveCalldata(bundle, "base_sepolia");
      expect(derived.calls).toHaveLength(1);
      expect(derived.calls[0].target).toBe(
        "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
      );
      expect(derived.calls[0].data).toContain("0xa9059cbb"); // transfer selector
      expect(typeof derived.multicallDataHash).toBe("bigint");
    });

    it("should derive swap calldata with approve + swap", async () => {
      const bundle: IntentBundle = {
        version: "1.0",
        chainId: 84532,
        nonce: "0x" + "ff".repeat(32),
        expiry: 1700000000,
        payer: "0x1234567890123456789012345678901234567890",
        actions: [
          {
            actionType: ActionType.SWAP,
            token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            to: "0x4200000000000000000000000000000000000006",
            amount: 100000000n,
          },
        ],
      };

      const derived = await deriveCalldata(bundle, "base_sepolia");
      // Should have 2 calls: approve + swap
      expect(derived.calls.length).toBe(2);
      // First call is approve
      expect(derived.calls[0].data).toContain("0x095ea7b3");
      // Second call is the swap
      expect(derived.calls[1].target.toLowerCase()).toBe(
        CHAINS.base_sepolia.dexRouters.uniswap_v3.toLowerCase()
      );
    });
  });

  // ─── Human-Readable Descriptions ───────────────────────────

  describe("describeIntent", () => {
    it("should describe a swap intent", () => {
      const bundle: IntentBundle = {
        version: "1.0",
        chainId: 84532,
        nonce: "0x" + "00".repeat(32),
        expiry: 1700000000,
        payer: "0x1234567890123456789012345678901234567890",
        actions: [
          {
            actionType: ActionType.SWAP,
            token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            to: "0x4200000000000000000000000000000000000006",
            amount: 100000000n,
          },
        ],
      };

      const desc = describeIntent(bundle);
      expect(desc).toContain("Swap");
      expect(desc).toContain("USDC");
      expect(desc).toContain("WETH");
      expect(desc).toContain("Base Sepolia");
    });
  });
});
