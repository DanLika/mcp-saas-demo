// End-to-end protocol test: spawn the server over stdio as a real MCP client,
// list tools, call them, and confirm the guard fires across the wire.
// Run with: npm run build && npm run test:client
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["build/server.js"],
  env: { ...process.env, MCP_TENANT: "globex", NODE_NO_WARNINGS: "1" } as Record<string, string>,
});
const client = new Client({ name: "smoke-client", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content)[0].text;

const ds = await client.callTool({ name: "list_data_sources", arguments: {} });
console.log("active tenant (from server context):", JSON.parse(text(ds)).activeTenant);

const q = await client.callTool({ name: "run_sql", arguments: { sql: "SELECT email FROM users" } });
console.log("run_sql (globex) ->", text(q).replace(/\s+/g, " "));

const bad = await client.callTool({ name: "run_sql", arguments: { sql: "SELECT * FROM _users" } });
console.log("guard over protocol:", (bad as { isError?: boolean }).isError ? "REJECTED" : "allowed", "->", text(bad));

await client.close();
console.log("client-test OK");
