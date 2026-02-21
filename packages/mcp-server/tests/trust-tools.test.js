"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const trust_tools_1 = require("../src/tools/trust-tools");
const helpers_1 = require("./helpers");
(0, node_test_1.test)("trustTools.discover_agents filters by min_reputation", async () => {
    const config = (0, helpers_1.baseConfig)();
    const result = await trust_tools_1.trustTools.handle("discover_agents", { min_reputation: 9 }, config);
    strict_1.default.ok(result.total_agents_found > 0);
    strict_1.default.ok(result.recommended);
});
(0, node_test_1.test)("trustTools.get_agent_reputation throws for unknown agent", async () => {
    const config = (0, helpers_1.baseConfig)();
    await strict_1.default.rejects(() => trust_tools_1.trustTools.handle("get_agent_reputation", { agent_id: 9999 }, config), /Agent not found/);
});
(0, node_test_1.test)("trustTools.compare_agents requires ids", async () => {
    const config = (0, helpers_1.baseConfig)();
    await strict_1.default.rejects(() => trust_tools_1.trustTools.handle("compare_agents", { agent_ids: [] }, config), /No agents found/);
});
//# sourceMappingURL=trust-tools.test.js.map