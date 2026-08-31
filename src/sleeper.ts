/**
 * Thin client for Sleeper's public REST API.
 *
 * Everything here uses https://api.sleeper.app/v1 and needs NO authentication.
 * If any call ever comes back 401/403 we surface it loudly (see `SleeperError`)
 * so it can be flagged rather than silently swallowed.
 */

const BASE_URL = "https://api.sleeper.app/v1";

export class SleeperError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SleeperError";
    this.status = status;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new SleeperError(
      `Network error calling Sleeper (${path}): ${(err as Error).message}`,
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new SleeperError(
      `Sleeper returned ${res.status} for ${path}. This endpoint appears to require ` +
        `authentication, which this server intentionally does not support. Please flag this.`,
      res.status,
    );
  }
  if (res.status === 404) {
    throw new SleeperError(
      `Sleeper returned 404 for ${path}. Double-check the username / id / season.`,
      404,
    );
  }
  if (res.status === 429) {
    throw new SleeperError(
      `Sleeper rate-limited the request (429) for ${path}. Back off polling and retry.`,
      429,
    );
  }
  if (!res.ok) {
    throw new SleeperError(
      `Sleeper request failed: ${res.status} ${res.statusText} for ${path}`,
      res.status,
    );
  }

  return (await res.json()) as T;
}

/**
 * Several Sleeper endpoints answer 200 with a bare `null` body when the thing
 * doesn't exist (unknown username, league with no drafts, ...). Turn that into a
 * clear error instead of a downstream "cannot read properties of null".
 */
async function getJsonNonNull<T>(path: string, whatWasMissing: string): Promise<T> {
  const value = await getJson<T | null>(path);
  if (value == null) {
    throw new SleeperError(`Sleeper has no ${whatWasMissing} (${path} returned null).`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Response shapes (only the fields we actually use)
// ---------------------------------------------------------------------------

export interface SleeperUser {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar: string | null;
  metadata?: Record<string, string> | null;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  sport: string;
  status: string;
  total_rosters: number;
  draft_id: string | null;
  scoring_settings?: Record<string, number>;
  roster_positions?: string[];
  settings?: Record<string, number>;
}

export interface SleeperDraftSettings {
  teams?: number;
  rounds?: number;
  reversal_round?: number;
  pick_timer?: number;
  [key: string]: number | undefined;
}

export interface SleeperDraft {
  draft_id: string;
  league_id: string | null;
  type: "snake" | "linear" | "auction" | string;
  status: "pre_draft" | "drafting" | "paused" | "complete" | string;
  season: string;
  sport: string;
  start_time: number | null;
  settings: SleeperDraftSettings;
  /** user_id -> draft slot (1-indexed). null until the order is set. */
  draft_order: Record<string, number> | null;
  /** draft slot (as string, 1-indexed) -> roster_id */
  slot_to_roster_id: Record<string, number> | null;
  metadata?: Record<string, string>;
}

export interface SleeperPickMetadata {
  first_name?: string;
  last_name?: string;
  position?: string;
  team?: string;
  status?: string;
  injury_status?: string;
  [key: string]: string | undefined;
}

export interface SleeperPick {
  draft_id: string;
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number | null;
  picked_by: string; // user_id ("" for autopick in some drafts)
  player_id: string;
  is_keeper: boolean | null;
  metadata?: SleeperPickMetadata;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  league_id: string;
  players: string[] | null;
  starters: string[] | null;
}

export interface SleeperPlayer {
  player_id: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  position?: string | null;
  team?: string | null;
  fantasy_positions?: string[] | null;
  status?: string | null;
  injury_status?: string | null;
  age?: number | null;
  years_exp?: number | null;
  /** Sleeper's rough draft-value ordering; lower = more valuable. Often null. */
  search_rank?: number | null;
  search_full_name?: string | null;
}

export interface SleeperState {
  season: string;
  season_type: string;
  week: number;
  leg: number;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export function getState(sport = "nfl"): Promise<SleeperState> {
  return getJson<SleeperState>(`/state/${sport}`);
}

export function getUserByName(username: string): Promise<SleeperUser> {
  return getJsonNonNull<SleeperUser>(
    `/user/${encodeURIComponent(username)}`,
    `user named "${username}"`,
  );
}

export function getUserLeagues(
  userId: string,
  season: string | number,
  sport = "nfl",
): Promise<SleeperLeague[]> {
  return getJson<SleeperLeague[]>(
    `/user/${encodeURIComponent(userId)}/leagues/${sport}/${season}`,
  );
}

export function getLeague(leagueId: string): Promise<SleeperLeague> {
  return getJsonNonNull<SleeperLeague>(
    `/league/${encodeURIComponent(leagueId)}`,
    `league with id ${leagueId}`,
  );
}

export function getLeagueDrafts(leagueId: string): Promise<SleeperDraft[]> {
  return getJsonNonNull<SleeperDraft[]>(
    `/league/${encodeURIComponent(leagueId)}/drafts`,
    `drafts for league ${leagueId}`,
  );
}

export function getLeagueUsers(leagueId: string): Promise<SleeperUser[]> {
  return getJson<SleeperUser[]>(`/league/${encodeURIComponent(leagueId)}/users`);
}

export function getLeagueRosters(leagueId: string): Promise<SleeperRoster[]> {
  return getJson<SleeperRoster[]>(`/league/${encodeURIComponent(leagueId)}/rosters`);
}

export function getDraft(draftId: string): Promise<SleeperDraft> {
  return getJsonNonNull<SleeperDraft>(
    `/draft/${encodeURIComponent(draftId)}`,
    `draft with id ${draftId}`,
  );
}

export function getDraftPicks(draftId: string): Promise<SleeperPick[]> {
  return getJsonNonNull<SleeperPick[]>(
    `/draft/${encodeURIComponent(draftId)}/picks`,
    `picks for draft ${draftId}`,
  );
}

export function getAllPlayers(
  sport = "nfl",
): Promise<Record<string, SleeperPlayer>> {
  // ~5MB payload. Callers MUST cache this (see players.ts).
  return getJson<Record<string, SleeperPlayer>>(`/players/${sport}`);
}

export interface TrendingPlayer {
  player_id: string;
  count: number;
}

export function getTrendingPlayers(
  type: "add" | "drop",
  sport = "nfl",
  lookbackHours = 24,
  limit = 25,
): Promise<TrendingPlayer[]> {
  return getJson<TrendingPlayer[]>(
    `/players/${sport}/trending/${type}?lookback_hours=${lookbackHours}&limit=${limit}`,
  );
}
