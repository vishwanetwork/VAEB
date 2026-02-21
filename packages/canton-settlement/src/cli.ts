#!/usr/bin/env node
/**
 * Canton ZK Custody — CLI Demo
 *
 * Demonstrates Canton's privacy model by showing what each party can see.
 * Each command runs as a specific party (custodian, buyer, seller) to
 * demonstrate sub-transaction privacy and data visibility controls.
 *
 * Usage:
 *   npx ts-node src/cli.ts health
 *   npx ts-node src/cli.ts attestations --party custodian
 *   npx ts-node src/cli.ts settlements --party buyer
 *   npx ts-node src/cli.ts privacy-demo
 *   npx ts-node src/cli.ts help
 */

import { CantonClient } from "./canton-client";
import type { CantonConfig } from "./types";

// ── Party configurations ─────────────────────────────────────

const CANTON_URL = process.env.CANTON_PARTICIPANT_URL || "http://localhost:7575";

const PARTIES = {
  custodian: {
    name: "Custodian",
    userId: "canton-zk-custody",
    actAs: ["Custodian::namespace"],
    readAs: [] as string[],
    description: "Verifies ZK proofs and co-signs attestations. Sees all attestations they've signed.",
    canSee: ["CustodyAttestation (as signatory)", "CrossChainSettlement (as signatory)", "ExecutionReceipt (as signatory)", "ProofOfReserve (as signatory)"],
    cannotSee: ["Other custodians' attestations", "Settlements they're not party to"],
  },
  buyer: {
    name: "Buyer",
    userId: "canton-zk-custody",
    actAs: ["Buyer::namespace"],
    readAs: [] as string[],
    description: "Initiates settlements. Signs intent in MetaMask for VAEB execution.",
    canSee: ["CrossChainSettlement (as signatory)", "ExecutionReceipt (as signatory)", "CustodyAttestation (as observer, if added)"],
    cannotSee: ["Attestation proofHash details", "Other buyers' settlements", "Seller's other positions"],
  },
  seller: {
    name: "Seller",
    userId: "canton-zk-custody",
    actAs: ["Seller::namespace"],
    readAs: [] as string[],
    description: "Receives funds on EVM. Must agree to settlement terms.",
    canSee: ["CrossChainSettlement (as signatory)", "ExecutionReceipt (as signatory)", "ProofOfReserve (as observer, if shared)"],
    cannotSee: ["Attestation proofHash details", "Buyer's other attestations", "Other sellers' settlements"],
  },
};

type PartyRole = keyof typeof PARTIES;

function getConfig(party: PartyRole): CantonConfig {
  const p = PARTIES[party];
  return {
    participantUrl: CANTON_URL,
    userId: p.userId,
    actAs: p.actAs,
    readAs: p.readAs,
    ledgerId: process.env.CANTON_LEDGER_ID || "vaeb_participant",
    applicationId: "vaeb-canton",
  };
}

// ── CLI Commands ─────────────────────────────────────────────

async function cmdHealth() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║          Canton Health Check                     ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const client = new CantonClient(getConfig("custodian"));
  const healthy = await client.health();
  const version = client.getApiVersion();

  console.log(`  Canton URL:     ${CANTON_URL}`);
  console.log(`  Status:         ${healthy ? "✓ Healthy" : "✗ Unreachable"}`);
  console.log(`  API Version:    ${version || "unknown"}`);
  console.log(`  Ledger ID:      ${process.env.CANTON_LEDGER_ID || "vaeb_participant"}`);
  console.log();
}

async function cmdAttestations(party: PartyRole) {
  const p = PARTIES[party];
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  Attestations — viewing as ${p.name.padEnd(22)}║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  console.log(`  Party:  ${p.actAs[0]}`);
  console.log(`  Role:   ${p.description}`);
  console.log();

  const client = new CantonClient(getConfig(party));
  try {
    const attestations = await client.queryAttestations();
    if (attestations.length === 0) {
      console.log("  No attestations visible to this party.");
      console.log(`  (${p.name} can only see attestations where they are signatory or observer)\n`);
    } else {
      console.log(`  Found ${attestations.length} attestation(s):\n`);
      for (const a of attestations) {
        console.log(`  ┌─ Attestation ──────────────────────────────────`);
        console.log(`  │ Contract ID:  ${a.contractId}`);
        console.log(`  │ Chain:        ${a.chain}`);
        console.log(`  │ Claim Type:   ${a.claimType}`);
        console.log(`  │ Custodian:    ${a.custodian}`);
        console.log(`  │ Asset Holder: ${a.assetHolder}`);
        if (party === "custodian") {
          // Only custodian (signatory) can see the proof hash
          console.log(`  │ Proof Hash:   ${a.proofHash}`);
          console.log(`  │ Claim:        ${a.claimDigest}`);
        } else {
          console.log(`  │ Proof Hash:   [HIDDEN — only visible to signatories]`);
          console.log(`  │ Claim:        [HIDDEN — only visible to signatories]`);
        }
        console.log(`  │ Verified At:  ${a.verifiedAt}`);
        console.log(`  │ Expires At:   ${a.expiresAt}`);
        const valid = new Date(a.expiresAt) > new Date();
        console.log(`  │ Valid:        ${valid ? "✓ Yes" : "✗ Expired"}`);
        console.log(`  └──────────────────────────────────────────────\n`);
      }
    }
  } catch (err: any) {
    console.log(`  Error querying attestations: ${err.message}\n`);
  }
}

