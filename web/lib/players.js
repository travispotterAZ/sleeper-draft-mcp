// Loads Sleeper's ~5MB /players/nfl dictionary once, trims it to fantasy-relevant
// players, and caches THAT (a few tens of KB) in localStorage for 24h so repeat
// visits don't re-download 5MB.

import { getAllPlayers } from "./sleeper.js";

const KEY = "sleeper_players_v2";
const TTL_MS = 24 * 60 * 60 * 1000;
const KEEP = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

function trim(dict) {
  const players = {};
  for (const id in dict) {
    const p = dict[id];
    const pos = p.position;
    if (!pos || !KEEP.has(pos)) continue;
    // keep anyone ranked, or anyone currently on an NFL roster
    if (p.search_rank == null && !p.team) continue;
    players[id] = {
      n: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id,
      p: pos,
      t: p.team || null,
      r: typeof p.search_rank === "number" ? p.search_rank : null,
      fp: Array.isArray(p.fantasy_positions) ? p.fantasy_positions : null,
      inj: p.injury_status || null,
    };
  }
  return players;
}

export async function loadPlayers({ force = false } = {}) {
  if (!force) {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const env = JSON.parse(raw);
        if (env && env.players && Date.now() - env.fetchedAt < TTL_MS) {
          return { ...env, fromCache: true };
        }
      }
    } catch {
      /* ignore malformed cache */
    }
  }

  const dict = await getAllPlayers();
  const env = { fetchedAt: Date.now(), players: trim(dict) };
  try {
    localStorage.setItem(KEY, JSON.stringify(env));
  } catch {
    /* quota / private mode — just keep it in memory for this session */
  }
  return { ...env, fromCache: false };
}

export function clearPlayerCache() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
