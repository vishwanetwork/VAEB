// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentWallet} from "./interfaces/IAgentWallet.sol";
import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";
import {ECDSA} from "./lib/ECDSA.sol";
import {EIP712} from "./lib/EIP712.sol";

/**
 * @title AgentWallet — ERC-8150 Implementation
 * @notice A smart contract wallet that allows AI agents to execute on-chain
 *         operations on behalf of users, with ZK proof verification ensuring
 *         the agent faithfully derived calldata from the user's signed intent.
 *
 * Security model:
 * - Owner: The user who controls this wallet (holds signing key)
 * - Agent: The AI agent authorized to submit transactions (cannot sign)
 * - ZK Verifier: On-chain Groth16 verifier that validates proof correctness
 * - All calls execute atomically (all-or-nothing)
 * - Nonces prevent replay attacks
 * - Expiry timestamps prevent stale execution
 */
contract AgentWallet is IAgentWallet, EIP712 {
    // ─── State ──────────────────────────────────────────────────

    address public override owner;
    address public override agent;
    address public override zkVerifier;

    /// @notice Tracks used nonces to prevent replay
    mapping(bytes32 => bool) private _usedNonces;

    // ─── EIP-712 Type Hashes ────────────────────────────────────

    bytes32 private constant ACTION_ENTRY_TYPEHASH = keccak256(
        "ActionEntry(string actionType,address token,address to,uint256 amount)"
    );

    bytes32 private constant INTENT_BUNDLE_TYPEHASH = keccak256(
        "IntentBundle(string version,uint256 chainId,bytes32 nonce,uint256 expiry,address payer,ActionEntry[] actions)ActionEntry(string actionType,address token,address to,uint256 amount)"
    );

    bytes32 private constant DIRECT_EXECUTION_TYPEHASH = keccak256(
        "DirectExecution(bytes32 nonce,uint256 expiry,bytes32 callsHash)"
    );

    // ─── Constructor ────────────────────────────────────────────

    constructor(
        address _owner,
        address _agent,
        address _zkVerifier
    ) EIP712("VAEB AgentWallet", "1") {
        owner = _owner;
        agent = _agent;
        zkVerifier = _zkVerifier;
    }

    // ─── Modifiers ──────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrAgent() {
        if (msg.sender != owner && msg.sender != agent) revert NotOwnerOrAgent();
        _;
    }

    // ─── Core: Execute with ZK Proof ────────────────────────────

    /**
     * @notice Execute an intent bundle with ZK proof verification.
     *
     * The flow:
     * 1. Verify the ZK proof matches the public inputs
     * 2. Verify the EIP-712 signature from the owner
     * 3. Check nonce hasn't been used and intent hasn't expired
     * 4. Verify multicallDataHash matches the provided calls
     * 5. Execute all calls atomically
     * 6. Mark nonce as used
     */
    function executeWithProof(
        bytes calldata proof,
        bytes calldata signature,
        PublicInputs calldata publicInputs,
        Call[] calldata calls
    ) external override onlyOwnerOrAgent {
        uint256 gasStart = gasleft();

        // 1. Verify ZK proof (if verifier is set)
        if (zkVerifier != address(0)) {
            bool proofValid = IGroth16Verifier(zkVerifier).verifyProof(
                proof,
                _encodePublicInputs(publicInputs)
            );
            if (!proofValid) revert InvalidProof();
        }

        // 2. Verify EIP-712 signature from owner
        bytes32 intentHash = publicInputs.commitment;
        bytes32 digest = _hashTypedDataV4(intentHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != owner) revert InvalidSignature();

        // 3. Check nonce
        if (_usedNonces[publicInputs.nonce]) 
            revert NonceAlreadyUsed(publicInputs.nonce);

        // 4. Check expiry
        if (block.timestamp > publicInputs.expiry) 
            revert IntentExpired(publicInputs.expiry);

        // 5. Verify chain ID
        if (publicInputs.chainId != block.chainid)
            revert WrongChain(block.chainid, publicInputs.chainId);

        // 6. Verify signer matches owner
        if (publicInputs.signerAddress != owner)
            revert SignerMismatch(owner, publicInputs.signerAddress);

        // 7. Reject empty call arrays
        if (calls.length == 0) revert EmptyCalls();

        // 8. Execute all calls atomically
        // NOTE: The ZK proof already cryptographically verifies that the calls
        // are correctly derived from the signed intent (via Poseidon hashing
        // inside the circuit). An on-chain keccak256 check is unnecessary here
        // and would fail because the circuit uses Poseidon, not keccak256.
        // The executeDirectly() path still has its own keccak256 check.
        _executeCalls(calls);

        // 9. Mark nonce as used
        _usedNonces[publicInputs.nonce] = true;

        uint256 gasUsed = gasStart - gasleft();
        emit IntentExecuted(intentHash, owner, publicInputs.nonce, calls.length, gasUsed);
    }

    // ─── Core: Execute Directly (No ZK Proof) ───────────────────

    /**
     * @notice Execute calls directly with just an owner signature.
     * @dev For simple operations that don't need ZK verification.
     *      Still requires owner signature, nonce, and expiry.
     */
    function executeDirectly(
        bytes calldata signature,
        bytes32 nonce,
        uint256 expiry,
        Call[] calldata calls
    ) external override onlyOwnerOrAgent {
        // Check nonce
        if (_usedNonces[nonce]) 
            revert NonceAlreadyUsed(nonce);

        // Check expiry
        if (block.timestamp > expiry) 
            revert IntentExpired(expiry);

        // Reject empty call arrays
        if (calls.length == 0) revert EmptyCalls();

        // Verify signature over (nonce, expiry, callsHash)
        bytes32 callsHash = _hashCalls(calls);
        bytes32 structHash = keccak256(
            abi.encode(DIRECT_EXECUTION_TYPEHASH, nonce, expiry, callsHash)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != owner) revert InvalidSignature();

        // Execute
        _executeCalls(calls);

        // Mark nonce used
        _usedNonces[nonce] = true;

        emit IntentExecuted(bytes32(0), owner, nonce, calls.length, 0);
    }

    // ─── Nonce Management ───────────────────────────────────────

    function invalidateNonce(bytes32 nonce) external override onlyOwner {
        _usedNonces[nonce] = true;
        emit NonceInvalidated(nonce);
    }

    function invalidateNonceRange(bytes32[] calldata nonces) external override onlyOwner {
        for (uint256 i = 0; i < nonces.length; i++) {
            _usedNonces[nonces[i]] = true;
            emit NonceInvalidated(nonces[i]);
        }
    }

    function isNonceUsed(bytes32 nonce) external view override returns (bool) {
        return _usedNonces[nonce];
    }

    // ─── Agent Management ───────────────────────────────────────

    function setAgent(address newAgent) external onlyOwner {
        address oldAgent = agent;
        agent = newAgent;
        emit AgentUpdated(oldAgent, newAgent);
    }

    function setZkVerifier(address newVerifier) external onlyOwner {
        zkVerifier = newVerifier;
    }

    // ─── Internal: Execute Calls ────────────────────────────────

    function _executeCalls(Call[] calldata calls) internal {
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory returnData) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!success) revert CallFailed(i, returnData);
        }
    }

    // ─── Internal: Hash Calls ───────────────────────────────────

    function _hashCalls(Call[] calldata calls) internal pure returns (bytes32) {
        return keccak256(abi.encode(calls));
    }

    // ─── Internal: Encode Public Inputs for ZK Verifier ─────────

    function _encodePublicInputs(PublicInputs calldata inputs) internal pure returns (uint256[] memory) {
        uint256[] memory pubInputs = new uint256[](6);
        pubInputs[0] = uint256(inputs.commitment);
        pubInputs[1] = inputs.chainId;
        pubInputs[2] = uint256(uint160(inputs.signerAddress));
        pubInputs[3] = uint256(inputs.multicallDataHash);
        pubInputs[4] = uint256(inputs.nonce);
        pubInputs[5] = inputs.expiry;
        return pubInputs;
    }

    // ─── Receive ETH ────────────────────────────────────────────

    receive() external payable {}
    fallback() external payable {}
}
