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
    signal input actionTypes[MAX_ACTIONS];
    signal input actionTokens[MAX_ACTIONS];
    signal input actionTargets[MAX_ACTIONS];
    signal input actionAmounts[MAX_ACTIONS];

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
        actionHashers[i] = Poseidon(4);
        actionHashers[i].inputs[0] <== actionTypes[i];
        actionHashers[i].inputs[1] <== actionTokens[i];
        actionHashers[i].inputs[2] <== actionTargets[i];
        actionHashers[i].inputs[3] <== actionAmounts[i];

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
        unused[i] * actionTypes[i] === 0;
        unused[i] * actionTokens[i] === 0;
        unused[i] * actionTargets[i] === 0;
        unused[i] * actionAmounts[i] === 0;
    }

    valid <== 1;
}

component main {public [commitment, chainId, signerAddress, actionCommitmentsRoot, nonce, expiry]} = IntentVerifierCore(4);
