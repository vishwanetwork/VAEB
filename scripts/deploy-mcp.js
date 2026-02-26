#!/usr/bin/env node
/**
 * Deploy the VAEB MCP Server
 *
 * This script:
 *   1. Validates required environment variables
 *   2. Builds the MCP server TypeScript → dist/
 *   3. Verifies the build output exists
 *   4. Prints the Claude Desktop / MCP client config snippet
 *   5. Prints a quick smoke-test command
 *
 * Run: node scripts/deploy-mcp.js
 * Run (skip build): node scripts/deploy-mcp.js --no-build
 */

require("dotenv").config();
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const MCP_PKG = path.join(ROOT, "packages", "mcp-server");
const DIST_INDEX = path.join(MCP_PKG, "dist", "index.js");
const DEPLOYMENTS_FILE = path.join(ROOT, "contracts", "deployments", "deployments.json");

// ─── CLI flags ────────────────────────────────────────────────────────────────

const skipBuild = process.argv.includes("--no-build");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ok(msg) {
  console.log(`  ✓  ${msg}`);
}
function warn(msg) {
  console.log(`  ⚠  ${msg}`);
}
function err(msg) {
  console.error(`  ✗  ${msg}`);
}
function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

// ─── Step 1: Validate env vars ───────────────────────────────────────────────

section("Step 1 — Environment");

const REQUIRED_ENV = {
  AGENT_PRIVATE_KEY: "Agent EOA private key (signs + submits transactions)",
  BASE_SEPOLIA_RPC_URL: "RPC endpoint for Base Sepolia",
};

const OPTIONAL_ENV = {
  PROVER_ENDPOINT: {
    default: "http://localhost:3001",
    desc: "ZK prover service URL",
  },
  DEFAULT_CHAIN: {
    default: "base_sepolia",
    desc: "Default chain key",
  },
  SUPPORTED_CHAINS: {
    default: "base_sepolia",
    desc: "Comma-separated list of supported chains",
  },
  REQUIRE_MANUAL_APPROVAL: {
    default: "false",
    desc: "Require manual approval before executing intents",
  },
};

let hasErrors = false;

for (const [key, desc] of Object.entries(REQUIRED_ENV)) {
  if (process.env[key]) {
    ok(`${key} is set`);
  } else {
    err(`${key} is missing — ${desc}`);
    hasErrors = true;
  }
}

for (const [key, { default: def, desc }] of Object.entries(OPTIONAL_ENV)) {
  if (process.env[key]) {
    ok(`${key} = ${process.env[key]}`);
  } else {
    warn(`${key} not set — using default: "${def}" (${desc})`);
  }
}

if (hasErrors) {
  console.error("\n  Missing required env vars. Copy .env.example → .env and fill in values.\n");
  process.exit(1);
}

// ─── Step 2: Validate deployments.json ───────────────────────────────────────

section("Step 2 — Deployments");

if (!fs.existsSync(DEPLOYMENTS_FILE)) {
  err("contracts/deployments/deployments.json not found.");
  err("Run: node scripts/deploy.js   (or forge script scripts/Deploy.s.sol)");
  process.exit(1);
}

const deployments = JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8"));
const defaultChain = process.env.DEFAULT_CHAIN || "base_sepolia";
const chainDep = deployments[defaultChain];

if (!chainDep) {
  err(`No deployment found for chain "${defaultChain}" in deployments.json`);
  process.exit(1);
}

ok(`Deployments loaded for chain: ${defaultChain} (chainId ${chainDep.chainId})`);

const contracts = chainDep.contracts || {};
const contractsToCheck = ["AgentWallet", "AgentWalletFactory", "MockUSDC"];
for (const name of contractsToCheck) {
  if (contracts[name]) {
    ok(`${name}: ${contracts[name]}`);
  } else {
    warn(`${name}: not found in deployments.json`);
  }
}

if (chainDep.wallets?.agent) {
  ok(`Agent EOA (from deployments.json): ${chainDep.wallets.agent}`);
}

// ─── Step 3: Build ────────────────────────────────────────────────────────────

section("Step 3 — Build");

if (skipBuild) {
  warn("--no-build flag set — skipping TypeScript compilation");
} else {
  console.log("  Running: npm run build -w @vaeb/mcp-server ...\n");
  try {
    execSync("npm run build -w @vaeb/mcp-server", {
      cwd: ROOT,
      stdio: "inherit",
    });
    ok("Build succeeded");
  } catch {
    err("Build failed — fix TypeScript errors above and re-run");
    process.exit(1);
  }
}

// ─── Step 4: Verify dist/index.js ─────────────────────────────────────────────

section("Step 4 — Verify build output");

if (!fs.existsSync(DIST_INDEX)) {
  err(`dist/index.js not found at: ${DIST_INDEX}`);
  err("Build may have failed silently. Run: npm run build -w @vaeb/mcp-server");
  process.exit(1);
}

const stat = fs.statSync(DIST_INDEX);
ok(`dist/index.js exists (${(stat.size / 1024).toFixed(1)} KB)`);

// Also check the bin is executable
try {
  fs.chmodSync(DIST_INDEX, 0o755);
  ok("dist/index.js is executable");
} catch {
  warn("Could not chmod dist/index.js — may need manual chmod +x");
}

// ─── Step 5: Print Claude Desktop config ──────────────────────────────────────

section("Step 5 — Claude Desktop Config");

const envBlock = {
  AGENT_PRIVATE_KEY: process.env.AGENT_PRIVATE_KEY,
  BASE_SEPOLIA_RPC_URL: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  DEFAULT_CHAIN: process.env.DEFAULT_CHAIN || "base_sepolia",
  SUPPORTED_CHAINS: process.env.SUPPORTED_CHAINS || "base_sepolia",
  PROVER_ENDPOINT: process.env.PROVER_ENDPOINT || "http://localhost:3001",
  REQUIRE_MANUAL_APPROVAL: process.env.REQUIRE_MANUAL_APPROVAL || "false",
};

const claudeConfig = {
  mcpServers: {
    vaeb: {
      command: "node",
      args: [DIST_INDEX],
      env: envBlock,
    },
  },
};

const claudeConfigPath = (() => {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library/Application Support/Claude/claude_desktop_config.json"
    );
  } else if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData/Roaming/Claude/claude_desktop_config.json");
  } else {
    return path.join(os.homedir(), ".config/claude/claude_desktop_config.json");
  }
})();

console.log("\n  Add this to your Claude Desktop config:");
console.log(`  ${claudeConfigPath}\n`);
console.log(JSON.stringify(claudeConfig, null, 2)
  .split("\n")
  .map((l) => "  " + l)
  .join("\n"));

// ─── Step 6: Smoke test command ───────────────────────────────────────────────

section("Step 6 — Quick smoke test");

console.log("\n  Run this to confirm the server starts cleanly:\n");
console.log(`    echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}},"id":1}' | node ${DIST_INDEX}`);
console.log();
console.log("  Or run the full integration test suite:");
console.log(`    cd packages/mcp-server && npm run test:integration`);

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log("  VAEB MCP Server ready.");
console.log(`  Entry point: ${DIST_INDEX}`);
console.log("─".repeat(60) + "\n");
