#!/usr/bin/env node
// MCP server (stdio) for a multi-tenant SaaS demo.
//
// Demonstrates the 2026 MCP server patterns:
//   - Small, use-case-oriented tool surface (3 tools, not 1-per-endpoint CRUD).
//   - SQL-as-interface: one guarded `run_sql` beats dozens of bespoke read tools.
//   - Server-enforced authorization: the tenant comes from the (simulated) auth
//     context, not from the model; views guarantee a query can't cross tenants.
//
// stdio rule: the JSON-RPC protocol owns stdout. All logging goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { setTenant, getActiveTenant, MAX_ROWS } from "./db.js";
import { listDataSources, runSql, getTenantOverview } from "./tools.js";

// In production the tenant is read from the validated access token's claim
// (RFC 8707 audience-bound). Here MCP_TENANT stands in for that claim.
const TENANT = process.env.MCP_TENANT?.trim() || "acme";
setTenant(TENANT);

const server = new McpServer({ name: "mcp-saas-demo", version: "0.1.0" });

const asText = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
});

server.registerTool(
  "list_data_sources",
  {
    title: "List data sources",
    description:
      "Discover what data is queryable for the authenticated tenant: views, columns, and example SQL. Call this before run_sql.",
    inputSchema: {},
  },
  async () => asText(listDataSources()),
);

server.registerTool(
  "run_sql",
  {
    title: "Run read-only SQL",
    description:
      `Run a single read-only SELECT against the tenant-scoped views (tenants, users, subscriptions, invoices). ` +
      `Results are capped at ${MAX_ROWS} rows. Writes, DDL, multiple statements, and private tables are rejected. ` +
      `Every query only ever sees the authenticated tenant's rows. Call list_data_sources first for the schema.`,
    inputSchema: {
      sql: z.string().describe("A single SELECT (or WITH ... SELECT) over the public views."),
    },
  },
  async ({ sql }) => {
    try {
      return asText(runSql(sql));
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.registerTool(
  "get_tenant_overview",
  {
    title: "Tenant overview (KPIs)",
    description:
      "Use-case tool: returns key metrics for the authenticated tenant (user count by role, active MRR, subscription status, open invoices) without the caller writing SQL.",
    inputSchema: {},
  },
  async () => asText(getTenantOverview()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `mcp-saas-demo running over stdio. Authenticated tenant: ${getActiveTenant()} (set MCP_TENANT to switch).`,
);
