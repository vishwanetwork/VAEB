// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {IAgentWallet} from "../src/interfaces/IAgentWallet.sol";
import {MockZKVerifier} from "../src/mocks/MockZKVerifier.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/**
 * @title AgentWalletTest
 * @notice Foundry test suite for AgentWallet.sol
 *
 * Coverage:
 *   - executeDirectly: happy path, all revert cases
 *   - executeWithProof: happy path, all revert cases, no-verifier path
 *   - Nonce management: isNonceUsed, invalidateNonce, invalidateNonceRange
 *   - Admin: setAgent, setZkVerifier (access control)
 *   - Receive ETH
 */
contract AgentWalletTest is Test {
    // ─── Type hashes ────────────────────────────────────────────

    bytes32 constant DIRECT_EXECUTION_TYPEHASH =
        keccak256("DirectExecution(bytes32 nonce,uint256 expiry,bytes32 callsHash)");

    // ─── Actors ─────────────────────────────────────────────────

    uint256 ownerKey  = 0xA11CE;
    uint256 agentKey  = 0xB0B;
    uint256 randomKey = 0xDEAD;

    address owner;
    address agent;
    address random;

    // ─── Contracts ──────────────────────────────────────────────

    AgentWallet    wallet;
    MockZKVerifier verifier;
    MockERC20      token;

    // ─── Setup ──────────────────────────────────────────────────

    function setUp() public {
        owner  = vm.addr(ownerKey);
        agent  = vm.addr(agentKey);
        random = vm.addr(randomKey);

        verifier = new MockZKVerifier();
        wallet   = new AgentWallet(owner, agent, address(verifier));
        token    = new MockERC20("Mock USDC", "mUSDC", 6);

        // Fund the wallet with ETH
        vm.deal(address(wallet), 1 ether);
        // Mint tokens to the wallet
        token.mint(address(wallet), 1000e6);

        // Give tests a realistic starting timestamp so underflow is impossible
        vm.warp(365 days);
    }

    // ════════════════════════════════════════════════════════════
    //  Helpers
    // ════════════════════════════════════════════════════════════

    /// Build a domain separator matching the wallet's EIP-712 domain.
    function _domainSeparator() internal view returns (bytes32) {
        return wallet.domainSeparator();
    }

    /// Sign a DirectExecution and return the 65-byte signature.
    function _signDirectExec(
        uint256 signerKey,
        bytes32 nonce,
        uint256 expiry,
        IAgentWallet.Call[] memory calls
    ) internal view returns (bytes memory) {
        bytes32 callsHash  = keccak256(abi.encode(calls));
        bytes32 structHash = keccak256(abi.encode(DIRECT_EXECUTION_TYPEHASH, nonce, expiry, callsHash));
        bytes32 digest     = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Sign a commitment for executeWithProof.
    function _signCommitment(uint256 signerKey, bytes32 commitment) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), commitment));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Build a trivial single-call array that transfers ETH to `recipient`.
    function _ethTransferCalls(address recipient, uint256 amount)
        internal pure returns (IAgentWallet.Call[] memory calls)
    {
        calls = new IAgentWallet.Call[](1);
        calls[0] = IAgentWallet.Call({target: recipient, value: amount, data: ""});
    }

    /// Build a single call that transfers ERC20 tokens.
    function _erc20TransferCalls(address tokenAddr, address recipient, uint256 amount)
        internal pure returns (IAgentWallet.Call[] memory calls)
    {
        calls = new IAgentWallet.Call[](1);
        calls[0] = IAgentWallet.Call({
            target: tokenAddr,
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", recipient, amount)
        });
    }

    /// Build a fresh nonce and far-future expiry.
    function _freshNonceExpiry() internal view returns (bytes32 nonce, uint256 expiry) {
        nonce  = keccak256(abi.encode("nonce", block.timestamp));
        expiry = block.timestamp + 1 hours;
    }

    /// Build valid PublicInputs for executeWithProof.
    function _publicInputs(bytes32 commitment, bytes32 nonce, uint256 expiry)
        internal view returns (IAgentWallet.PublicInputs memory)
    {
        return IAgentWallet.PublicInputs({
            commitment:        commitment,
            chainId:           block.chainid,
            signerAddress:     owner,
            multicallDataHash: bytes32(0), // not validated on-chain with ZK path
            nonce:             nonce,
            expiry:            expiry
        });
    }

    // ════════════════════════════════════════════════════════════
    //  Initial State
    // ════════════════════════════════════════════════════════════

    function test_initialState() public view {
        assertEq(wallet.owner(), owner);
        assertEq(wallet.agent(), agent);
        assertEq(wallet.zkVerifier(), address(verifier));
    }

    // ════════════════════════════════════════════════════════════
    //  executeDirectly — Happy Paths
    // ════════════════════════════════════════════════════════════

    function test_executeDirectly_agentSendsETH() public {
        address recipient = makeAddr("recipient");
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        IAgentWallet.Call[] memory calls = _ethTransferCalls(recipient, 0.1 ether);

        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        uint256 balBefore = recipient.balance;
        vm.prank(agent);
        wallet.executeDirectly(sig, nonce, expiry, calls);

        assertEq(recipient.balance - balBefore, 0.1 ether);
        assertTrue(wallet.isNonceUsed(nonce));
    }

    function test_executeDirectly_ownerCanCall() public {
        address recipient = makeAddr("recipient2");
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        IAgentWallet.Call[] memory calls = _ethTransferCalls(recipient, 0.05 ether);
        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        vm.prank(owner);
        wallet.executeDirectly(sig, nonce, expiry, calls);

        assertEq(recipient.balance, 0.05 ether);
    }

    function test_executeDirectly_erc20Transfer() public {
        address recipient = makeAddr("recipient3");
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        IAgentWallet.Call[] memory calls = _erc20TransferCalls(address(token), recipient, 100e6);
        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        vm.prank(agent);
        wallet.executeDirectly(sig, nonce, expiry, calls);

        assertEq(token.balanceOf(recipient), 100e6);
    }

    function test_executeDirectly_emitsIntentExecuted() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0.01 ether);
        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        vm.expectEmit(true, true, false, false, address(wallet));
        emit IAgentWallet.IntentExecuted(bytes32(0), owner, nonce, 1, 0);

        vm.prank(agent);
        wallet.executeDirectly(sig, nonce, expiry, calls);
    }

    // ════════════════════════════════════════════════════════════
    //  executeDirectly — Revert Cases
    // ════════════════════════════════════════════════════════════

    function test_executeDirectly_revertsIfNotOwnerOrAgent() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);
        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        vm.prank(random);
        vm.expectRevert(IAgentWallet.NotOwnerOrAgent.selector);
        wallet.executeDirectly(sig, nonce, expiry, calls);
    }

    function test_executeDirectly_revertsIfInvalidSignature() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);
        // Sign with the wrong key (random instead of owner)
        bytes memory badSig = _signDirectExec(randomKey, nonce, expiry, calls);

        vm.prank(agent);
        vm.expectRevert(IAgentWallet.InvalidSignature.selector);
        wallet.executeDirectly(badSig, nonce, expiry, calls);
    }

    function test_executeDirectly_revertsIfExpired() public {
        bytes32 nonce  = keccak256("expired-nonce");
        uint256 expiry = block.timestamp - 1; // already past
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);
        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.IntentExpired.selector, expiry));
        wallet.executeDirectly(sig, nonce, expiry, calls);
    }

    function test_executeDirectly_revertsIfNonceAlreadyUsed() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);
        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        vm.prank(agent);
        wallet.executeDirectly(sig, nonce, expiry, calls);

        // Second execution with the same nonce
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.NonceAlreadyUsed.selector, nonce));
        wallet.executeDirectly(sig, nonce, expiry, calls);
    }

    function test_executeDirectly_revertsIfEmptyCalls() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        IAgentWallet.Call[] memory calls = new IAgentWallet.Call[](0);
        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        vm.prank(agent);
        vm.expectRevert(IAgentWallet.EmptyCalls.selector);
        wallet.executeDirectly(sig, nonce, expiry, calls);
    }

    function test_executeDirectly_revertsIfCallFails() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        // Call a contract with bad data — token.transfer to zero with more than balance
        IAgentWallet.Call[] memory calls = new IAgentWallet.Call[](1);
        calls[0] = IAgentWallet.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", address(0), type(uint256).max)
        });
        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        vm.prank(agent);
        vm.expectRevert(); // CallFailed(0, ...)
        wallet.executeDirectly(sig, nonce, expiry, calls);
    }

    // ════════════════════════════════════════════════════════════
    //  executeWithProof — Happy Paths
    // ════════════════════════════════════════════════════════════

    function test_executeWithProof_happyPath() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        bytes32 commitment = keccak256("test_intent_commitment");
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0.1 ether);
        IAgentWallet.PublicInputs memory inputs = _publicInputs(commitment, nonce, expiry);

        bytes memory sig   = _signCommitment(ownerKey, commitment);
        bytes memory proof = bytes(""); // MockZKVerifier accepts any proof

        address recipient = makeAddr("r");
        uint256 balBefore = recipient.balance;

        vm.prank(agent);
        wallet.executeWithProof(proof, sig, inputs, calls);

        assertEq(recipient.balance - balBefore, 0.1 ether);
        assertTrue(wallet.isNonceUsed(nonce));
    }

    function test_executeWithProof_ownerCanCall() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        bytes32 commitment = keccak256("owner_call_commitment");
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0.01 ether);
        IAgentWallet.PublicInputs memory inputs = _publicInputs(commitment, nonce, expiry);
        bytes memory sig = _signCommitment(ownerKey, commitment);

        vm.prank(owner);
        wallet.executeWithProof(bytes(""), sig, inputs, calls);
    }

    function test_executeWithProof_skipsZkCheckWhenNoVerifier() public {
        // Deploy wallet with no verifier
        AgentWallet noVerifierWallet = new AgentWallet(owner, agent, address(0));
        vm.deal(address(noVerifierWallet), 1 ether);

        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        bytes32 commitment = keccak256("no_verifier_commitment");

        // Build inputs against noVerifierWallet's domain separator
        IAgentWallet.PublicInputs memory inputs = IAgentWallet.PublicInputs({
            commitment:        commitment,
            chainId:           block.chainid,
            signerAddress:     owner,
            multicallDataHash: bytes32(0),
            nonce:             nonce,
            expiry:            expiry
        });

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", noVerifierWallet.domainSeparator(), commitment)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0.1 ether);

        vm.prank(agent);
        noVerifierWallet.executeWithProof(bytes("bad_proof"), sig, inputs, calls);
        // No revert — proof check was skipped
    }

    // ════════════════════════════════════════════════════════════
    //  executeWithProof — Revert Cases
    // ════════════════════════════════════════════════════════════

    function test_executeWithProof_revertsIfNotOwnerOrAgent() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        bytes32 commitment = keccak256("commit");
        IAgentWallet.PublicInputs memory inputs = _publicInputs(commitment, nonce, expiry);
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);
        bytes memory sig = _signCommitment(ownerKey, commitment);

        vm.prank(random);
        vm.expectRevert(IAgentWallet.NotOwnerOrAgent.selector);
        wallet.executeWithProof(bytes(""), sig, inputs, calls);
    }

    function test_executeWithProof_revertsIfProofInvalid() public {
        verifier.setShouldVerify(false);

        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        bytes32 commitment = keccak256("commit");
        IAgentWallet.PublicInputs memory inputs = _publicInputs(commitment, nonce, expiry);
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);
        bytes memory sig = _signCommitment(ownerKey, commitment);

        vm.prank(agent);
        vm.expectRevert(IAgentWallet.InvalidProof.selector);
        wallet.executeWithProof(bytes("bad"), sig, inputs, calls);
    }

    function test_executeWithProof_revertsIfInvalidSignature() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        bytes32 commitment = keccak256("commit");
        IAgentWallet.PublicInputs memory inputs = _publicInputs(commitment, nonce, expiry);
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);

        // Sign with wrong key
        bytes memory badSig = _signCommitment(randomKey, commitment);

        vm.prank(agent);
        vm.expectRevert(IAgentWallet.InvalidSignature.selector);
        wallet.executeWithProof(bytes(""), badSig, inputs, calls);
    }

    function test_executeWithProof_revertsIfNonceAlreadyUsed() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        bytes32 commitment = keccak256("commit");
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);
        IAgentWallet.PublicInputs memory inputs = _publicInputs(commitment, nonce, expiry);
        bytes memory sig = _signCommitment(ownerKey, commitment);

        vm.prank(agent);
        wallet.executeWithProof(bytes(""), sig, inputs, calls);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.NonceAlreadyUsed.selector, nonce));
        wallet.executeWithProof(bytes(""), sig, inputs, calls);
    }

    function test_executeWithProof_revertsIfExpired() public {
        bytes32 nonce      = keccak256("expired");
        uint256 expiry     = block.timestamp - 1;
        bytes32 commitment = keccak256("commit");
        IAgentWallet.PublicInputs memory inputs = _publicInputs(commitment, nonce, expiry);
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);
        bytes memory sig = _signCommitment(ownerKey, commitment);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.IntentExpired.selector, expiry));
        wallet.executeWithProof(bytes(""), sig, inputs, calls);
    }

    function test_executeWithProof_revertsIfWrongChain() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        bytes32 commitment = keccak256("commit");
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);

        IAgentWallet.PublicInputs memory inputs = IAgentWallet.PublicInputs({
            commitment:        commitment,
            chainId:           999999, // wrong chain
            signerAddress:     owner,
            multicallDataHash: bytes32(0),
            nonce:             nonce,
            expiry:            expiry
        });
        bytes memory sig = _signCommitment(ownerKey, commitment);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.WrongChain.selector, block.chainid, uint256(999999)));
        wallet.executeWithProof(bytes(""), sig, inputs, calls);
    }

    function test_executeWithProof_revertsIfSignerMismatch() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        bytes32 commitment = keccak256("commit");
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);

        IAgentWallet.PublicInputs memory inputs = IAgentWallet.PublicInputs({
            commitment:        commitment,
            chainId:           block.chainid,
            signerAddress:     random, // not owner
            multicallDataHash: bytes32(0),
            nonce:             nonce,
            expiry:            expiry
        });
        bytes memory sig = _signCommitment(ownerKey, commitment);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.SignerMismatch.selector, owner, random));
        wallet.executeWithProof(bytes(""), sig, inputs, calls);
    }

    function test_executeWithProof_revertsIfEmptyCalls() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        bytes32 commitment = keccak256("commit");
        IAgentWallet.PublicInputs memory inputs = _publicInputs(commitment, nonce, expiry);
        IAgentWallet.Call[] memory calls = new IAgentWallet.Call[](0);
        bytes memory sig = _signCommitment(ownerKey, commitment);

        vm.prank(agent);
        vm.expectRevert(IAgentWallet.EmptyCalls.selector);
        wallet.executeWithProof(bytes(""), sig, inputs, calls);
    }

    // ════════════════════════════════════════════════════════════
    //  Nonce Management
    // ════════════════════════════════════════════════════════════

    function test_isNonceUsed_freshNonce() public view {
        assertFalse(wallet.isNonceUsed(keccak256("fresh")));
    }

    function test_invalidateNonce_ownerOnly() public {
        bytes32 nonce = keccak256("to_invalidate");
        assertFalse(wallet.isNonceUsed(nonce));

        vm.prank(owner);
        wallet.invalidateNonce(nonce);

        assertTrue(wallet.isNonceUsed(nonce));
    }

    function test_invalidateNonce_emitsEvent() public {
        bytes32 nonce = keccak256("event_nonce");

        vm.expectEmit(true, false, false, false, address(wallet));
        emit IAgentWallet.NonceInvalidated(nonce);

        vm.prank(owner);
        wallet.invalidateNonce(nonce);
    }

    function test_invalidateNonce_revertsIfNotOwner() public {
        vm.prank(agent);
        vm.expectRevert(IAgentWallet.NotOwner.selector);
        wallet.invalidateNonce(keccak256("x"));
    }

    function test_invalidateNonceRange() public {
        bytes32[] memory nonces = new bytes32[](3);
        nonces[0] = keccak256("n0");
        nonces[1] = keccak256("n1");
        nonces[2] = keccak256("n2");

        vm.prank(owner);
        wallet.invalidateNonceRange(nonces);

        assertTrue(wallet.isNonceUsed(nonces[0]));
        assertTrue(wallet.isNonceUsed(nonces[1]));
        assertTrue(wallet.isNonceUsed(nonces[2]));
    }

    function test_invalidateNonceRange_revertsIfNotOwner() public {
        bytes32[] memory nonces = new bytes32[](1);
        nonces[0] = keccak256("x");

        vm.prank(random);
        vm.expectRevert(IAgentWallet.NotOwner.selector);
        wallet.invalidateNonceRange(nonces);
    }

    // Invalidated nonce blocks executeDirectly
    function test_invalidatedNonce_blocksExecution() public {
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);
        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        vm.prank(owner);
        wallet.invalidateNonce(nonce);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.NonceAlreadyUsed.selector, nonce));
        wallet.executeDirectly(sig, nonce, expiry, calls);
    }

    // ════════════════════════════════════════════════════════════
    //  Admin: setAgent
    // ════════════════════════════════════════════════════════════

    function test_setAgent_ownerOnly() public {
        address newAgent = makeAddr("newAgent");

        vm.prank(owner);
        wallet.setAgent(newAgent);

        assertEq(wallet.agent(), newAgent);
    }

    function test_setAgent_emitsEvent() public {
        address newAgent = makeAddr("newAgent2");

        vm.expectEmit(true, true, false, false, address(wallet));
        emit IAgentWallet.AgentUpdated(agent, newAgent);

        vm.prank(owner);
        wallet.setAgent(newAgent);
    }

    function test_setAgent_revertsIfNotOwner() public {
        vm.prank(agent);
        vm.expectRevert(IAgentWallet.NotOwner.selector);
        wallet.setAgent(makeAddr("x"));
    }

    function test_setAgent_revertsIfRandom() public {
        vm.prank(random);
        vm.expectRevert(IAgentWallet.NotOwner.selector);
        wallet.setAgent(makeAddr("x"));
    }

    // After setAgent, old agent can no longer call
    function test_setAgent_oldAgentLosesAccess() public {
        address newAgent = makeAddr("newAgent");
        vm.prank(owner);
        wallet.setAgent(newAgent);

        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);
        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        vm.prank(agent); // old agent
        vm.expectRevert(IAgentWallet.NotOwnerOrAgent.selector);
        wallet.executeDirectly(sig, nonce, expiry, calls);
    }

    // ════════════════════════════════════════════════════════════
    //  Admin: setZkVerifier
    // ════════════════════════════════════════════════════════════

    function test_setZkVerifier_ownerOnly() public {
        address newVerifier = makeAddr("v2");
        vm.prank(owner);
        wallet.setZkVerifier(newVerifier);
        assertEq(wallet.zkVerifier(), newVerifier);
    }

    function test_setZkVerifier_revertsIfNotOwner() public {
        vm.prank(agent);
        vm.expectRevert(IAgentWallet.NotOwner.selector);
        wallet.setZkVerifier(makeAddr("v2"));
    }

    function test_setZkVerifier_toZeroDisablesChecks() public {
        // Disable verifier
        vm.prank(owner);
        wallet.setZkVerifier(address(0));
        assertEq(wallet.zkVerifier(), address(0));

        // executeWithProof should now pass without any proof
        (bytes32 nonce, uint256 expiry) = _freshNonceExpiry();
        bytes32 commitment = keccak256("commit");
        IAgentWallet.PublicInputs memory inputs = _publicInputs(commitment, nonce, expiry);
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0.01 ether);
        bytes memory sig = _signCommitment(ownerKey, commitment);

        vm.prank(agent);
        wallet.executeWithProof(bytes("anything"), sig, inputs, calls);
    }

    // ════════════════════════════════════════════════════════════
    //  Receive ETH
    // ════════════════════════════════════════════════════════════

    function test_receiveETH() public {
        uint256 balBefore = address(wallet).balance;
        vm.deal(random, 1 ether);

        vm.prank(random);
        (bool ok,) = address(wallet).call{value: 0.5 ether}("");
        assertTrue(ok);
        assertEq(address(wallet).balance, balBefore + 0.5 ether);
    }

    function test_fallbackETH() public {
        vm.deal(random, 1 ether);
        vm.prank(random);
        (bool ok,) = address(wallet).call{value: 0.1 ether}(hex"dead");
        assertTrue(ok);
    }

    // ════════════════════════════════════════════════════════════
    //  Fuzz Tests
    // ════════════════════════════════════════════════════════════

    function testFuzz_isNonceUsed_freshNonces(bytes32 nonce) public view {
        assertFalse(wallet.isNonceUsed(nonce));
    }

    function testFuzz_executeDirectly_expiredReverts(uint256 secondsInPast) public {
        secondsInPast = bound(secondsInPast, 1, 365 days);
        bytes32 nonce  = keccak256("fuzz_expired");
        uint256 expiry = block.timestamp - secondsInPast;
        IAgentWallet.Call[] memory calls = _ethTransferCalls(makeAddr("r"), 0);
        bytes memory sig = _signDirectExec(ownerKey, nonce, expiry, calls);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.IntentExpired.selector, expiry));
        wallet.executeDirectly(sig, nonce, expiry, calls);
    }
}
