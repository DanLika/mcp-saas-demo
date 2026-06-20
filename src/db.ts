// In-memory multi-tenant SaaS dataset, used to demonstrate the "SQL-as-interface"
// MCP pattern with SERVER-ENFORCED tenant isolation.
//
// Security model (the point of this demo):
//   - Base tables are private (prefixed "_") and hold every tenant's rows.
//   - The active tenant lives in _ctx, set server-side from the auth context
//     (here simulated via MCP_TENANT). The MODEL never supplies the tenant.
//   - The only relations the query tool exposes are VIEWS that filter by _ctx,
//     so any SELECT the model writes can only ever see the active tenant's rows.
//
// Swap node:sqlite for Postgres/Supabase in production: keep the exact same shape
// (a read-only role + RLS policies, or per-request `SET app.tenant_id`), and keep
// the tenant coming from the validated token's claim, never from a tool argument.

// node:sqlite is experimental in Node and prints a one-line notice to stderr on
// load. Harmless for MCP (the protocol travels on stdout); silence with the
// node --no-warnings flag (the npm scripts and the README's client config do).
import { DatabaseSync } from "node:sqlite";

export const db = new DatabaseSync(":memory:");
export const MAX_ROWS = 100;

db.exec(`
  CREATE TABLE _tenants (id TEXT PRIMARY KEY, name TEXT, plan TEXT, created_at TEXT);
  CREATE TABLE _users (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT, role TEXT, created_at TEXT);
  CREATE TABLE _subscriptions (id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT, mrr_cents INTEGER, current_period_end TEXT);
  CREATE TABLE _invoices (id TEXT PRIMARY KEY, tenant_id TEXT, amount_cents INTEGER, status TEXT, issued_at TEXT);
  CREATE TABLE _ctx (tenant_id TEXT);
  INSERT INTO _ctx (tenant_id) VALUES ('');
`);

// Public, tenant-scoped views — the ONLY relations the query tool may touch.
db.exec(`
  CREATE VIEW tenants AS
    SELECT id, name, plan, created_at FROM _tenants WHERE id = (SELECT tenant_id FROM _ctx);
  CREATE VIEW users AS
    SELECT id, email, role, created_at FROM _users WHERE tenant_id = (SELECT tenant_id FROM _ctx);
  CREATE VIEW subscriptions AS
    SELECT id, status, mrr_cents, current_period_end FROM _subscriptions WHERE tenant_id = (SELECT tenant_id FROM _ctx);
  CREATE VIEW invoices AS
    SELECT id, amount_cents, status, issued_at FROM _invoices WHERE tenant_id = (SELECT tenant_id FROM _ctx);
`);

// --- seed (static dates; no Date.now so output is reproducible) ---
const tenants = [
  ["acme", "Acme Inc", "pro", "2026-01-04"],
  ["globex", "Globex Co", "starter", "2026-02-18"],
  ["initech", "Initech LLC", "pro", "2026-03-30"],
];
const users = [
  ["u1", "acme", "ada@acme.test", "owner", "2026-01-04"],
  ["u2", "acme", "grace@acme.test", "admin", "2026-01-12"],
  ["u3", "acme", "linus@acme.test", "member", "2026-02-01"],
  ["u4", "globex", "hank@globex.test", "owner", "2026-02-18"],
  ["u5", "globex", "carol@globex.test", "member", "2026-03-02"],
  ["u6", "initech", "peter@initech.test", "owner", "2026-03-30"],
];
const subs = [
  ["s1", "acme", "active", 9900, "2026-07-04"],
  ["s2", "globex", "active", 2900, "2026-07-18"],
  ["s3", "initech", "past_due", 9900, "2026-06-30"],
];
const invoices = [
  ["i1", "acme", 9900, "paid", "2026-06-04"],
  ["i2", "acme", 9900, "open", "2026-06-04"],
  ["i3", "globex", 2900, "paid", "2026-06-18"],
  ["i4", "initech", 9900, "open", "2026-05-30"],
];

