// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAgentWallet — ERC-8150 Interface
 * @notice Interface for agent-operated wallets that execute verified intents.
 *         The wallet verifies a ZK proof that the derived calldata matches
 *         the user's signed IntentBundle before executing atomically.
 */
interface IAgentWallet {
    // ─── Structs ────────────────────────────────────────────────

    /// @notice A single call to execute atomically
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @notice Public inputs to the ZK verifier
    struct PublicInputs {
        bytes32 commitment;      // Hash of the full IntentBundle
        uint256 chainId;
        address signerAddress;   // User who signed the intent
        bytes32 multicallDataHash; // keccak256(abi.encode(calls))
        bytes32 nonce;
        uint256 expiry;
    }

    // ─── Events ─────────────────────────────────────────────────

    event IntentExecuted(
        bytes32 indexed intentId,
        address indexed signer,
        bytes32 nonce,
        uint256 callCount,
        uint256 gasUsed
    );

    event NonceInvalidated(bytes32 indexed nonce);

    event AgentUpdated(address indexed oldAgent, address indexed newAgent);

    // ─── Errors ─────────────────────────────────────────────────

    error InvalidProof();
    error InvalidSignature();
    error NonceAlreadyUsed(bytes32 nonce);
    error IntentExpired(uint256 expiry);
    error WrongChain(uint256 expected, uint256 provided);
    error SignerMismatch(address expected, address provided);
    error EmptyCalls();
    error CallFailed(uint256 index, bytes reason);
    error NotOwner();
    error NotAgent();
    error NotOwnerOrAgent();

    // ─── Core Functions ─────────────────────────────────────────

    /**
     * @notice Execute an intent with a ZK proof of correct derivation
     * @param proof       The Groth16 proof bytes
     * @param signature   EIP-712 signature from the wallet owner
     * @param publicInputs The public inputs verified by the ZK circuit
     * @param calls       The derived calls to execute atomically
     */
    function executeWithProof(
        bytes calldata proof,
        bytes calldata signature,
        PublicInputs calldata publicInputs,
        Call[] calldata calls
    ) external;

    /**
     * @notice Execute calls directly (no ZK proof, requires owner signature)
     * @dev Fallback for simple operations that don't need ZK verification
     */
    function executeDirectly(
        bytes calldata signature,
        bytes32 nonce,
        uint256 expiry,
        Call[] calldata calls
    ) external;

    /**
     * @notice Invalidate a nonce to prevent replay
     */
    function invalidateNonce(bytes32 nonce) external;

    /**
     * @notice Bulk invalidate a range of nonces
     */
    function invalidateNonceRange(bytes32[] calldata nonces) external;

    // ─── View Functions ─────────────────────────────────────────

    function owner() external view returns (address);
    function agent() external view returns (address);
    function isNonceUsed(bytes32 nonce) external view returns (bool);
    function zkVerifier() external view returns (address);
}
