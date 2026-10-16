import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Bridge } from "../src/bridge.js";
import { PluginClient } from "../src/client.js";
import { startHttpTransport, type HttpTransportHandle } from "../src/http.js";
import { registerAllTools } from "../src/tools/index.js";

const TOKEN = "test-http-token-0123456789";

describe("streamable http transport", () => {
  let bridge: Bridge;
  let http: HttpTransportHandle;
  let client: PluginClient;
  let baseUrl: string;

  before(async () => {
    bridge = new Bridge({ token: TOKEN, port: 0, timeoutMs: 1000 });
    await bridge.start();
    client = new PluginClient(bridge);
    http = await startHttpTransport({
      token: TOKEN,
      port: 0,
      createServer: () => {
        const server = new McpServer({ name: "elf-figma", version: "0.1.0" });
        registerAllTools(server, client);
        return server;
      },
    });
    baseUrl = `http://127.0.0.1:${http.port}`;
  });

  after(async () => {
    await http.close();
    await bridge.stop();
  });

  async function connect(url: string, headers?: Record<string, string>): Promise<Client> {
    const mcp = new Client({ name: "http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: headers ? { headers } : undefined,
    });
    await mcp.connect(transport);
    return mcp;
  }

  test("accepts a Bearer token and lists the tools", async () => {
    const mcp = await connect(`${baseUrl}/mcp`, { Authorization: `Bearer ${TOKEN}` });
    const tools = await mcp.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("status"));
    assert.ok(names.includes("upsert_variables"));
    assert.ok(names.includes("upsert_component"));
    await mcp.close();
  });

  test("accepts the token in the path for clients that cannot set headers", async () => {
    const mcp = await connect(`${baseUrl}/t/${TOKEN}/mcp`);
    const tools = await mcp.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "get_node"));
    await mcp.close();
  });

  test("status works over http and reports the plugin as disconnected", async () => {
    const mcp = await connect(`${baseUrl}/mcp`, { Authorization: `Bearer ${TOKEN}` });
    const result = await mcp.callTool({ name: "status", arguments: {} });
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.connected, false);
    assert.equal(payload.port, bridge.status.port);
    await mcp.close();
  });

  test("not-connected errors keep the plugin hint over http", async () => {
    const mcp = await connect(`${baseUrl}/mcp`, { Authorization: `Bearer ${TOKEN}` });
    const result = await mcp.callTool({ name: "list_collections", arguments: {} });
    assert.equal(result.isError, true);
    const text = (result.content as { text: string }[])[0].text;
    assert.match(text, /open the Elf Bridge plugin in Figma/);
    await mcp.close();
  });

  test("rejects a wrong token without detail", async () => {
    await assert.rejects(() => connect(`${baseUrl}/mcp`, { Authorization: "Bearer nope-nope-nope" }));
  });

  test("rejects a missing token", async () => {
    await assert.rejects(() => connect(`${baseUrl}/mcp`));
  });

  test("does not serve other paths", async () => {
    const response = await fetch(`${baseUrl}/something`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 404);
  });
});
