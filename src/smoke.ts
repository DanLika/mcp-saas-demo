// Smoke test — exercises the tool logic directly (no transport) and asserts the
// security properties. This is a plain script: stdout is fine here (it is NOT the
// MCP server). Run with: npm run build && npm run smoke
import { setTenant } from "./db.js";
import { listDataSources, runSql, getTenantOverview } from "./tools.js";

const show = (label: string, v: unknown) => console.log(`\n## ${label}\n${JSON.stringify(v, null, 2)}`);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

console.log("=== tools work (tenant: acme) ===");
setTenant("acme");
show("list_data_sources", listDataSources());
show("run_sql: users by role", runSql("SELECT role, COUNT(*) AS n FROM users GROUP BY role ORDER BY role"));
show("get_tenant_overview", getTenantOverview());

console.log("\n=== tenant isolation ===");
const acmeEmails = JSON.stringify(runSql("SELECT email FROM users"));
check("acme sees its own users", acmeEmails.includes("ada@acme.test"));
setTenant("globex");
const globexView = JSON.stringify(runSql("SELECT email FROM users"));
check("globex CANNOT see acme rows", !globexView.includes("acme.test"), "switched tenant via server context only");
check("globex sees its own users", globexView.includes("hank@globex.test"));
const overviewLeak = JSON.stringify(getTenantOverview());
check("overview is tenant-scoped too", !overviewLeak.includes("acme") && overviewLeak.includes("Globex"));

console.log("\n=== query guard rejects unsafe input ===");
for (const bad of [
  "SELECT * FROM _users",
  "SELECT email FROM users; DROP TABLE _users",
  "DELETE FROM users",
  "UPDATE users SET role='owner'",
  "PRAGMA table_info(_users)",
]) {
  let rejected = false;
  try { runSql(bad); } catch { rejected = true; }
  check(`rejects: ${bad}`, rejected);
}

console.log("\n=== row cap ===");
const capped = runSql("SELECT id FROM users");
check("returns rows", capped.rows.length > 0, `${capped.rows.length} rows`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
