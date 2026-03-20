pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

template IntentVerifierCore(MAX_ACTIONS) {
    // Public inputs
    signal input commitment;
    signal input chainId;
    signal input signerAddress;
    signal input nonce;
    signal input expiry;

    // Private witness
    // IntentBundle fields
    signal input version;
    signal input payer;
    signal input numActions;

    // per-action fields
    // SWAP: [0, tokenIn, tokenOut, router, fee, recipient, deadline, amountIn, amountOutMin, sqrtPriceLimitX96]
    // TRANSFER: [1, token, recipient, amount, 0, 0, 0, 0, 0, 0]
    // APPROVE: [2, token, spender, amount, 0, 0, 0, 0, 0, 0]
    // DEPOSIT: [3, token, pool, amount, onBehalfOf, referralCode, 0, 0, 0, 0]
    // WITHDRAW: [4, token, pool, amount, recipient, 0, 0, 0, 0, 0]
    // BORROW: [5, asset, pool, amount, interestRateMode, referralCode, onBehalfOf, 0, 0, 0]
    // REPAY: [6, asset, pool, amount, interestRateMode, onBehalfOf, 0, 0, 0, 0]
    // STAKE: [7, lidoContract, recipient, amount, referral, 0, 0, 0, 0, 0]
    // UNSTAKE: [8, lidoContract, stETHAmount, recipient, 0, 0, 0, 0, 0, 0]
    signal input actionFields[MAX_ACTIONS][10];

    // action commitments (output from each action proof)
    signal input actionCommitments[MAX_ACTIONS];

    signal output valid;

    // 1. Verify bundle commitment
    component bundleHasher = Poseidon(6);
    bundleHasher.inputs[0] <== version;
    bundleHasher.inputs[1] <== chainId;
    bundleHasher.inputs[2] <== nonce;
    bundleHasher.inputs[3] <== expiry;
    bundleHasher.inputs[4] <== payer;
    bundleHasher.inputs[5] <== numActions;

    // Hash each action
    component actionHashers[MAX_ACTIONS];
    component actionAccumulator = Poseidon(MAX_ACTIONS + 1);
    actionAccumulator.inputs[0] <== bundleHasher.out;

    for (var i = 0; i < MAX_ACTIONS; i++) {
        actionHashers[i] = Poseidon(10);
        for (var j = 0; j < 10; j++) {
            actionHashers[i].inputs[j] <== actionFields[i][j];
        }

        actionAccumulator.inputs[i + 1] <== actionHashers[i].out;
    }

    commitment === actionAccumulator.out;

    // 2. Verify action commitments match actions
    for (var i = 0; i < MAX_ACTIONS; i++) {
        actionCommitments[i] === actionHashers[i].out;
    }

    // 3. Bounds checks
    // numActions <= MAX_ACTIONS
    component numActionsCheck = LessEqThan(8);
    numActionsCheck.in[0] <== numActions;
    numActionsCheck.in[1] <== MAX_ACTIONS;
    numActionsCheck.out === 1;

    // verify that unused action slots are zeroed
    component actionUsed[MAX_ACTIONS];
    signal unused[MAX_ACTIONS];
    for (var i = 0; i < MAX_ACTIONS; i++) {
        actionUsed[i] = LessThan(8);
        actionUsed[i].in[0] <== i;
        actionUsed[i].in[1] <== numActions;

        unused[i] <== 1 - actionUsed[i].out;
        for (var j = 0; j < 10; j++) {
            unused[i] * actionFields[i][j] === 0;
        }
    }

    valid <== 1;
}

component main {public [commitment, chainId, signerAddress, nonce, expiry]} = IntentVerifierCore(4);
