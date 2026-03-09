pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../lib/ByteUtils.circom";

// Action: { type: DEPOSIT, token: 0xUSDC, to: 0xAavePool, amount: 100e6 }
// 1. token.approve(aavePool, amount)
//    calldata: 0x095ea7b3 + abi.encode(spender, amount)
// 2. aavePool.supply(asset, amount, onBehalfOf, referralCode)
//    calldata: 0x617ba037 + abi.encode(asset, amount, onBehalfOf, 0)

template DepositProof() {
    var APPROVE_SELECTOR = 0x095ea7b3; // approve(address,uint256)
    var SUPPLY_SELECTOR = 0x617ba037; // supply(address,uint256,address,uint16)
    var APPROVE_LENGTH = 68; // 4 + 32 + 32
    var SUPPLY_LENGTH = 132; // 4 + 32 + 32 + 32 + 32

    // Public inputs
    signal input actionCommitment; // poseidon(3, token, pool, amount)
    signal input call1Commitment; // poseidon(calldataBytes of approve)
    signal input call2Commitment; // poseidon(calldataBytes of supply)

    // Private witness
    // action data
    signal input actionType; // should be 3 (DEPOSIT)
    signal input token; // token to deposit
    signal input pool; // lending pool address (Aave)
    signal input amount; // amount to deposit
    signal input onBehalfOf; // recipient of aTokens (AgentWallet)

    //calldata
    signal input call1Bytes[APPROVE_LENGTH];
    signal input call2Bytes[SUPPLY_LENGTH];

    signal output valid;

    // 1. Verify action commitment
    component actionHasher = Poseidon(4);
    actionHasher.inputs[0] <== actionType;
    actionHasher.inputs[1] <== token;
    actionHasher.inputs[2] <== pool;
    actionHasher.inputs[3] <== amount;

    actionCommitment === actionHasher.out;

    // 2. Verify Call 1 (approve)
    // selector
    component approveSelectorCheck = BytesToUint32();
    for (var i = 0; i < 4; i++) {
        approveSelectorCheck.bytes[i] <== call1Bytes[i];
    }
    approveSelectorCheck.out === APPROVE_SELECTOR;

    // spender (pool address)
    component spenderCheck = BytesToAddress();
    for (var i = 0; i < 32; i++) {
        spenderCheck.bytes[i] <== call1Bytes[4 + i];
    }
    spenderCheck.out === pool;

    // amount
    component approveAmountCheck = BytesToUint256();
    for (var i = 0; i < 32; i++) {
        approveAmountCheck.bytes[i] <== call1Bytes[36 + i];
    }
    approveAmountCheck.out === amount;

    // commitment
    // hash call1 in chunks
    component call1chunk1 = Poseidon(16);
    for (var i = 0; i < 16; i++) {
        call1chunk1.inputs[i] <== call1Bytes[i];
    }
    component call1chunk2 = Poseidon(16);
    for (var i = 0; i < 16; i++) {
        call1chunk2.inputs[i] <== call1Bytes[16 + i];
    }
    component call1chunk3 = Poseidon(16);
    for (var i = 0; i < 16; i++) {
        call1chunk3.inputs[i] <== call1Bytes[32 + i];
    }
    component call1chunk4 = Poseidon(16);
    for (var i = 0; i < 16; i++) {
        call1chunk4.inputs[i] <== call1Bytes[48 + i];
    }
    component call1chunk5 = Poseidon(4);
    for (var i = 0; i < 4; i++) {
        call1chunk5.inputs[i] <== call1Bytes[64 + i];
    }
    component call1Hasher = Poseidon(5);
    call1Hasher.inputs[0] <== call1chunk1.out;
    call1Hasher.inputs[1] <== call1chunk2.out;
    call1Hasher.inputs[2] <== call1chunk3.out;
    call1Hasher.inputs[3] <== call1chunk4.out;
    call1Hasher.inputs[4] <== call1chunk5.out;
    call1Commitment === call1Hasher.out;

    // 3. Verify Call 2 (supply)
    // selector
    component supplySelectorCheck = BytesToUint32();
    for (var i = 0; i < 4; i++) {
        supplySelectorCheck.bytes[i] <== call2Bytes[i];
    }
    supplySelectorCheck.out === SUPPLY_SELECTOR;

    // asset (token address)
    component assetCheck = BytesToAddress();
    for (var i = 0; i < 32; i++) {
        assetCheck.bytes[i] <== call2Bytes[4 + i];
    }
    assetCheck.out === token;

    // amount
    component supplyAmountCheck = BytesToUint256();
    for (var i = 0; i < 32; i++) {
        supplyAmountCheck.bytes[i] <== call2Bytes[36 + i];
    }
    supplyAmountCheck.out === amount;

    // onBehalfOf (AgentWallet)
    component onBehalfOfCheck = BytesToAddress();
    for (var i = 0; i < 32; i++) {
        onBehalfOfCheck.bytes[i] <== call2Bytes[68 + i];
    }
    onBehalfOfCheck.out === onBehalfOf;

    // referral code (should be 0)
    component referralCheck = BytesToUint16();
    for (var i = 0; i < 2; i++) {
        referralCheck.bytes[i] <== call2Bytes[100 + 30 + i]; // right-aligned
    }
    referralCheck.out === 0;

    // commitment - hash call2 in chunks 
    // 132 bytes = 8*16 + 4
    component call2chunks[9];
    for (var i = 0; i < 8; i++) {
        call2chunks[i] = Poseidon(16);
        for (var j = 0; j < 16; j++) {
            call2chunks[i].inputs[j] <== call2Bytes[i*16 + j];
        }
    }
    // last chunk: 4 bytes
    call2chunks[8] = Poseidon(4);
    for (var i = 0; i < 4; i++) {
        call2chunks[8].inputs[i] <== call2Bytes[128 + i];
    }
    // hash all chunks together
    component call2level1 = Poseidon(8);
    for (var i = 0; i < 8; i++) {
        call2level1.inputs[i] <== call2chunks[i].out;
    }
    component call2Hasher = Poseidon(2);
    call2Hasher.inputs[0] <== call2level1.out;
    call2Hasher.inputs[1] <== call2chunks[8].out;
    call2Commitment === call2Hasher.out;

    valid <== 1;
}

component main {public [actionCommitment, call1Commitment, call2Commitment]} = DepositProof();
