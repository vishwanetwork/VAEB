pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../lib/ByteUtils.circom";

// Action: { type: TRANSFER, token: 0xToken, to: 0xRecipient, amount: 100 }
// token.transfer(recipient, amount)
// calldata: 0xa9059cbb + abi.encode(recipient, amount)
template TransferProof() {
    var TRANSFER_SELECTOR = 0xa9059cbb; // transfer(address,uint256)
    var CALLDATA_LENGTH = 68;           // 4 + 32 + 32 bytes

    // Public inputs
    signal input actionCommitment; // poseidon(1, token, recipient, amount)
    signal input calldataCommitment; // poseidon(calldataBytes)

    // Private witness
    // action data
    signal input actionType; // should be 1 (TRANSFER)
    signal input token; // token contract address
    signal input recipient; // recipient address
    signal input amount; // amount to transfer

    // calldata
    signal input calldataBytes[CALLDATA_LENGTH];

    signal output valid;

    // 1. Verify action commitment
    component actionHasher = Poseidon(4);
    actionHasher.inputs[0] <== actionType;
    actionHasher.inputs[1] <== token;
    actionHasher.inputs[2] <== recipient;
    actionHasher.inputs[3] <== amount;

    actionCommitment === actionHasher.out;

    // 2. Verify calldata structure
    // selector
    component selectorExtractor = BytesToUint32();
    for (var i = 0; i < 4; i++) {
        selectorExtractor.bytes[i] <== calldataBytes[i];
    }
    selectorExtractor.out === TRANSFER_SELECTOR;

    // recipient address
    component recipientExtractor = BytesToAddress();
    for (var i = 0; i < 32; i++) {
        recipientExtractor.bytes[i] <== calldataBytes[4 + i];
    }
    recipientExtractor.out === recipient;

    // amount
    component amountExtractor = BytesToUint256();
    for (var i = 0; i < 32; i++) {
        amountExtractor.bytes[i] <== calldataBytes[36 + i];
    }
    amountExtractor.out === amount;

    // 3. Verify calldata commitment

    // hash in chunks
    component chunk1 = Poseidon(16);
    for (var i = 0; i < 16; i++) {
        chunk1.inputs[i] <== calldataBytes[i];
    }

    component chunk2 = Poseidon(16);
    for (var i = 0; i < 16; i++) {
        chunk2.inputs[i] <== calldataBytes[16 + i];
    }

    component chunk3 = Poseidon(16);
    for (var i = 0; i < 16; i++) {
        chunk3.inputs[i] <== calldataBytes[32 + i];
    }

    component chunk4 = Poseidon(16);
    for (var i = 0; i < 16; i++) {
        chunk4.inputs[i] <== calldataBytes[48 + i];
    }

    component chunk5 = Poseidon(4);
    for (var i = 0; i < 4; i++) {
        chunk5.inputs[i] <== calldataBytes[64 + i];
    }

    // Final hash combining all chunks
    component calldataHasher = Poseidon(5);
    calldataHasher.inputs[0] <== chunk1.out;
    calldataHasher.inputs[1] <== chunk2.out;
    calldataHasher.inputs[2] <== chunk3.out;
    calldataHasher.inputs[3] <== chunk4.out;
    calldataHasher.inputs[4] <== chunk5.out;

    calldataCommitment === calldataHasher.out;

    valid <== 1;
}

component main {public [actionCommitment, calldataCommitment]} = TransferProof();
