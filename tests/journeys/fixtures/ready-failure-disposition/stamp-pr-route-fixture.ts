/**
 * HOK-3361 replay fixture for the ready-failure-disposition journey (HOK-3371).
 *
 * The journey's shadow TOOLS_DIR resolves `stamp-pr-route.ts` to this wrapper
 * (every other tool stays a symlink to the real one). The wrapper delegates to
 * the bash replay fixture (fake-stamp-pr-route.sh), which fails on the first
 * call with the incident's deterministic contract error and delegates to the
 * real tool afterwards. Delegating through the bash fixture keeps one fixture
 * definition shared by the journey and its unit test.
 *
 * Env (set in the journey's MONITOR_ENV):
 *   FAKE_STAMP_FIXTURE - path to fake-stamp-pr-route.sh (required)
 */
import { spawnSync } from "node:child_process";

const fixture = process.env.FAKE_STAMP_FIXTURE ?? "";
if (fixture === "") {
  process.stderr.write("stamp-pr-route-fixture.ts: FAKE_STAMP_FIXTURE is required\n");
  process.exit(2);
}
const result = spawnSync("bash", [fixture, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
