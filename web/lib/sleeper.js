// Browser-side client for Sleeper's public, keyless REST API.
// Sleeper sends `access-control-allow-origin: *`, so this works from any origin
// (including a github.io Pages site) with no proxy.

const BASE = "https://api.sleeper.app/v1";

async function j(path, { bust = false } = {}) {
  // `bust` appends a throwaway query param so Sleeper's CDN edge cache can't
  // hand back a stale (or empty, pre-draft) response to a live poll.
  const url =
    BASE + path + (bust ? (path.includes("?") ? "&" : "?") + "_t=" + Date.now() : "");
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  } catch (err) {
    throw new Error(`Network error calling Sleeper (${path}): ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Sleeper returned ${res.status} for ${path} — an endpoint that used to be ` +
        `keyless now wants auth. Please flag this.`,
    );
  }
  if (res.status === 404) throw new Error(`Sleeper 404 for ${path}`);
  if (res.status === 429) throw new Error(`Sleeper rate-limited (429). Slow the polling down.`);
  if (!res.ok) throw new Error(`Sleeper ${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

export const getState = () => j(`/state/nfl`);
export const getUser = (name) => j(`/user/${encodeURIComponent(name)}`);
export const getUserLeagues = (uid, season) => j(`/user/${uid}/leagues/nfl/${season}`);
export const getLeague = (id) => j(`/league/${id}`);
export const getLeagueDrafts = (id) => j(`/league/${id}/drafts`);
export const getLeagueUsers = (id) => j(`/league/${id}/users`);
export const getLeagueRosters = (id) => j(`/league/${id}/rosters`);
export const getDraft = (id) => j(`/draft/${id}`, { bust: true });
export const getDraftPicks = (id) => j(`/draft/${id}/picks`, { bust: true });
export const getAllPlayers = () => j(`/players/nfl`);
