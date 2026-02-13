// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ECDSA — Elliptic Curve Digital Signature Algorithm
 * @notice Minimal ECDSA recovery library for EIP-712 signature verification
 */
library ECDSA {
    error ECDSAInvalidSignature();
    error ECDSAInvalidSignatureLength(uint256 length);
    error ECDSAInvalidSignatureS(bytes32 s);

    /**
     * @notice Recover the signer address from a message digest and signature
     */
    function recover(bytes32 hash, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) {
            revert ECDSAInvalidSignatureLength(signature.length);
        }

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        // EIP-2: restrict s to lower half order
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert ECDSAInvalidSignatureS(s);
        }

        if (v != 27 && v != 28) {
            revert ECDSAInvalidSignature();
        }

        address signer = ecrecover(hash, v, r, s);
        if (signer == address(0)) {
            revert ECDSAInvalidSignature();
        }

        return signer;
    }
}