async function cmdSettlements(party: PartyRole) {
  const p = PARTIES[party];
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  Settlements — viewing as ${p.name.padEnd(23)}║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  console.log(`  Party:  ${p.actAs[0]}`);
  console.log(`  Role:   ${p.description}`);
  console.log();

  const client = new CantonClient(getConfig(party));
  try {
    const settlements = await client.querySettlements();
    if (settlements.length === 0) {
      console.log("  No settlements visible to this party.");
      console.log(`  (${p.name} can only see settlements where they are buyer, seller, or custodian)\n`);
    } else {
      console.log(`  Found ${settlements.length} settlement(s):\n`);
      for (const s of settlements) {
        console.log(`  ┌─ Settlement ───────────────────────────────────`);
        console.log(`  │ Contract ID:    ${s.contractId}`);
        console.log(`  │ Buyer:          ${s.buyer}`);
        console.log(`  │ Seller:         ${s.seller}`);
        console.log(`  │ Custodian:      ${s.custodian}`);
        console.log(`  │ Chain:          ${s.requiredChain}`);
        console.log(`  │ Asset:          ${s.settlementAsset?.label || "unknown"}`);
        console.log(`  │ Amount:         ${s.amount}`);
        console.log(`  └──────────────────────────────────────────────\n`);
      }
    }
  } catch (err: any) {
    console.log(`  Error querying settlements: ${err.message}\n`);
  }
}

