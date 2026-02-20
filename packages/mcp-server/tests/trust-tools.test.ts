import { test } from "node:test";
import assert from "node:assert/strict";
import { trustTools } from "../src/tools/trust-tools";
import { baseConfig } from "./helpers";

test("trustTools.discover_agents filters by min_reputation", async () => {
  const config = baseConfig();
  const result = await trustTools.handle("discover_agents", { min_reputation: 9 }, config);
  assert.ok(result.total_agents_found > 0);
  assert.ok(result.recommended);
});

test("trustTools.get_agent_reputation throws for unknown agent", async () => {
  const config = baseConfig();
  await assert.rejects(
    () => trustTools.handle("get_agent_reputation", { agent_id: 9999 }, config),
    /Agent not found/
  );
});

test("trustTools.compare_agents requires ids", async () => {
  const config = baseConfig();
  await assert.rejects(
    () => trustTools.handle("compare_agents", { agent_ids: [] }, config),
    /No agents found/
  );
});
