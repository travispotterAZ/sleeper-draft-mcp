// Browser-side client + adapter for ESPN fantasy football drafts (real leagues
// and mock-draft-lobby leagues).
//
// ESPN's read host, lm-api-reads.fantasy.espn.com, reflects the caller's Origin
// into Access-Control-Allow-Origin and allows the `x-fantasy-filter` request
// header, so a public league (mock or otherwise) is readable straight from a
// static page — no proxy, no espn_s2 / SWID cookies.
//
// Everything here normalises ESPN's payload into the SAME shapes app.js already
// gets back from lib/sleeper.js (`getDraft` / `getDraftPicks`), so the draft
// room, snake math, needs panel and advisor don't need to know the difference.

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const DEFAULT_SEASON = new Date().getFullYear();

async function j(url, { headers = {} } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      cache: "no-store",
    });
  } catch (err) {
    throw new Error(`Network error calling ESPN: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `ESPN returned ${res.status} — this league is private. Only public leagues ` +
        `(including mock-draft-lobby leagues) can be read without a login.`,
    );
  }
  if (res.status === 404) throw new Error(`ESPN 404 — no league with that ID for this season.`);
  if (res.status === 429) throw new Error(`ESPN rate-limited (429). Slow the polling down.`);
  if (!res.ok) throw new Error(`ESPN ${res.status} ${res.statusText}`);
  return res.json();
}

// One call carries draft picks, settings and teams. Cache-bust so a live poll
// can't get a stale edge response.
export function getLeagueRaw(leagueId, { season = DEFAULT_SEASON } = {}) {
  const u =
    `${BASE}/seasons/${season}/segments/0/leagues/${leagueId}` +
    `?view=mDraftDetail&view=mSettings&view=mTeam&_t=${Date.now()}`;
  return j(u);
}

// Top `limit` players by ESPN's own PPR draft ranking — enough to name every
// realistic pick in a 10-team/16-round draft and to fill the Available list.
export async function getPlayerPool(leagueId, { season = DEFAULT_SEASON, limit = 400 } = {}) {
  const filter = JSON.stringify({
    players: {
      limit,
      sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "PPR" },
    },
  });
  const raw = await j(
    `${BASE}/seasons/${season}/segments/0/leagues/${leagueId}?view=kona_player_info`,
    { headers: { "x-fantasy-filter": filter } },
  );
  return raw.players || [];
}

// ---------------------------------------------------------------- lookups
export const ESPN_POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF" };

// ESPN lineup-slot id -> the `slots_*` key rosterPositionsFromDraft() understands.
const SLOT_KEY = {
  0: "slots_qb",
  2: "slots_rb",
  3: "slots_wrrb_flex",
  4: "slots_wr",
  5: "slots_rec_flex",
  6: "slots_te",
  7: "slots_super_flex",
  16: "slots_def",
  17: "slots_k",
  20: "slots_bn",
  21: "slots_ir",
  23: "slots_flex",
};

const PRO_TEAM = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
  9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA",
  16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI",
  23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR",
  30: "JAX", 33: "BAL", 34: "HOU",
};

const INJ = {
  QUESTIONABLE: "Q",
  DOUBTFUL: "D",
  OUT: "O",
  SUSPENSION: "SUS",
  INJURY_RESERVE: "IR",
  DAY_TO_DAY: "DTD",
};

function slotCountsToSleeper(counts = {}) {
  const out = {};
  for (const [id, n] of Object.entries(counts)) {
    const key = SLOT_KEY[id];
    if (key && n) out[key] = (out[key] || 0) + Number(n);
  }
  return out;
}

// slot (1-indexed draft column) -> ESPN teamId, from the draft's pick order.
function slotToTeam(raw) {
  const order = raw.settings?.draftSettings?.pickOrder;
  const teams = raw.teams || [];
  const list = order && order.length ? order : teams.map((t) => t.id);
  const m = new Map();
  list.forEach((teamId, i) => m.set(i + 1, teamId));
  return m;
}

function teamLabel(team, teamId) {
  if (!team) return `Team ${teamId}`;
  return (
    team.name ||
    `${team.location || ""} ${team.nickname || ""}`.trim() ||
    team.abbrev ||
    `Team ${teamId}`
  );
}

// ---------------------------------------------------------------- adapters
// ESPN league payload -> Sleeper-shaped draft object (see lib/sleeper.js).
export function toDraft(raw, leagueId) {
  const s = raw.settings || {};
  const ds = s.draftSettings || {};
  const dd = raw.draftDetail || {};
  const teams = raw.teams || [];
  const picks = dd.picks || [];

  const numTeams = s.size || teams.length || (ds.pickOrder || []).length || 0;
  const totalPicks = picks.length;
  const rounds = numTeams ? Math.round(totalPicks / numTeams) || 0 : 0;
  // An unmade pick is playerId -1; a made pick is a real id, which for team
  // defenses (D/ST) is NEGATIVE (e.g. -16034), so only -1 means "empty".
  const made = picks.filter((p) => p.playerId !== -1).length;
  const status = dd.drafted
    ? "complete"
    : dd.inProgress || made > 0
      ? "drafting"
      : "pre_draft";

  const slotTeam = slotToTeam(raw);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const slot_to_roster_id = {};
  const slot_labels = {};
  for (const [slot, teamId] of slotTeam) {
    slot_to_roster_id[slot] = teamId;
    slot_labels[slot] = teamLabel(byId.get(teamId), teamId);
  }

  const scoring = (s.scoringSettings?.playerRankType || "").toLowerCase() || null;
  const type =
    ds.type === "SNAKE" ? "snake" : ds.type === "LINEAR" ? "linear" : "snake";

  return {
    draft_id: `espn_${leagueId}`,
    _platform: "espn",
    type,
    status,
    settings: {
      teams: numTeams,
      rounds,
      reversal_round: 0,
      scoring_type: scoring,
      ...slotCountsToSleeper(s.rosterSettings?.lineupSlotCounts),
    },
    slot_to_roster_id,
    slot_labels,
    draft_order: {},
    metadata: {
      name: s.name || `ESPN Mock ${leagueId}`,
      scoring_type: scoring,
    },
    league_id: null,
  };
}

// ESPN league payload -> Sleeper-shaped picks array. Player names are resolved by
// app.js from the loaded player map (player_id is the ESPN id), so `metadata`
// here is only a last-ditch fallback for players outside the loaded pool.
export function toPicks(raw) {
  const picks = raw.draftDetail?.picks || [];
  const teamSlot = new Map([...slotToTeam(raw)].map(([slot, teamId]) => [teamId, slot]));
  return picks
    .filter((p) => p.playerId !== -1) // -1 = unmade; D/ST ids are negative
    .sort((a, b) => a.overallPickNumber - b.overallPickNumber)
    .map((p) => ({
      pick_no: p.overallPickNumber,
      round: p.roundId,
      draft_slot: teamSlot.get(p.teamId) ?? p.teamId,
      roster_id: p.teamId,
      player_id: String(p.playerId),
      is_keeper: p.keeper || null,
      metadata: { first_name: "", last_name: String(p.playerId), position: null, team: null },
    }));
}

// kona_player_info rows -> the trimmed `{ id: {n,p,t,r,adp,fp,inj} }` map app.js
// expects in S.players (same shape as lib/players.js produces for Sleeper).
function trimPool(rows) {
  const players = {};
  for (const row of rows) {
    const pl = row.player || row;
    const pos = ESPN_POS[pl.defaultPositionId];
    if (!pos) continue;
    const ranks = pl.draftRanksByRankType || {};
    let rank = ranks.PPR?.rank;
    if (!(rank > 0)) rank = ranks.STANDARD?.rank;
    const adp = pl.ownership?.averageDraftPosition ?? null;
    players[String(pl.id)] = {
      n: pl.fullName || `${pl.firstName || ""} ${pl.lastName || ""}`.trim() || String(pl.id),
      p: pos,
      t: PRO_TEAM[pl.proTeamId] || null,
      // `r` mirrors Sleeper's search_rank (overall draft order). Fall back to
      // rounded ADP so kickers / D-STs without an editorial rank still sort.
      r: rank > 0 ? rank : adp ? Math.round(adp) : null,
      adp,
      fp: [pos],
      inj: INJ[pl.injuryStatus] || null,
    };
  }
  return players;
}

const POOL_KEY = (leagueId) => `espn_players_${leagueId}`;
const POOL_TTL_MS = 6 * 60 * 60 * 1000;

export async function loadEspnPlayers(leagueId, { season, force = false } = {}) {
  if (!force) {
    try {
      const env = JSON.parse(localStorage.getItem(POOL_KEY(leagueId)) || "null");
      if (env && env.players && Date.now() - env.fetchedAt < POOL_TTL_MS) return env.players;
    } catch {
      /* ignore malformed cache */
    }
  }
  const players = trimPool(await getPlayerPool(leagueId, { season }));
  try {
    localStorage.setItem(
      POOL_KEY(leagueId),
      JSON.stringify({ fetchedAt: Date.now(), players }),
    );
  } catch {
    /* quota / private mode */
  }
  return players;
}

export function clearEspnPlayerCache(leagueId) {
  try {
    localStorage.removeItem(POOL_KEY(leagueId));
  } catch {
    /* ignore */
  }
}
