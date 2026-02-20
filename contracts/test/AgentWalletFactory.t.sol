// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AgentWalletFactory} from "../src/AgentWalletFactory.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {MockZKVerifier} from "../src/mocks/MockZKVerifier.sol";

/**
 * @title AgentWalletFactoryTest
 * @notice Foundry test suite for AgentWalletFactory.sol
 *
 * Coverage:
 *   - createWallet: deploy, register, emit event
 *   - createWalletWithVerifier: custom verifier wired correctly
 *   - predictWalletAddress: predicted == deployed address
 *   - getWallets / walletCount: correct tracking per owner
 *   - setDefaultZkVerifier: access control + state update
 *   - CREATE2 determinism: same salt → same address (second deploy reverts)
 *   - isWallet: correctly marked after deployment
 */
contract AgentWalletFactoryTest is Test {
    // ─── Actors ─────────────────────────────────────────────────

    address factoryDeployer = makeAddr("factoryDeployer");
    address alice           = makeAddr("alice");
    address bob             = makeAddr("bob");
    address agentAlice      = makeAddr("agentAlice");
    address agentBob        = makeAddr("agentBob");
    address randomUser      = makeAddr("randomUser");

    // ─── Contracts ──────────────────────────────────────────────

    AgentWalletFactory factory;
    MockZKVerifier     defaultVerifier;
    MockZKVerifier     customVerifier;

    bytes32 constant SALT_A = bytes32(uint256(1));
    bytes32 constant SALT_B = bytes32(uint256(2));

    // ─── Setup ──────────────────────────────────────────────────

    function setUp() public {
        defaultVerifier = new MockZKVerifier();
        customVerifier  = new MockZKVerifier();

        vm.prank(factoryDeployer);
        factory = new AgentWalletFactory(address(defaultVerifier));
    }

    // ════════════════════════════════════════════════════════════
    //  Initial State
    // ════════════════════════════════════════════════════════════

    function test_initialState() public view {
        assertEq(factory.factoryOwner(), factoryDeployer);
        assertEq(factory.defaultZkVerifier(), address(defaultVerifier));
    }

    // ════════════════════════════════════════════════════════════
    //  createWallet
    // ════════════════════════════════════════════════════════════

    function test_createWallet_deploysWithCorrectParams() public {
        address walletAddr = factory.createWallet(alice, agentAlice, SALT_A);

        AgentWallet w = AgentWallet(payable(walletAddr));
        assertEq(w.owner(), alice);
        assertEq(w.agent(), agentAlice);
        assertEq(w.zkVerifier(), address(defaultVerifier));
    }

    function test_createWallet_registeredInIsWallet() public {
        address walletAddr = factory.createWallet(alice, agentAlice, SALT_A);
        assertTrue(factory.isWallet(walletAddr));
    }

    function test_createWallet_addedToOwnerList() public {
        factory.createWallet(alice, agentAlice, SALT_A);

        address[] memory wallets = factory.getWallets(alice);
        assertEq(wallets.length, 1);
    }

    function test_createWallet_incrementsWalletCount() public {
        assertEq(factory.walletCount(alice), 0);

        factory.createWallet(alice, agentAlice, SALT_A);
        assertEq(factory.walletCount(alice), 1);

        factory.createWallet(alice, agentAlice, SALT_B);
        assertEq(factory.walletCount(alice), 2);
    }

    function test_createWallet_emitsWalletCreatedEvent() public {
        // Predict address so we can include it in the expectEmit
        address predicted = factory.predictWalletAddress(alice, agentAlice, SALT_A);

        vm.expectEmit(true, true, true, true, address(factory));
        emit AgentWalletFactory.WalletCreated(predicted, alice, agentAlice, SALT_A);

        factory.createWallet(alice, agentAlice, SALT_A);
    }

    function test_createWallet_differentOwnersIsolated() public {
        factory.createWallet(alice, agentAlice, SALT_A);
        factory.createWallet(bob, agentBob, SALT_A); // same salt, different owner

        assertEq(factory.walletCount(alice), 1);
        assertEq(factory.walletCount(bob), 1);

        // wallets should be different addresses (salt includes owner)
        address walletAlice = factory.getWallets(alice)[0];
        address walletBob   = factory.getWallets(bob)[0];
        assertTrue(walletAlice != walletBob);
    }

    // ════════════════════════════════════════════════════════════
    //  createWalletWithVerifier
    // ════════════════════════════════════════════════════════════

    function test_createWalletWithVerifier_usesCustomVerifier() public {
        address walletAddr = factory.createWalletWithVerifier(
            alice, agentAlice, address(customVerifier), SALT_A
        );
        AgentWallet w = AgentWallet(payable(walletAddr));
        assertEq(w.zkVerifier(), address(customVerifier));
    }

    function test_createWalletWithVerifier_registeredInIsWallet() public {
        address walletAddr = factory.createWalletWithVerifier(
            alice, agentAlice, address(customVerifier), SALT_A
        );
        assertTrue(factory.isWallet(walletAddr));
    }

    function test_createWalletWithVerifier_noVerifier() public {
        address walletAddr = factory.createWalletWithVerifier(
            alice, agentAlice, address(0), SALT_A
        );
        AgentWallet w = AgentWallet(payable(walletAddr));
        assertEq(w.zkVerifier(), address(0));
    }

    // ════════════════════════════════════════════════════════════
    //  predictWalletAddress
    // ════════════════════════════════════════════════════════════

    function test_predictWalletAddress_matchesDeployed() public {
        address predicted = factory.predictWalletAddress(alice, agentAlice, SALT_A);
        address deployed  = factory.createWallet(alice, agentAlice, SALT_A);
        assertEq(predicted, deployed);
    }

    function test_predictWalletAddress_deterministicAcrossCalls() public view {
        address p1 = factory.predictWalletAddress(alice, agentAlice, SALT_A);
        address p2 = factory.predictWalletAddress(alice, agentAlice, SALT_A);
        assertEq(p1, p2);
    }

    function test_predictWalletAddress_differentSaltsDifferentAddresses() public view {
        address p1 = factory.predictWalletAddress(alice, agentAlice, SALT_A);
        address p2 = factory.predictWalletAddress(alice, agentAlice, SALT_B);
        assertTrue(p1 != p2);
    }

    // ════════════════════════════════════════════════════════════
    //  CREATE2 Determinism — duplicate deploy reverts
    // ════════════════════════════════════════════════════════════

    function test_createWallet_sameSaltRevertsOnSecondDeploy() public {
        factory.createWallet(alice, agentAlice, SALT_A);

        // Second deploy with identical (owner, agent, salt) must revert
        vm.expectRevert();
        factory.createWallet(alice, agentAlice, SALT_A);
    }

    // ════════════════════════════════════════════════════════════
    //  isWallet
    // ════════════════════════════════════════════════════════════

    function test_isWallet_falseForArbitraryAddress() public view {
        assertFalse(factory.isWallet(randomUser));
    }

    function test_isWallet_falseBeforeDeploy() public view {
        address predicted = factory.predictWalletAddress(alice, agentAlice, SALT_A);
        assertFalse(factory.isWallet(predicted));
    }

    function test_isWallet_trueAfterDeploy() public {
        address predicted = factory.predictWalletAddress(alice, agentAlice, SALT_A);
        factory.createWallet(alice, agentAlice, SALT_A);
        assertTrue(factory.isWallet(predicted));
    }

    // ════════════════════════════════════════════════════════════
    //  getWallets / walletCount
    // ════════════════════════════════════════════════════════════

    function test_getWallets_returnsAllForOwner() public {
        address w1 = factory.createWallet(alice, agentAlice, SALT_A);
        address w2 = factory.createWallet(alice, agentAlice, SALT_B);

        address[] memory wallets = factory.getWallets(alice);
        assertEq(wallets.length, 2);
        assertEq(wallets[0], w1);
        assertEq(wallets[1], w2);
    }

    function test_getWallets_emptyForNewOwner() public view {
        address[] memory wallets = factory.getWallets(randomUser);
        assertEq(wallets.length, 0);
    }

    function test_walletCount_zero_forNewOwner() public view {
        assertEq(factory.walletCount(randomUser), 0);
    }

    // ════════════════════════════════════════════════════════════
    //  setDefaultZkVerifier
    // ════════════════════════════════════════════════════════════

    function test_setDefaultZkVerifier_factoryOwnerOnly() public {
        vm.prank(factoryDeployer);
        factory.setDefaultZkVerifier(address(customVerifier));
        assertEq(factory.defaultZkVerifier(), address(customVerifier));
    }

    function test_setDefaultZkVerifier_emitsEvent() public {
        address oldVerifier = address(defaultVerifier);
        address newVerifier = address(customVerifier);

        vm.expectEmit(true, true, false, false, address(factory));
        emit AgentWalletFactory.DefaultVerifierUpdated(oldVerifier, newVerifier);

        vm.prank(factoryDeployer);
        factory.setDefaultZkVerifier(newVerifier);
    }

    function test_setDefaultZkVerifier_revertsIfNotFactoryOwner() public {
        vm.prank(randomUser);
        vm.expectRevert(AgentWalletFactory.NotFactoryOwner.selector);
        factory.setDefaultZkVerifier(address(customVerifier));
    }

    function test_setDefaultZkVerifier_revertsIfAlice() public {
        vm.prank(alice);
        vm.expectRevert(AgentWalletFactory.NotFactoryOwner.selector);
        factory.setDefaultZkVerifier(address(0));
    }

    // New wallets after verifier update use the new verifier
    function test_setDefaultZkVerifier_affectsNewWalletsOnly() public {
        // Deploy w1 with old verifier
        address w1 = factory.createWallet(alice, agentAlice, SALT_A);

        vm.prank(factoryDeployer);
        factory.setDefaultZkVerifier(address(customVerifier));

        // Deploy w2 with new verifier
        address w2 = factory.createWallet(alice, agentAlice, SALT_B);

        assertEq(AgentWallet(payable(w1)).zkVerifier(), address(defaultVerifier));
        assertEq(AgentWallet(payable(w2)).zkVerifier(), address(customVerifier));
    }

    // ════════════════════════════════════════════════════════════
    //  Fuzz Tests
    // ════════════════════════════════════════════════════════════

    function testFuzz_predictMatchesDeploy(address owner_, address agent_, bytes32 salt) public {
        // Avoid zero addresses (would still work, just make assumptions explicit)
        vm.assume(owner_ != address(0) && agent_ != address(0));

        address predicted = factory.predictWalletAddress(owner_, agent_, salt);
        address deployed  = factory.createWallet(owner_, agent_, salt);
        assertEq(predicted, deployed);
    }

    function testFuzz_walletCountIncrements(uint8 n) public {
        n = uint8(bound(n, 1, 10));
        for (uint256 i = 0; i < n; i++) {
            factory.createWallet(alice, agentAlice, bytes32(i));
        }
        assertEq(factory.walletCount(alice), n);
    }
}
