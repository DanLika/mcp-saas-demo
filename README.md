# mcp-saas-demo

A small, **runnable** Model Context Protocol (MCP) server for a multi-tenant SaaS, built to demonstrate the MCP server patterns that came out of the WorkOS MCP Night talks (2025–2026). It is deliberately tiny but gets the load-bearing things right: a small tool surface, SQL-as-interface, and **server-enforced tenant isolation** that a model cannot bypass.

Stack: TypeScript + the official `@modelcontextprotocol/sdk`, with `node:sqlite` as a zero-dependency stand-in for Postgres/Supabase.

## What it demonstrates

| Pattern | Where | Why it matters |
|---|---|---|
| **Use-case tools, not 1:1 CRUD** | 3 tools total (`list_data_sources`, `run_sql`, `get_tenant_overview`) | "An MCP server with 100 tools is generally a bad MCP server." Map tools to goals; keep the surface small. |
| **SQL-as-interface** | `run_sql` | One guarded `SELECT` tool beats dozens of bespoke read tools. The model already knows SQL and controls its own context with `LIMIT`. |
| **Discovery tool** | `list_data_sources` | Cheap meta-tool the model calls first to learn the schema, instead of dumping everything into context. |
| **Server-enforced authz** | tenant-scoped SQL views + `_ctx` | The model never supplies the tenant. A query physically cannot read another tenant's rows. |
| **Read-only guard** | `assertSafeSelect` | Single statement, `SELECT`-only, no DDL/DML, no access to private tables. |
| **Row cap** | `MAX_ROWS` wrap | Every result is bounded regardless of the query. |

## Quick start

```bash
npm install
npm run build
npm run smoke         # tool logic + isolation + guard assertions (all in-process)
npm run test:client   # spawns the server and drives it as a real MCP client over stdio
npm start             # run the server on stdio (Ctrl-C to stop)
```

`npm run smoke` prints `ALL CHECKS PASSED` when isolation holds and every unsafe query is rejected.

## Use it from an MCP client

**MCP Inspector:**
```bash
npm run inspect
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "saas-demo": {
      "command": "node",
      "args": ["--no-warnings", "/ABSOLUTE/PATH/TO/mcp-saas-demo/build/server.js"],
      "env": { "MCP_TENANT": "acme" }
    }
  }
}
```
Switch `MCP_TENANT` to `globex` or `initech` and ask the model "show me our users" — it only ever sees that tenant's data.

## The tools

- **`list_data_sources`** — returns the queryable views, their columns, the active tenant, and example SQL. Call this first.
- **`run_sql`** `{ sql }` — runs a single read-only `SELECT` (or `WITH … SELECT`) against the views `tenants`, `users`, `subscriptions`, `invoices`. Capped at 100 rows.
- **`get_tenant_overview`** — a use-case tool: user count by role, active MRR, subscription status, and open invoices, with no SQL required from the caller.

## Security model (the actual point)

The rule from the talks: **never let the model enforce authorization.** Here is how that is wired:

1. Base tables (`_users`, `_subscriptions`, …) are private and hold every tenant's rows. The model can't reference them — `run_sql` rejects any query that does.
2. The active tenant lives in a one-row `_ctx` table, set **server-side** by `setTenant()` from `MCP_TENANT`. In production this value comes from the validated access token's claim — never from a tool argument.
3. The only relations exposed to `run_sql` are **views** that filter by `_ctx`:
   ```sql
   CREATE VIEW users AS
     SELECT id, email, role, created_at FROM _users
     WHERE tenant_id = (SELECT tenant_id FROM _ctx);
   ```
   So `SELECT * FROM users` returns only the active tenant's rows, no matter what the model writes. There is no `tenant_id` column to filter on or forge.
4. `assertSafeSelect` strips comments, then enforces single-statement, `SELECT`-only, no DDL/DML, no private-table references (any leading-underscore identifier), and no SQLite metadata relations (`sqlite_master`/`sqlite_schema`, the `pragma_*` table-valued functions, `dbstat`) — so the model can't even read the private schema. Results are wrapped in an outer `LIMIT`.

`npm run smoke` and `npm run test:client` both prove a `globex` session cannot see `acme` rows and that writes, `SELECT * FROM _users`, `SELECT … FROM sqlite_master`, and `pragma_table_list` are all rejected.

## The 2026 MCP auth model (documented, not run)

Standing up a full OAuth 2.1 authorization server is out of scope for a demo, but the server ships the shape you implement in production. See [`.well-known/oauth-protected-resource.json`](.well-known/oauth-protected-resource.json) — the RFC 9728 **Protected Resource Metadata** document a remote MCP server returns. The flow:

1. Server is an OAuth 2.1 **Resource Server**; require PKCE.
2. Return `401` + `WWW-Authenticate` pointing at `/.well-known/oauth-protected-resource` (RFC 9728). AS discovery via RFC 8414.
3. Enforce **token audience** (RFC 8707 Resource Indicators): require `aud` == your server URL, and confirm your AS advertises `resource_indicators_supported`.
4. Client identity via **CIMD** (`draft-ietf-oauth-client-id-metadata-document`, adopted into MCP in the 2025-11-25 spec) — accept URL-style `client_id`, validate `redirect_uri` against the fetched metadata. Don't expose an open Dynamic Client Registration `/register` endpoint.
5. Wrapping an existing app? Front it with the **OAuth bridge** (keep your login, issue per-user tokens) instead of rebuilding auth.

The tenant in step 3's validated token is exactly what `setTenant()` simulates here.

## Going to production (swap SQLite → Supabase/Postgres)

Keep the shape, change the engine:
- Replace `node:sqlite` with a Postgres pool pointed at Supabase.
- Replace the view trick with **Row-Level Security**: a read-only role plus `USING (tenant_id = current_setting('app.tenant_id'))`, and `SET app.tenant_id = $1` per request from the token claim.
- Keep the row cap and keep the tenant out of the model's hands. Treat `assertSafeSelect` as defense-in-depth, not the boundary — RLS + a read-only role is the real isolation. The regex denylist is **SQLite-specific**: on Postgres, re-derive it (block `pg_catalog`, `information_schema`, dollar-quoted `$$…$$` and `E'…'` strings) rather than porting it verbatim.

## Project layout

```
src/
  db.ts            schema, seed, tenant-scoped views, the SQL guard
  tools.ts         the three tools' logic (importable + testable)
  server.ts        MCP server over stdio (registerTool + StdioServerTransport)
  smoke.ts         in-process assertions: tools, isolation, guard, row cap
  client-test.ts   end-to-end MCP client over stdio
.well-known/
  oauth-protected-resource.json   RFC 9728 example for the remote auth flow
```

## Not included (on purpose)

A live OAuth server, a remote (Streamable HTTP) transport, and write tools. The README's auth section and the `.well-known` file show where those go; the runnable core is the read path with isolation, which is where most MCP servers get authorization wrong.

---

Built by [Dusko Licanin](https://duskolicanin.com) — full-stack developer — as a hands-on study of production MCP patterns. Source specs: [modelcontextprotocol.io](https://modelcontextprotocol.io), RFC 9728 / 8707 / 8414, and Cloudflare's "Code Mode" writeup.

## License

MIT — see [LICENSE](LICENSE).
