/**
 * @vaeb/mcp-server — Library exports
 *
 * This module is the public API for importing VAEB MCP tools
 * as a library (e.g., from the Express server bridge).
 *
 * For the standalone MCP server (stdio), see ./index.ts
 */

export { getToolDefinitions } from "./tool-registry";
export { handleToolCall, type MCPConfig, type ToolCallResult } from "./handlers";
export { intentStore, type StoredIntent } from "./tools/marketplace-tools";
export { verifyTools } from "./tools/verify-tools";
