pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";

// Universal action proof
template ActionProof() {
    // Public input
    signal input actionCommitment; // Poseidon(10) hash of the 10 action fields

    // Private witness
    // action fields (unused fields = 0)
    signal input field0;
    signal input field1;
    signal input field2;
    signal input field3;
    signal input field4;
    signal input field5;
    signal input field6;
    signal input field7;
    signal input field8;
    signal input field9;

    signal output valid;

    // verify action commitment hash
    component actionHasher = Poseidon(10);
    actionHasher.inputs[0] <== field0;
    actionHasher.inputs[1] <== field1;
    actionHasher.inputs[2] <== field2;
    actionHasher.inputs[3] <== field3;
    actionHasher.inputs[4] <== field4;
    actionHasher.inputs[5] <== field5;
    actionHasher.inputs[6] <== field6;
    actionHasher.inputs[7] <== field7;
    actionHasher.inputs[8] <== field8;
    actionHasher.inputs[9] <== field9;

    actionCommitment === actionHasher.out;

    valid <== 1;
}

component main {public [actionCommitment]} = UniversalActionProof();
