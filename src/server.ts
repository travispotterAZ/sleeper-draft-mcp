#!/usr/bin/env node
/**
 * Sleeper Draft MCP server.
 *
 * Local, stdio-transport MCP server that gives a model live visibility into a
 * Sleeper fantasy football draft using only Sleeper's public, keyless REST API.
 *
 * No credentials anywhere. If any Sleeper endpoint starts returning 401/403 the
 * client class throws a loud SleeperError telling you to flag it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { buildDraftContext } from "./context.ts";
import { bySearchRank, cacheLocation, loadPlayers } from "./players.ts";
import { computeRosterNeeds } from "./needs.ts";
import {
  currentPosition,
  picksForSlot,
  picksUntilSlot,
  positionForOverallPick,
} from "./snake.ts";
import {
  getDraftPicks,
  getState,
  getTrendingPlayers,
  getUserByName,
  getUserLeagues,
  type SleeperPick,
  type SleeperPlayer,
} from "./sleeper.ts";

const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
const IDP_POSITIONS = ["DL", "LB", "DB", "CB", "S", "DE", "DT"] as const;
const ALL_KNOWN_POSITIONS = [...FANTASY_POSITIONS, ...IDP_POSITIONS];

// ---------------------------------------------------------------------------
// small result helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function fail(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `ERROR: ${message}` }],
    isError: true,
  };
}

function wrap<A>(
  handler: (args: A) => Promise<ToolResult>,
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      return fail((err as Error).message ?? String(err));
    }
  };
}

function playerLabel(p: SleeperPlayer): {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  search_rank: number | null;
  injury_status: string | null;
} {
  return {
    player_id: p.player_id,
    name:
      p.full_name ||
      [p.first_name, p.last_name].filter(Boolean).join(" ") ||
      p.player_id,
    position: p.position ?? null,
    team: p.team ?? null,
    search_rank: p.search_rank ?? null,
    injury_status: p.injury_status ?? null,
  };
}

function resolvePickPlayer(
  pick: SleeperPick,
  byId: Map<string, SleeperPlayer>,
): { name: string; position: string | null; team: string | null } {
  const cached = byId.get(pick.player_id);
  if (cached) {
    return {
      name:
        cached.full_name ||
        [cached.first_name, cached.last_name].filter(Boolean).join(" ") ||
        pick.player_id,
      position: cached.position ?? null,
      team: cached.team ?? null,
    };
  }
  const m = pick.metadata ?? {};
  const name = [m.first_name, m.last_name].filter(Boolean).join(" ");
  return {
    name: name || pick.player_id,
    position: m.position ?? null,
    team: m.team ?? null,
  };
}

// ---------------------------------------------------------------------------
// server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "sleeper-draft",
  version: "0.1.0",
});

server.registerTool(
  "get_league",
  {
    title: "Get leagues for a user",
    description:
      "Resolve a Sleeper username to a user_id and list that user's NFL leagues " +
      "for a season (defaults to the current NFL season). Use the returned " +
      "league_id with the other tools.",
    inputSchema: {
      username: z.string().min(1).describe("Sleeper username (not display name)"),
      season: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Season year, e.g. 2026. Defaults to the current NFL season."),
    },
  },
  wrap(async ({ username, season }) => {
    const user = await getUserByName(String(username));
    let resolvedSeason = season != null ? String(season) : undefined;
    if (!resolvedSeason) {
      const state = await getState("nfl").catch(() => null);
      resolvedSeason = state?.season ?? String(new Date().getFullYear());
    }
    const leagues = await getUserLeagues(user.user_id, resolvedSeason);
    return ok({
      user: {
        user_id: user.user_id,
        username: user.username,
        display_name: user.display_name,
      },
      season: resolvedSeason,
      league_count: leagues.length,
      leagues: leagues.map((l) => ({
        league_id: l.league_id,
        name: l.name,
        season: l.season,
        status: l.status,
        total_rosters: l.total_rosters,
        draft_id: l.draft_id,
        scoring:
          l.scoring_settings?.rec != null
            ? l.scoring_settings.rec >= 1
              ? "PPR"
              : l.scoring_settings.rec > 0
                ? "Half-PPR"
                : "Standard"
            : "unknown",
      })),
    });
  }),
);

server.registerTool(
  "get_draft_info",
  {
    title: "Get draft metadata",
    description:
      "Draft settings for a league (or an explicit draft_id): draft type " +
      "(snake/linear/auction), status, team count, rounds, third-round-reversal " +
      "flag, the slot -> roster -> owner mapping, and the league's required " +
      "starting slots.",
    inputSchema: {
      league_id: z.string().optional(),
      draft_id: z
        .string()
        .optional()
        .describe("Use this to target a specific draft; otherwise the league's most recent draft is used."),
    },
  },
  wrap(async ({ league_id, draft_id }) => {
    if (!league_id && !draft_id) {
      throw new Error("Provide league_id or draft_id.");
    }
    const ctx = await buildDraftContext({ leagueId: league_id, draftId: draft_id });
    const order = [...ctx.slotToRosterId.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([slot, rosterId]) => ({
        slot,
        roster_id: rosterId,
        team: ctx.teamLabel(rosterId),
      }));
    return ok({
      draft_id: ctx.draft.draft_id,
      league_id: ctx.draft.league_id,
      type: ctx.draft.type,
      is_auction: ctx.isAuction,
      status: ctx.draft.status,
      season: ctx.draft.season,
      num_teams: ctx.numTeams,
      rounds: ctx.rounds,
      snake_math: ctx.isAuction
        ? "not applicable (auction draft)"
        : ctx.type === "linear"
          ? "linear (every round runs slot 1..N)"
          : ctx.reversalRound
            ? `snake with reversal starting at round ${ctx.reversalRound} (3RR-style)`
            : "standard snake",
      reversal_round: ctx.reversalRound,
      pick_timer_seconds: ctx.draft.settings?.pick_timer ?? null,
      starting_slots: ctx.league?.roster_positions
        ? ctx.league.roster_positions.filter(
            (s) => !["BN", "IR", "TAXI"].includes(s),
          )
        : null,
      roster_positions: ctx.league?.roster_positions ?? null,
      draft_order: order,
      draft_order_set: ctx.draft.draft_order != null,
    });
  }),
);

server.registerTool(
  "get_draft_picks",
  {
    title: "Get picks made so far",
    description:
      "Ordered list of picks already made in a draft. Poll this every 5-10s " +
      "during a live draft. Player names/positions/teams are resolved from the " +
      "cached player dictionary (falling back to pick metadata).",
    inputSchema: {
      draft_id: z.string().min(1),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Only return the most recent N picks."),
    },
  },
  wrap(async ({ draft_id, limit }) => {
    const [picks, index] = await Promise.all([
      getDraftPicks(String(draft_id)),
      loadPlayers(),
    ]);
    picks.sort((a, b) => a.pick_no - b.pick_no);
    const sliced = limit ? picks.slice(-limit) : picks;
    return ok({
      draft_id,
      total_picks: picks.length,
      returned: sliced.length,
      picks: sliced.map((p) => {
        const player = resolvePickPlayer(p, index.byId);
        return {
          pick_no: p.pick_no,
          round: p.round,
          draft_slot: p.draft_slot,
          roster_id: p.roster_id,
          player_id: p.player_id,
          player: player.name,
          position: player.position,
          team: player.team,
          is_keeper: p.is_keeper ?? false,
        };
      }),
    });
  }),
);

server.registerTool(
  "get_available_players",
  {
    title: "Get undrafted players",
    description:
      "Players not yet drafted in this draft, from the cached dictionary minus " +
      "the picks made. Sorted by Sleeper's search_rank (rough ADP; lower is " +
      "better). Defaults to fantasy positions only and drops unranked players.",
    inputSchema: {
      draft_id: z.string().min(1),
      position: z
        .string()
        .optional()
        .describe("Filter to a single position, e.g. RB, WR, QB, TE, K, DEF."),
      search: z
        .string()
        .optional()
        .describe("Case-insensitive name substring filter."),
      limit: z.number().int().positive().max(500).optional().default(40),
      include_unranked: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include players with no search_rank (retired/deep roster)."),
      include_idp: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include IDP defensive positions (DL/LB/DB)."),
    },
  },
  wrap(async ({ draft_id, position, search, limit, include_unranked, include_idp }) => {
    const [picks, index] = await Promise.all([
      getDraftPicks(String(draft_id)),
      loadPlayers(),
    ]);
    const drafted = new Set(picks.map((p) => p.player_id));
    const posFilter = position?.toUpperCase();
    const nameFilter = search?.trim().toLowerCase();
    const allowedPositions = new Set<string>(
      include_idp ? ALL_KNOWN_POSITIONS : FANTASY_POSITIONS,
    );

    const available: SleeperPlayer[] = [];
    for (const player of index.byId.values()) {
      if (drafted.has(player.player_id)) continue;
      const pos = player.position ?? undefined;
      if (posFilter) {
        const matches =
          pos === posFilter ||
          (player.fantasy_positions ?? []).includes(posFilter);
        if (!matches) continue;
      } else if (!pos || !allowedPositions.has(pos)) {
        continue;
      }
      if (!include_unranked && player.search_rank == null) continue;
      if (nameFilter) {
        const nm = (
          player.full_name ??
          [player.first_name, player.last_name].filter(Boolean).join(" ")
        )
          .toLowerCase();
        if (!nm.includes(nameFilter)) continue;
      }
      available.push(player);
    }
    available.sort(bySearchRank);

    return ok({
      draft_id,
      filters: {
        position: posFilter ?? null,
        search: nameFilter ?? null,
        include_unranked,
        include_idp,
      },
      total_matching: available.length,
      returned: Math.min(limit, available.length),
      players: available.slice(0, limit).map(playerLabel),
    });
  }),
);

server.registerTool(
  "whose_turn",
  {
    title: "Whose pick is it",
    description:
      "Compute the pick currently on the clock from the number of picks made, " +
      "using snake-draft math (honours linear drafts and third-round reversal). " +
      "Pass my_roster_id to get an on_the_clock flag and picks-until-your-next-turn.",
    inputSchema: {
      draft_id: z.string().min(1),
      my_roster_id: z
        .number()
        .int()
        .optional()
        .describe("Your roster_id in the league; enables the 'you' fields."),
    },
  },
  wrap(async ({ draft_id, my_roster_id }) => {
    const ctx = await buildDraftContext({ draftId: String(draft_id) });
    if (ctx.isAuction) {
      return ok({
        draft_id,
        note: "This is an auction draft; there is no snake turn order.",
        status: ctx.draft.status,
      });
    }
    const picks = await getDraftPicks(String(draft_id));
    const picksMade = picks.length;
    const totalPicks = ctx.numTeams * ctx.rounds;

    if (picksMade >= totalPicks || ctx.draft.status === "complete") {
      return ok({
        draft_id,
        status: ctx.draft.status,
        picks_made: picksMade,
        total_picks: totalPicks,
        note: "Draft is complete.",
      });
    }

    const opts = {
      numTeams: ctx.numTeams,
      type: ctx.type,
      reversalRound: ctx.reversalRound,
    };
    const pos = currentPosition(picksMade, opts);
    const onClockRoster = ctx.slotToRosterId.get(pos.slot) ?? null;

    const result: Record<string, unknown> = {
      draft_id,
      status: ctx.draft.status,
      picks_made: picksMade,
      total_picks: totalPicks,
      on_the_clock: {
        overall_pick: pos.overallPick,
        round: pos.round,
        pick_in_round: pos.pickInRound,
        draft_slot: pos.slot,
        roster_id: onClockRoster,
        team: onClockRoster != null ? ctx.teamLabel(onClockRoster) : null,
      },
      next_up: [] as unknown[],
    };

    for (let i = 1; i <= Math.min(3, totalPicks - picksMade - 1); i++) {
      const p = positionForOverallPick(pos.overallPick + i, opts);
      const r = ctx.slotToRosterId.get(p.slot) ?? null;
      (result.next_up as unknown[]).push({
        overall_pick: p.overallPick,
        round: p.round,
        draft_slot: p.slot,
        roster_id: r,
        team: r != null ? ctx.teamLabel(r) : null,
      });
    }

    if (my_roster_id != null) {
      const mySlot = ctx.rosterIdToSlot.get(my_roster_id) ?? null;
      if (mySlot == null) {
        result.you = {
          warning: `roster_id ${my_roster_id} is not in this draft's slot mapping.`,
        };
      } else {
        const until = picksUntilSlot(mySlot, picksMade, ctx.rounds, opts);
        result.you = {
          roster_id: my_roster_id,
          draft_slot: mySlot,
          on_the_clock: onClockRoster === my_roster_id,
          picks_until_your_turn: until,
          your_remaining_picks: picksForSlot(mySlot, ctx.rounds, opts).filter(
            (n) => n > picksMade,
          ),
        };
      }
    }

    return ok(result);
  }),
);

server.registerTool(
  "get_my_roster_needs",
  {
    title: "Roster needs vs. required starters",
    description:
      "Compare the players a roster has drafted so far against the league's " +
      "required starting lineup and flag thin positions. Needs the league's " +
      "roster_positions, so pass league_id (or a draft_id whose league is known).",
    inputSchema: {
      league_id: z.string().optional(),
      draft_id: z.string().optional(),
      my_roster_id: z.number().int().describe("Your roster_id in the league."),
    },
  },
  wrap(async ({ league_id, draft_id, my_roster_id }) => {
    if (!league_id && !draft_id) {
      throw new Error("Provide league_id or draft_id.");
    }
    const ctx = await buildDraftContext({ leagueId: league_id, draftId: draft_id });
    if (!ctx.league?.roster_positions) {
      throw new Error(
        "Could not load league roster_positions (mock draft or unknown league). " +
          "Pass an explicit league_id.",
      );
    }
    const [picks, index] = await Promise.all([
      getDraftPicks(ctx.draft.draft_id),
      loadPlayers(),
    ]);
    const mine = picks.filter((p) => p.roster_id === my_roster_id);
    const draftedPositions = mine.map((p) => {
      const resolved = resolvePickPlayer(p, index.byId);
      return resolved.position ?? "";
    });
    const needs = computeRosterNeeds(ctx.league.roster_positions, draftedPositions);
    return ok({
      draft_id: ctx.draft.draft_id,
      league_id: ctx.league.league_id,
      my_roster_id,
      picks_made_by_me: mine.length,
      my_players: mine.map((p) => {
        const r = resolvePickPlayer(p, index.byId);
        return { pick_no: p.pick_no, name: r.name, position: r.position };
      }),
      needs,
    });
  }),
);

server.registerTool(
  "get_trending_players",
  {
    title: "Trending adds/drops",
    description:
      "Sleeper's trending players (most added or dropped across all leagues in " +
      "the lookback window). Rough signal only — NOT rankings or ADP.",
    inputSchema: {
      type: z.enum(["add", "drop"]).default("add"),
      lookback_hours: z.number().int().positive().max(168).optional().default(24),
      limit: z.number().int().positive().max(100).optional().default(25),
    },
  },
  wrap(async ({ type, lookback_hours, limit }) => {
    const [trending, index] = await Promise.all([
      getTrendingPlayers(type, "nfl", lookback_hours, limit),
      loadPlayers(),
    ]);
    return ok({
      type,
      lookback_hours,
      players: trending.map((t) => {
        const p = index.byId.get(t.player_id);
        return {
          player_id: t.player_id,
          count: t.count,
          name: p ? playerLabel(p).name : t.player_id,
          position: p?.position ?? null,
          team: p?.team ?? null,
        };
      }),
    });
  }),
);

server.registerTool(
  "refresh_player_cache",
  {
    title: "Force-refresh the player cache",
    description:
      "Re-download Sleeper's /players/nfl dictionary (~5MB) and rewrite the disk " +
      "cache. Normally automatic (daily); use this if names look stale.",
    inputSchema: {},
  },
  wrap(async () => {
    const index = await loadPlayers({ force: true });
    return ok({
      refreshed: true,
      cache_file: cacheLocation(),
      player_count: index.size,
      fetched_at: new Date(index.fetchedAt).toISOString(),
    });
  }),
);

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Warm the player cache in the background so the first real tool call is fast.
  loadPlayers().catch((err) => {
    console.error(`[sleeper-draft] player cache warm-up failed: ${err.message}`);
  });
  console.error("[sleeper-draft] MCP server running on stdio");
}

main().catch((err) => {
  console.error("[sleeper-draft] fatal:", err);
  process.exit(1);
});
