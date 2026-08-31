import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = process.argv[2];
const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

async function call(name, args) {
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.map((c) => c.text).join("\n");
    console.log(res.isError ? "[isError] " : "", text.slice(0, 900));
  } catch (e) {
    console.log("THREW:", e.message);
  }
}

await call("get_trending_players", { type: "add", limit: 5 });
await call("refresh_player_cache", {});
await call("get_league", { username: "definitely-not-a-real-user-xyz-123" });

const user = process.env.SLEEPER_USER;
if (user) {
  await call("get_league", { username: user });
}
const draftId = process.env.SLEEPER_DRAFT;
if (draftId) {
  await call("get_draft_info", { draft_id: draftId });
  await call("get_draft_picks", { draft_id: draftId, limit: 5 });
  await call("whose_turn", { draft_id: draftId });
  await call("get_available_players", { draft_id: draftId, position: "RB", limit: 5 });
}

await client.close();
console.log("\nsmoke done");
process.exit(0);