const ins = (sql: string, rows: unknown[][]) => {
  const stmt = db.prepare(sql);
  for (const r of rows) stmt.run(...(r as never[]));
};
ins("INSERT INTO _tenants (id,name,plan,created_at) VALUES (?,?,?,?)", tenants);
ins("INSERT INTO _users (id,tenant_id,email,role,created_at) VALUES (?,?,?,?,?)", users);
ins("INSERT INTO _subscriptions (id,tenant_id,status,mrr_cents,current_period_end) VALUES (?,?,?,?,?)", subs);
ins("INSERT INTO _invoices (id,tenant_id,amount_cents,status,issued_at) VALUES (?,?,?,?,?)", invoices);

/** Set the active tenant. In production this value comes from the validated
 *  access token's claim (RFC 8707 audience-bound), never from the model. */
export function setTenant(tenantId: string): void {
  const known = db.prepare("SELECT 1 FROM _tenants WHERE id = ?").get(tenantId);
  if (!known) throw new Error(`Unknown tenant: ${tenantId}`);
  db.prepare("UPDATE _ctx SET tenant_id = ?").run(tenantId);
}

export function getActiveTenant(): string {
  return (db.prepare("SELECT tenant_id FROM _ctx").get() as { tenant_id: string }).tenant_id;
}

export function listTenants(): Array<{ id: string; name: string; plan: string }> {
  return db.prepare("SELECT id, name, plan FROM _tenants ORDER BY id").all() as never;
}

// Curated schema for the discovery tool — what the model is allowed to query.
export const PUBLIC_SCHEMA = {
  views: {
    tenants: ["id", "name", "plan", "created_at"],
    users: ["id", "email", "role", "created_at"],
    subscriptions: ["id", "status", "mrr_cents", "current_period_end"],
    invoices: ["id", "amount_cents", "status", "issued_at"],
  },
  notes:
    "All views are already filtered to the authenticated tenant. There is no tenant_id column to filter on, and no way to read another tenant's rows.",
  examples: [
    "SELECT role, COUNT(*) AS n FROM users GROUP BY role",
    "SELECT SUM(mrr_cents)/100.0 AS mrr_usd FROM subscriptions WHERE status = 'active'",
    "SELECT status, COUNT(*) FROM invoices GROUP BY status",
  ],
};

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|begin|commit|savepoint|load_extension)\b/i;
// SQLite metadata relations leak schema (table names + full DDL) even though they
// expose no tenant rows: sqlite_master/sqlite_schema, the pragma_* table-valued
// functions, and dbstat. The bare `pragma` keyword is already in FORBIDDEN, but
// `pragma_table_list` has no word boundary after "pragma", so it needs its own pattern.
const METADATA = /\b(sqlite_[a-z0-9_]+|pragma_[a-z0-9_]+|dbstat)\b/i;
// Any leading-underscore identifier. Every private base table is `_`-prefixed, so this
// covers them all (and any added later); column names like mrr_cents/created_at have
// only INTERNAL underscores, which don't match \b_.
const PRIVATE_REF = /\b_[a-z]\w*/i;

/** Validate that `sql` is a single, read-only SELECT against the public views only.
 *  Comments are stripped first so they can't smuggle keywords past these checks or
 *  break the LIMIT wrap in runReadonlyQuery. */
export function assertSafeSelect(sql: string): string {
  const noComments = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const trimmed = noComments.trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(trimmed) && !/^with\b/i.test(trimmed)) {
    throw new Error("Only read-only SELECT (or WITH ... SELECT) queries are allowed.");
  }
  if (trimmed.includes(";")) throw new Error("Only a single statement is allowed.");
  if (FORBIDDEN.test(trimmed)) throw new Error("Query contains a forbidden keyword (writes/DDL are not allowed).");
  if (METADATA.test(trimmed)) throw new Error("Query references SQLite metadata (sqlite_*, pragma_*, dbstat) — not allowed.");
  if (PRIVATE_REF.test(trimmed)) throw new Error("Query references a private table. Use the public views: tenants, users, subscriptions, invoices.");
  return trimmed;
}

/** Run a guarded, tenant-scoped, row-capped read query. */
export function runReadonlyQuery(sql: string): { columns: string[]; rows: Record<string, unknown>[] } {
  const safe = assertSafeSelect(sql);
  const wrapped = `SELECT * FROM (${safe}) AS q LIMIT ${MAX_ROWS}`;
  const rows = db.prepare(wrapped).all() as Record<string, unknown>[];
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rows };
}