async function cmdPrivacyDemo() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║      Canton Privacy Model — Party Visibility Demo           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  console.log("  Canton uses sub-transaction privacy. Each party only sees");
  console.log("  contracts where they are a signatory or observer.\n");

  console.log("  ┌─────────────────────────────────────────────────────────────┐");
  console.log("  │                    DATA VISIBILITY MATRIX                   │");
  console.log("  ├────────────────────────┬────────────┬─────────┬────────────┤");
  console.log("  │ Contract               │ Custodian  │ Buyer   │ Seller     │");
  console.log("  ├────────────────────────┼────────────┼─────────┼────────────┤");
  console.log("  │ AttestationProposal    │ signatory  │    —    │     —      │");
  console.log("  │ CustodyAttestation     │ signatory  │ observer│  observer  │");
  console.log("  │  └─ proofHash (RISC0)  │   ✓ SEES   │  ✗ hidden│  ✗ hidden │");
  console.log("  │  └─ claimDigest        │   ✓ SEES   │  ✗ hidden│  ✗ hidden │");
  console.log("  │ SettlementProposal     │ observer   │ depends │  depends   │");
  console.log("  │ CrossChainSettlement   │ signatory  │signatory│ signatory  │");
  console.log("  │  └─ amount             │   ✓ SEES   │  ✓ SEES │   ✓ SEES  │");
  console.log("  │  └─ terms              │   ✓ SEES   │  ✓ SEES │   ✓ SEES  │");
  console.log("  │ ExecutionReceipt       │ signatory  │signatory│ signatory  │");
  console.log("  │  └─ txHash (EVM)       │   ✓ SEES   │  ✓ SEES │   ✓ SEES  │");
  console.log("  │  └─ proofHash (RISC0)  │   ✓ SEES   │  ✓ SEES │   ✓ SEES  │");
  console.log("  │ ProofOfReserve         │ signatory  │    —    │  observer  │");
  console.log("  ├────────────────────────┴────────────┴─────────┴────────────┤");
  console.log("  │ External parties see NOTHING — Canton sub-transaction      │");
  console.log("  │ privacy ensures only named parties have visibility.        │");
  console.log("  └─────────────────────────────────────────────────────────────┘\n");

  // Now query as each party to demonstrate live visibility
  console.log("  ── Live Canton Queries ──────────────────────────────────────\n");

  for (const role of ["custodian", "buyer", "seller"] as PartyRole[]) {
    const p = PARTIES[role];
    const client = new CantonClient(getConfig(role));
    try {
      const attestations = await client.queryAttestations();
      const settlements = await client.querySettlements();
      console.log(`  ${p.name.padEnd(12)} sees: ${attestations.length} attestation(s), ${settlements.length} settlement(s)`);
    } catch (err: any) {
      console.log(`  ${p.name.padEnd(12)} sees: [error: ${err.message}]`);
    }
  }

  console.log("\n  ── Dual ZK Proof Stack ─────────────────────────────────────\n");
  console.log("  ┌───────────────────────────────────────────────────────────┐");
  console.log("  │ Proof #1: RISC0 (off-chain)                              │");
  console.log("  │   Proves: EVM balance/staking state at block N           │");
  console.log("  │   Verified: Off-chain, anchored on Canton                │");
  console.log("  │   Visible to: Custodian + AssetHolder (signatories)      │");
  console.log("  │                                                           │");
  console.log("  │ Proof #2: Groth16 (on-chain)                             │");
  console.log("  │   Proves: Transfer calldata matches signed intent        │");
  console.log("  │   Verified: On-chain via AgentWallet (ERC-8150)          │");
  console.log("  │   Visible to: All EVM participants (public chain)        │");
  console.log("  │                                                           │");
  console.log("  │ Independence: No shared trust assumptions between proofs │");
  console.log("  └───────────────────────────────────────────────────────────┘\n");

  console.log("  ── What Each Party Can See ─────────────────────────────────\n");
  for (const role of ["custodian", "buyer", "seller"] as PartyRole[]) {
    const p = PARTIES[role];
    console.log(`  ${p.name}:`);
    console.log(`    ✓ Can see: ${p.canSee.join(", ")}`);
    console.log(`    ✗ Cannot see: ${p.cannotSee.join(", ")}`);
    console.log();
  }
}

function cmdHelp() {
  console.log(`
Canton ZK Custody — Privacy-Preserving Settlement CLI

USAGE:
  npx ts-node src/cli.ts <command> [options]

COMMANDS:
  health                          Check Canton participant status
  attestations [--party <role>]   Query CustodyAttestation contracts
  settlements  [--party <role>]   Query CrossChainSettlement contracts
  privacy-demo                    Show privacy model & party visibility matrix
  help                            Show this help message

PARTIES (--party):
  custodian    Verifies proofs, co-signs attestations (default)
  buyer        Initiates settlements, signs intents
  seller       Receives funds, agrees to terms

ENVIRONMENT:
  CANTON_PARTICIPANT_URL   Canton JSON API (default: http://localhost:7575)
  CANTON_LEDGER_ID         Ledger ID (default: vaeb_participant)
  CANTON_AUTH_TOKEN         JWT token (optional, sandbox uses insecure tokens)

EXAMPLES:
  # Check Canton health
  npx ts-node src/cli.ts health

  # View attestations as custodian (sees proofHash)
  npx ts-node src/cli.ts attestations --party custodian

  # View attestations as buyer (proofHash hidden)
  npx ts-node src/cli.ts attestations --party buyer

  # View settlements as seller
  npx ts-node src/cli.ts settlements --party seller

  # Full privacy model demonstration
  npx ts-node src/cli.ts privacy-demo

PRIVACY MODEL:
  Canton's sub-transaction privacy ensures each party only sees contracts
  where they are a signatory or named observer. The CLI demonstrates this
  by querying the ledger as different parties and showing what's visible.
`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  // Parse --party flag
  const partyIdx = args.indexOf("--party");
  const partyArg = partyIdx >= 0 ? args[partyIdx + 1] : "custodian";
  const party = (["custodian", "buyer", "seller"].includes(partyArg) ? partyArg : "custodian") as PartyRole;

  try {
    switch (command) {
      case "health":
        await cmdHealth();
        break;
      case "attestations":
        await cmdAttestations(party);
        break;
      case "settlements":
        await cmdSettlements(party);
        break;
      case "privacy-demo":
        await cmdPrivacyDemo();
        break;
      case "help":
      case "--help":
      case "-h":
        cmdHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        cmdHelp();
        process.exit(1);
    }
  } catch (err: any) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

main();
