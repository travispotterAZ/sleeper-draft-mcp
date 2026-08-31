/**
 * Disk-backed cache for Sleeper's ~5MB /players/nfl dictionary, plus lookup
 * indexes built on top of it.
 *
 * - Cache file:   <cacheDir>/players.json   (cacheDir defaults to ./cache next
 *                 to the project, override with SLEEPER_CACHE_DIR)
 * - Refresh rule: re-fetch if the file is missing or older than 24h.
 * - In memory:    a Map by player_id and a lowercased name list for fuzzy search.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAllPlayers, type SleeperPlayer } from "./sleeper.ts";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const DEFAULT_CACHE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "cache",
);

function cacheDir(): string {
  return process.env.SLEEPER_CACHE_DIR
    ? path.resolve(process.env.SLEEPER_CACHE_DIR)
    : DEFAULT_CACHE_DIR;
}

function cacheFile(): string {
  return path.join(cacheDir(), "players.json");
}

export interface PlayerName {
  id: string;
  nameLower: string;
}

export class PlayerIndex {
  readonly byId: Map<string, SleeperPlayer>;
  readonly fetchedAt: number;
  private readonly names: PlayerName[];

  constructor(players: Record<string, SleeperPlayer>, fetchedAt: number) {
    this.byId = new Map(Object.entries(players));
    this.fetchedAt = fetchedAt;
    this.names = [];
    const seen = new Set<string>();
    for (const [id, p] of this.byId) {
      const display =
        p.full_name ||
        [p.first_name, p.last_name].filter(Boolean).join(" ") ||
        p.search_full_name ||
        "";
      const nameLower = display.trim().toLowerCase();
      if (!nameLower) continue;
      const dedupeKey = `${nameLower}|${p.position ?? ""}|${p.team ?? ""}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      this.names.push({ id, nameLower });
    }
  }

  get size(): number {
    return this.byId.size;
  }

  get ageMs(): number {
    return Date.now() - this.fetchedAt;
  }

  displayName(player: SleeperPlayer): string {
    return (
      player.full_name ||
      [player.first_name, player.last_name].filter(Boolean).join(" ") ||
      player.search_full_name ||
      player.player_id
    );
  }

  /**
   * Fuzzy-ish name search: case-insensitive substring match on the display name,
   * then ranked by Sleeper's search_rank (nulls last). Good enough for "who is
   * ceedee lamb" style lookups without pulling in a fuzzy-match dependency.
   */
  search(query: string, limit = 10): SleeperPlayer[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: SleeperPlayer[] = [];
    for (const { id, nameLower } of this.names) {
      if (nameLower.includes(q)) {
        const p = this.byId.get(id);
        if (p) hits.push(p);
      }
    }
    return hits.sort(bySearchRank).slice(0, limit);
  }
}

export function bySearchRank(a: SleeperPlayer, b: SleeperPlayer): number {
  const ra = a.search_rank ?? Number.MAX_SAFE_INTEGER;
  const rb = b.search_rank ?? Number.MAX_SAFE_INTEGER;
  return ra - rb;
}

interface CacheEnvelope {
  fetchedAt: number;
  sport: string;
  players: Record<string, SleeperPlayer>;
}

let cached: PlayerIndex | null = null;
let inflight: Promise<PlayerIndex> | null = null;

async function readCacheFile(): Promise<CacheEnvelope | null> {
  try {
    const raw = await fs.readFile(cacheFile(), "utf8");
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (!parsed || typeof parsed !== "object" || !parsed.players) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCacheFile(envelope: CacheEnvelope): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true });
  const tmp = `${cacheFile()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(envelope), "utf8");
  await fs.rename(tmp, cacheFile());
}

/**
 * Return the player index, loading from disk or the network as needed.
 * Concurrent callers share one in-flight fetch. Pass force=true to bypass the
 * freshness check and re-download.
 */
export async function loadPlayers(
  opts: { force?: boolean; sport?: string } = {},
): Promise<PlayerIndex> {
  const { force = false, sport = "nfl" } = opts;

  if (!force && cached && cached.ageMs < MAX_AGE_MS) return cached;
  if (!force && inflight) return inflight;

  inflight = (async () => {
    if (!force) {
      const disk = await readCacheFile();
      if (disk && Date.now() - disk.fetchedAt < MAX_AGE_MS) {
        cached = new PlayerIndex(disk.players, disk.fetchedAt);
        return cached;
      }
    }

    const players = await getAllPlayers(sport);
    const fetchedAt = Date.now();
    await writeCacheFile({ fetchedAt, sport, players }).catch((err) => {
      // A failed cache write is non-fatal; we just won't persist this run.
      console.error(`[players] failed to write cache: ${(err as Error).message}`);
    });
    cached = new PlayerIndex(players, fetchedAt);
    return cached;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function cacheLocation(): string {
  return cacheFile();
}
