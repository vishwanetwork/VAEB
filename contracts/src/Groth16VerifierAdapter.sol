// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";

/**
 * @title ISnarkjsVerifier
 * @notice Interface matching what snarkjs `zkey export solidityverifier` generates.
 *         snarkjs produces 6 public inputs + 1 output signal = 7 public signals total.
 */
interface ISnarkjsVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[7] calldata _pubSignals
    ) external view returns (bool);
}

/**
 * @title Groth16VerifierAdapter
 * @notice Wraps the snarkjs-generated verifier to implement IGroth16Verifier.
 *
 * AgentWallet calls:
 *   IGroth16Verifier.verifyProof(bytes proof, uint256[] pubInputs)
 *     where pubInputs has 6 elements (commitment, chainId, signer, callsHash, nonce, expiry)
 *
 * snarkjs generates:
 *   verifyProof(uint[2] _pA, uint[2][2] _pB, uint[2] _pC, uint[7] _pubSignals)
 *     where _pubSignals[0] is the output signal (valid), and _pubSignals[1..6] are the 6 public inputs
 *     (snarkjs orders signals as: [outputs, ...public_inputs])
 *
 * This adapter decodes the proof, prepends the output signal (which is always 1
 * when constraints are satisfied), and forwards to the real verifier.
 */
contract Groth16VerifierAdapter is IGroth16Verifier {
    ISnarkjsVerifier public immutable realVerifier;

    constructor(address _realVerifier) {
        realVerifier = ISnarkjsVerifier(_realVerifier);
    }

    function verifyProof(
        bytes calldata proof,
        uint256[] memory pubInputs
    ) external view override returns (bool) {
        require(pubInputs.length == 6, "Expected 6 public inputs");

        // Decode proof bytes into Groth16 proof points
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));

        // Build 7-element array: output signal FIRST, then 6 public inputs
        // snarkjs ordering: [output(valid), commitment, chainId, signer, callsHash, nonce, expiry]
        uint[7] memory signals;
        signals[0] = 1; // The circuit output `valid` is always 1 when constraints pass
        for (uint i = 0; i < 6; i++) {
            signals[i + 1] = pubInputs[i];
        }

        return realVerifier.verifyProof(pA, pB, pC, signals);
    }
}
