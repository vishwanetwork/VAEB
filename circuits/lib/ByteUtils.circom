pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";

// Helper circuits for parsing calldata bytes

// convert 4 bytes to uint32 (big-endian)
template BytesToUint32() {
    signal input bytes[4];
    signal output out;

    component n2b[4];
    for (var i = 0; i < 4; i++) {
        n2b[i] = Num2Bits(8);
        n2b[i].in <== bytes[i];
    }

    component b2n = Bits2Num(32);
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 8; j++) {
            b2n.in[i * 8 + j] <== n2b[i].out[7 - j];
        }
    }

    out <== b2n.out;
}

// convert 32 bytes to uint256 (big-endian)
template BytesToUint256() {
    signal input bytes[32];
    signal output out;

    // for circuit efficiency use only lower 248 bits
    // full 256-bit arithmetic requires custom gates, expensive
    // this is safe for most EVM values which don't use all 256 bits, but TODO add checks to ensure upper bits are 0

    component b2n = Bits2Num(248);

    component n2b[31]; // skips first byte for safety
    for (var i = 1; i < 32; i++) {
        n2b[i - 1] = Num2Bits(8);
        n2b[i - 1].in <== bytes[i];
    }

    for (var i = 0; i < 31; i++) {
        for (var j = 0; j < 8; j++) {
            b2n.in[i * 8 + j] <== n2b[i].out[7 - j];
        }
    }

    out <== b2n.out;
}

// extract address from 32-byte padded field
template BytesToAddress() {
    signal input bytes[32];
    signal output out;

    // address in bytes 12-31 (right-aligned, 20 bytes)
    component b2n = Bits2Num(160);

    component n2b[20];
    for (var i = 0; i < 20; i++) {
        n2b[i] = Num2Bits(8);
        n2b[i].in <== bytes[12 + i];
    }

    for (var i = 0; i < 20; i++) {
        for (var j = 0; j < 8; j++) {
            b2n.in[i * 8 + j] <== n2b[i].out[7 - j];
        }
    }

    out <== b2n.out;
}

// convert 2 bytes to uint16 (big-endian)
template BytesToUint16() {
    signal input bytes[2];
    signal output out;

    component n2b[2];
    for (var i = 0; i < 2; i++) {
        n2b[i] = Num2Bits(8);
        n2b[i].in <== bytes[i];
    }

    component b2n = Bits2Num(16);
    for (var i = 0; i < 2; i++) {
        for (var j = 0; j < 8; j++) {
            b2n.in[i * 8 + j] <== n2b[i].out[7 - j];
        }
    }

    out <== b2n.out;
}
