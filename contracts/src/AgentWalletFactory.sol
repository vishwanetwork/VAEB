// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentWallet} from "./AgentWallet.sol";

/**
 * @title AgentWalletFactory
 * @notice Factory for deploying AgentWallet instances using CREATE2
 *         for deterministic addresses across chains.
 */
contract AgentWalletFactory {
    // ─── Events ─────────────────────────────────────────────────

    event WalletCreated(
        address indexed wallet,
        address indexed owner,
        address indexed agent,
        bytes32 salt
    );

    event DefaultVerifierUpdated(
        address indexed oldVerifier, 
        address indexed newVerifier
    );

    // ─── State ──────────────────────────────────────────────────

    address public factoryOwner;
    address public defaultZkVerifier;
    mapping(address => address[]) public walletsByOwner;
    mapping(address => bool) public isWallet;

    // ─── Constructor ────────────────────────────────────────────

    constructor(address _defaultZkVerifier) {
        factoryOwner = msg.sender;
        defaultZkVerifier = _defaultZkVerifier;
    }

    // Errors
    error NotFactoryOwner();

    // ─── Create Wallet ──────────────────────────────────────────

    /**
     * @notice Deploy a new AgentWallet with CREATE2 for deterministic addresses
     * @param owner      The wallet owner (user)
     * @param agent      The authorized agent address
     * @param salt       Salt for CREATE2 deterministic deployment
     */
    function createWallet(
        address owner,
        address agent,
        bytes32 salt
    ) external returns (address wallet) {
        bytes32 finalSalt = keccak256(abi.encode(owner, agent, salt));

        wallet = address(
            new AgentWallet{salt: finalSalt}(owner, agent, defaultZkVerifier)
        );

        walletsByOwner[owner].push(wallet);
        isWallet[wallet] = true;

        emit WalletCreated(wallet, owner, agent, salt);
    }

    /**
     * @notice Deploy a wallet with a custom ZK verifier
     */
    function createWalletWithVerifier(
        address owner,
        address agent,
        address zkVerifier,
        bytes32 salt
    ) external returns (address wallet) {
        bytes32 finalSalt = keccak256(abi.encode(owner, agent, salt));

        wallet = address(
            new AgentWallet{salt: finalSalt}(owner, agent, zkVerifier)
        );

        walletsByOwner[owner].push(wallet);
        isWallet[wallet] = true;

        emit WalletCreated(wallet, owner, agent, salt);
    }

    // ─── Predict Address ────────────────────────────────────────

    /**
     * @notice Predict the address of a wallet before deployment
     */
    function predictWalletAddress(
        address owner,
        address agent,
        bytes32 salt
    ) external view returns (address predicted) {
        bytes32 finalSalt = keccak256(abi.encode(owner, agent, salt));

        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                finalSalt,
                keccak256(
                    abi.encodePacked(
                        type(AgentWallet).creationCode,
                        abi.encode(owner, agent, defaultZkVerifier)
                    )
                )
            )
        );

        return address(uint160(uint256(hash)));
    }

    // ─── View ───────────────────────────────────────────────────

    function getWallets(address owner) external view returns (address[] memory) {
        return walletsByOwner[owner];
    }

    function walletCount(address owner) external view returns (uint256) {
        return walletsByOwner[owner].length;
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setDefaultZkVerifier(address newVerifier) external {
        if (msg.sender != factoryOwner) revert NotFactoryOwner();
        address old = defaultZkVerifier;
        defaultZkVerifier = newVerifier;
        emit DefaultVerifierUpdated(old, newVerifier);
    }
}
