# sleeper-draft-mcp

A local [MCP](https://modelcontextprotocol.io) server that gives an AI assistant
live visibility into a **Sleeper** fantasy football draft: who's been picked,
who's available, whose turn it is, and where your roster is thin.

It uses only Sleeper's **public, keyless REST API** (`https://api.sleeper.app/v1`).
No login, no API key, no third-party hosting. See
[Auth](#auth--does-any-of-this-need-a-key) below.

There's also a **[static web app](#web-app)** in [`web/`](./web) — a browser draft
room (paste a draft ID → live picks / available players / whose turn / roster
needs) that talks to Sleeper directly and deploys to GitHub Pages.

## Requirements

- Node.js **>= 22** (uses the built-in `fetch`, the test runner, and
  `--experimental-strip-types`). Developed on Node 24.

## Install & build

```bash
npm install
npm run build      # tsc -> dist/
npm test           # unit tests for the draft math + roster-needs logic
```

Run it directly during development (no build step) with:

```bash
npm run dev
```

## MCP client config

Point your MCP client at the built server over stdio:

```json
{
  "mcpServers": {
    "sleeper-draft": {
      "command": "node",
      "args": ["C:/Users/tsjsp/sleeper-draft-mcp/dist/server.js"]
    }
  }
}
```

(There's a copy of this at [`mcp.config.example.json`](./mcp.config.example.json).)
Use an absolute path to `dist/server.js`. Optionally set
`SLEEPER_CACHE_DIR` in an `"env"` block to move the player cache.

## Tools

| Tool | Input | What it returns |
|---|---|---|
| `get_league` | `username`, `season?` | Resolved `user_id` + the user's NFL leagues (`league_id`, name, status, scoring, `draft_id`). Season defaults to the current NFL season. |
| `get_draft_info` | `league_id` **or** `draft_id` | `draft_id`, type (snake/linear/auction), status, team count, rounds, third-round-reversal flag, and the slot → roster → owner mapping. |
| `get_draft_picks` | `draft_id`, `limit?` | Ordered picks so far: `pick_no`, round, slot, `roster_id`, and the resolved player name / position / team. Poll this every 5–10s during a live draft. |
| `get_available_players` | `draft_id`, `position?`, `search?`, `limit?`, `include_unranked?`, `include_idp?` | Undrafted players (cache minus picks), sorted by Sleeper's `search_rank` (rough ADP). Fantasy positions only and ranked-only by default. |
| `whose_turn` | `draft_id`, `my_roster_id?` | The pick on the clock (computed from pick count via snake math), the next few picks, and — with `my_roster_id` — an `on_the_clock` flag plus picks-until-your-next-turn. |
| `get_my_roster_needs` | `league_id`/`draft_id`, `my_roster_id` | Your picks so far vs. the league's required starting slots, with thin positions flagged. FLEX / SUPER_FLEX / REC_FLEX aware. |
| `get_trending_players` | `type` (`add`/`drop`), `lookback_hours?`, `limit?` | Sleeper's most-added / most-dropped players. Rough signal only — **not** rankings. |
| `refresh_player_cache` | — | Force a re-download of `/players/nfl` and rewrite the disk cache. |

### Typical flow

1. `get_league` with your Sleeper username → pick your `league_id`.
2. `get_draft_info` with that `league_id` → get the `draft_id`, confirm draft
   type, and find your `roster_id` in the draft-order table.
3. During the draft, loop on `get_draft_picks` / `whose_turn` (with your
   `my_roster_id`), and `get_available_players` / `get_my_roster_needs` when
   you're on the clock.

## Player cache

`/players/nfl` is a ~5 MB JSON blob, so it's fetched once and written to
`cache/players.json` (override with `SLEEPER_CACHE_DIR`). It's refreshed
automatically when the file is missing or older than 24h; `refresh_player_cache`
forces it. The server also warms the cache in the background on startup.

## Snake-draft math

`src/snake.ts` is pure and unit-tested (`test/snake.test.ts`). It handles:

- **linear** drafts — every round runs slots `1..N`
- **standard snake** — odd rounds `1..N`, even rounds `N..1`
- **third-round reversal** (`settings.reversal_round`, "3RR") — the flip that
  would normally happen entering round `reversal_round` is applied one round
  early, then alternates from there.

`whose_turn` reads `draft.type` and `draft.settings.reversal_round` from Sleeper
rather than assuming pure snake. Auction drafts are detected and reported as
"no turn order".

## Auth — does any of this need a key?

**No.** Every endpoint used here is public and unauthenticated:

```
GET /state/nfl
GET /user/{username}
GET /user/{user_id}/leagues/nfl/{season}
GET /league/{league_id}
GET /league/{league_id}/drafts
GET /league/{league_id}/users
GET /league/{league_id}/rosters
GET /draft/{draft_id}
GET /draft/{draft_id}/picks
GET /players/nfl
GET /players/nfl/trending/{add|drop}
```

The Sleeper client (`src/sleeper.ts`) treats any `401`/`403` as a hard error
that tells you to flag it — so if Sleeper ever starts requiring a key on one of
these, you'll hear about it loudly instead of silently.

Rate limit: stay under ~1000 calls/min. Polling picks every 5–10s during a live
draft is well within that.

## Dev smoke test

`smoke.mjs` drives the built server through the MCP client SDK:

```bash
node smoke.mjs dist/server.js
# optionally exercise the live-draft tools:
SLEEPER_USER=your_username SLEEPER_DRAFT=some_draft_id node smoke.mjs dist/server.js
```

## Web app

[`web/`](./web) is a **dependency-free static site** (vanilla ES modules, no build
step). It calls the Sleeper API straight from the browser — Sleeper sends
`access-control-allow-origin: *`, so no proxy or server is needed.

- **Home** — one input. Paste a **draft ID**, a **league ID**, a **username**, or
  a `sleeper.com/draft/…` URL. Numeric input is tried as a draft, then as a
  league; a username lists that user's leagues to pick from.
- **Draft room** (`#/draft/<id>`):
  - **On the clock** banner — team, round/pick, on-deck, and (once you pick your
    team) "your next pick is N away". Snake / linear / 3RR aware.
  - **Available players** — trimmed player list minus picks, sorted by
    `search_rank`, with position chips + name search.
  - **Recent picks** — reverse-chronological, your picks highlighted.
  - **Your roster & needs** — counts by position vs. the league's required
    starters (FLEX/SUPER_FLEX/REC_FLEX aware).
  - **Draft board** — toggleable snake-aware grid, current pick outlined.
  - **auto-refresh** every 10s (toggle), plus a manual refresh.
- Player dictionary (~5 MB) is fetched once, trimmed to fantasy-relevant players
  (~tens of KB), and cached in `localStorage` for 24h. "↻ players" forces a
  refresh. "You are" and recent drafts also persist in `localStorage`.

### Run it locally

```bash
cd web && python -m http.server 8777   # or any static server
# open http://localhost:8777
```

### Deploy to GitHub Pages

1. Push this repo to GitHub (default branch `main`).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. The included workflow ([`.github/workflows/pages.yml`](./.github/workflows/pages.yml))
   publishes `web/` on every push that touches it. The site lands at
   `https://<user>.github.io/<repo>/`.
4. Edit `REPO_URL` at the top of [`web/app.js`](./web/app.js) so the footer
   "Source" link points at your repo.

Hash-based routing (`#/draft/…`) means no Pages redirect config is needed and
draft-room URLs are shareable.

## Project layout

```
src/                 MCP server (TypeScript, compiled to dist/)
  server.ts    MCP server + tool definitions (stdio transport)
  sleeper.ts   keyless Sleeper REST client + response types
  context.ts   draft_id/league_id -> resolved draft context (slots, owners, settings)
  players.ts   disk cache + player-id / name-search indexes
  snake.ts     pure draft-position math (snake / linear / 3RR)
  needs.ts     roster-needs vs. required-starters math
web/                 static browser app (deployed to Pages)
  index.html
  app.js       router + home + draft-room views
  styles.css
  lib/         sleeper.js (browser API client), snake.js, needs.js, players.js
test/                MCP server unit tests (node:test)
  snake.test.ts
  needs.test.ts
web-tests/           web-app checks (run by `npm test`)
  logic.mjs    snake.js port parity vs. known results
  render.mjs   mounts app.js in jsdom against a stubbed draft
```
