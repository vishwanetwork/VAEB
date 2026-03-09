pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../lib/ByteUtils.circom";

// Action: { type: SWAP, token: 0xTokenIn, to: 0xUniswapRouter, amount: 100 }
// 1. tokenIn.approve(router, amount)
//    calldata: 0x095ea7b3 + abi.encode(spender, amount)
// 2. router.exactInputSingle(params)
//    calldata: 0x414bf389 + abi.encode(tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMin, sqrtPriceLimitX96)
template SwapProof() {
    var APPROVE_SELECTOR = 0x095ea7b3; // approve(address,uint256)
    var EXACT_INPUT_SINGLE_SELECTOR = 0x414bf389; // exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
    var APPROVE_LENGTH = 68; // 4 + 32 + 32 bytes
    var SWAP_LENGTH = 260; // 4 + 32*8 (struct with 8 fields)

    // Public inputs
    signal input actionCommitment; // Poseidon(0, tokenIn, router, amountIn)
    signal input call1Commitment; // Poseidon(calldataByte sof approve)
    signal input call2Commitment; // Poseidon(calldataBytes of exactInputSingle)

    // Private witness
    // action data
    signal input actionType; // should be 0 (SWAP)
    signal input tokenIn; // input token address
    signal input router; // Uniswap V3 Router address
    signal input amountIn; // input amount

    // swap params
    signal input tokenOut; // otput token address
    signal input fee; // pool fee (500, 3000, or 10000)
    signal input recipient; // recipient address (AgentWallet)
    signal input deadline; // deadline timestamp
    signal input amountOutMin; // minimum output amount
    signal input sqrtPriceLimitX96; // price limit

    // calldata
    signal input call1Bytes[APPROVE_LENGTH];
    signal input call2Bytes[SWAP_LENGTH];

    signal output valid;

    // 1. Verify action commitment
    component actionHasher = Poseidon(4);
    actionHasher.inputs[0] <== actionType;
    actionHasher.inputs[1] <== tokenIn;
    actionHasher.inputs[2] <== router;
    actionHasher.inputs[3] <== amountIn;

    actionCommitment === actionHasher.out;

    // 2. Verify Call 1 (approve)
    // selector
    component approveSelectorCheck = BytesToUint32();
    for (var i = 0; i < 4; i++) {
        approveSelectorCheck.bytes[i] <== call1Bytes[i];
    }
    approveSelectorCheck.out === APPROVE_SELECTOR;

    // spender address i.e. router
    component spenderCheck = BytesToAddress();
    for (var i = 0; i < 32; i++) {
        spenderCheck.bytes[i] <== call1Bytes[4 + i];
    }
    spenderCheck.out === router;

    // amount
    component approveAmountCheck = BytesToUint256();
    for (var i = 0; i < 32; i++) {
        approveAmountCheck.bytes[i] <== call1Bytes[36 + i];
    }
    approveAmountCheck.out === amountIn;

    // commitment - hash in chunks
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

    // 3.Verify Call 2 (exactInputSingle)
    // selector
    component swapSelectorCheck = BytesToUint32();
    for (var i = 0; i < 4; i++) {
        swapSelectorCheck.bytes[i] <== call2Bytes[i];
    }
    swapSelectorCheck.out === EXACT_INPUT_SINGLE_SELECTOR;

    // struct ExactInputSingleParams {
    //     address tokenIn; // bytes 4-35
    //     address tokenOut; // bytes 36-67
    //     uint24 fee; // bytes 68-99 (right-aligned)
    //     address recipient; // bytes 100-131
    //     uint256 deadline; // bytes 132-163
    //     uint256 amountIn; // bytes 164-195
    //     uint256 amountOutMin; // bytes 196-227
    //     uint160 sqrtPriceLimitX96; // bytes 228-259 (right-aligned)
    // }

    // tokenIn
    component tokenInCheck = BytesToAddress();
    for (var i = 0; i < 32; i++) {
        tokenInCheck.bytes[i] <== call2Bytes[4 + i];
    }
    tokenInCheck.out === tokenIn;

    // tokenOut
    component tokenOutCheck = BytesToAddress();
    for (var i = 0; i < 32; i++) {
        tokenOutCheck.bytes[i] <== call2Bytes[36 + i];
    }
    tokenOutCheck.out === tokenOut;

    // fee (uint24 in last 3 bytes of 32-byte slot)
    // need verification?

    // recipient i.e. AgentWallet
    component recipientCheck = BytesToAddress();
    for (var i = 0; i < 32; i++) {
        recipientCheck.bytes[i] <== call2Bytes[100 + i];
    }
    recipientCheck.out === recipient;

    // deadline
    component deadlineCheck = BytesToUint256();
    for (var i = 0; i < 32; i++) {
        deadlineCheck.bytes[i] <== call2Bytes[132 + i];
    }
    deadlineCheck.out === deadline;

    // amountIn
    component amountInCheck = BytesToUint256();
    for (var i = 0; i < 32; i++) {
        amountInCheck.bytes[i] <== call2Bytes[164 + i];
    }
    amountInCheck.out === amountIn;

    // amountOutMin
    component amountOutMinCheck = BytesToUint256();
    for (var i = 0; i < 32; i++) {
        amountOutMinCheck.bytes[i] <== call2Bytes[196 + i];
    }
    amountOutMinCheck.out === amountOutMin;

    // sqrtPriceLimitX96
    // TODO: Add proper uint160 extraction

    // commitment - hash call2 in chunks (260 bytes = 16*16 + 4)
    component call2chunks[17];
    for (var i = 0; i < 16; i++) {
        call2chunks[i] = Poseidon(16);
        for (var j = 0; j < 16; j++) {
            call2chunks[i].inputs[j] <== call2Bytes[i*16 + j];
        }
    }
    // last chunk = 4 bytes
    call2chunks[16] = Poseidon(4);
    for (var i = 0; i < 4; i++) {
        call2chunks[16].inputs[i] <== call2Bytes[256 + i];
    }
    // hash all chunks together
    component call2level1 = Poseidon(16);
    for (var i = 0; i < 16; i++) {
        call2level1.inputs[i] <== call2chunks[i].out;
    }
    component call2Hasher = Poseidon(2);
    call2Hasher.inputs[0] <== call2level1.out;
    call2Hasher.inputs[1] <== call2chunks[16].out;
    call2Commitment === call2Hasher.out;

    valid <== 1;
}

component main {public [actionCommitment, call1Commitment, call2Commitment]} = SwapProof();
