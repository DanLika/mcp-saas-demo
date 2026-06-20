// Tool logic, kept separate from the MCP transport so it can be unit/smoke-tested
// directly. Every query runs against the tenant-scoped views, so all three tools
// are automatically confined to the authenticated tenant.
import { db, PUBLIC_SCHEMA, getActiveTenant, runReadonlyQuery } from "./db.js";

/** Discovery tool: what can be queried, for whom, with examples. */
export function listDataSources() {
  return { activeTenant: getActiveTenant(), ...PUBLIC_SCHEMA };
}

/** SQL-as-interface: one guarded, capped, tenant-scoped read tool. */
export function runSql(sql: string) {
  return runReadonlyQuery(sql);
}

/** Use-case tool: KPIs without the caller writing any SQL. */
export function getTenantOverview() {
  const tenant = db.prepare("SELECT id, name, plan FROM tenants").get() ?? null;
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  const usersByRole = db.prepare("SELECT role, COUNT(*) AS n FROM users GROUP BY role ORDER BY role").all();
  const mrr = db.prepare("SELECT COALESCE(SUM(mrr_cents),0) AS c FROM subscriptions WHERE status='active'").get() as { c: number };
  const subscriptions = db.prepare("SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status").all();
  const openInv = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS c FROM invoices WHERE status='open'").get() as { n: number; c: number };
  return {
    tenant,
    userCount: users.n,
    usersByRole,
    activeMrrUsd: mrr.c / 100,
    subscriptions,
    openInvoices: { count: openInv.n, totalUsd: openInv.c / 100 },
  };
}
