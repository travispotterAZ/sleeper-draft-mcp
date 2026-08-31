// Headless render smoke test: mount app.js in jsdom, feed it a fake (but
// realistically-shaped) Sleeper draft via a stubbed fetch, and assert the draft
// room renders without throwing.

import { JSDOM } from "jsdom";
import assert from "node:assert/strict";

const NUM_TEAMS = 10;
const ROUNDS = 15;

const draft = {
  draft_id: "TESTDRAFT",
  league_id: "TESTLEAGUE",
  type: "snake",
  status: "drafting",
  season: "2026",
  settings: { teams: NUM_TEAMS, rounds: ROUNDS, reversal_round: 3 },
  metadata: { name: "Test Snake League" },
  draft_order: Object.fromEntries([...Array(NUM_TEAMS)].map((_, i) => [`u${i + 1}`, i + 1])),
  slot_to_roster_id: Object.fromEntries([...Array(NUM_TEAMS)].map((_, i) => [String(i + 1), i + 1])),
};
const users = [...Array(NUM_TEAMS)].map((_, i) => ({
  user_id: `u${i + 1}`,
  display_name: `Manager ${i + 1}`,
  metadata: { team_name: `Team ${i + 1}` },
}));
const rosters = [...Array(NUM_TEAMS)].map((_, i) => ({ roster_id: i + 1, owner_id: `u${i + 1}` }));
const league = {
  league_id: "TESTLEAGUE",
  name: "Test Snake League",
  roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN"],
};
const picks = [
  { pick_no: 1, round: 1, draft_slot: 1, roster_id: 1, player_id: "4046", picked_by: "u1",
    metadata: { first_name: "Patrick", last_name: "Mahomes", position: "QB", team: "KC" } },
  { pick_no: 2, round: 1, draft_slot: 2, roster_id: 2, player_id: "6794",
    metadata: { first_name: "Ja'Marr", last_name: "Chase", position: "WR", team: "CIN" } },
  { pick_no: 3, round: 1, draft_slot: 3, roster_id: 3, player_id: "4034",
    metadata: { first_name: "Christian", last_name: "McCaffrey", position: "RB", team: "SF" } },
];
const playersDict = {
  "4046": { player_id: "4046", full_name: "Patrick Mahomes", position: "QB", team: "KC", search_rank: 25, fantasy_positions: ["QB"] },
  "6794": { player_id: "6794", full_name: "Ja'Marr Chase", position: "WR", team: "CIN", search_rank: 2, fantasy_positions: ["WR"] },
  "4034": { player_id: "4034", full_name: "Christian McCaffrey", position: "RB", team: "SF", search_rank: 1, fantasy_positions: ["RB"] },
  "9999": { player_id: "9999", full_name: "Bijan Robinson", position: "RB", team: "ATL", search_rank: 3, fantasy_positions: ["RB"] },
  "9998": { player_id: "9998", full_name: "CeeDee Lamb", position: "WR", team: "DAL", search_rank: 4, fantasy_positions: ["WR"] },
  "9997": { player_id: "9997", full_name: "Sam LaPorta", position: "TE", team: "DET", search_rank: 20, fantasy_positions: ["TE"] },
};

function fakeFetch(url) {
  // strip the cache-busting ?_t=… the client adds to poll requests
  const path = String(url).replace("https://api.sleeper.app/v1", "").replace(/\?.*$/, "");
  const body =
    path === "/draft/TESTDRAFT" ? draft :
    path === "/draft/TESTDRAFT/picks" ? picks :
    path === "/league/TESTLEAGUE" ? league :
    path === "/league/TESTLEAGUE/users" ? users :
    path === "/league/TESTLEAGUE/rosters" ? rosters :
    path === "/players/nfl" ? playersDict :
    path === "/state/nfl" ? { season: "2026", week: 1 } :
    null;
  if (body === null) return Promise.resolve(new Response("null", { status: 200, headers: { "content-type": "application/json" } }));
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

const dom = new JSDOM(
  `<!doctype html><html><body>
    <header><a class="brand"></a><div id="topnav"></div></header>
    <main id="app"></main>
    <footer><a id="srcLink"></a></footer>
  </body></html>`,
  { url: "https://example.github.io/sleeper-draft-mcp/#/draft/TESTDRAFT", runScripts: "outside-only", pretendToBeVisual: true },
);

const { window } = dom;
const errors = [];
window.addEventListener("error", (e) => errors.push(e.message));
global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;
global.location = window.location;
global.Event = window.Event;
global.fetch = fakeFetch;
global.Response = Response;
window.fetch = fakeFetch;

await import("../web/app.js");
// give the async bootstrap chain time to resolve
await new Promise((r) => setTimeout(r, 300));

const html = window.document.getElementById("app").innerHTML;
assert.ok(errors.length === 0, "window errors: " + errors.join("; "));
assert.ok(html.includes("Test Snake League"), "draft name rendered");
assert.ok(html.includes("3RR@R3"), "reversal-round badge rendered");
assert.ok(html.includes("Bijan Robinson"), "available player rendered");
assert.ok(!html.includes("McCaffrey</span>\n        <span class=\"pill"), "drafted player excluded from available (soft check)");
assert.ok(html.includes("Mahomes"), "recent pick rendered");

// on the clock after 3 picks in a 10-team snake => slot 4, round 1
assert.ok(html.includes("overall #4 of 150"), "on-the-clock overall pick computed: " + (html.match(/overall #\d+ of \d+/) || []));

// simulate selecting a team and confirm needs panel updates
window.document.getElementById("youSel").value = "4";
window.document.getElementById("youSel").dispatchEvent(new window.Event("change"));
await new Promise((r) => setTimeout(r, 50));
const needsHtml = window.document.getElementById("needs").innerHTML;
assert.ok(/starters/.test(needsHtml), "needs panel shows starter rows: " + needsHtml.slice(0, 120));

console.log("render smoke: OK");
console.log("  clock:", (html.match(/<div class="who">[^<]*<\/div>/) || [""])[0]);
console.log("  errors:", errors.length);

process.exit(0);
