/**
 * Shared helper that turns a draft_id (or league_id) into a fully-resolved
 * picture of the draft: team count, slot<->roster<->owner mapping, draft
 * settings normalised for the snake-math module, etc.
 */

import {
  getDraft,
  getLeague,
  getLeagueDrafts,
  getLeagueRosters,
  getLeagueUsers,
  type SleeperDraft,
  type SleeperLeague,
  type SleeperRoster,
  type SleeperUser,
} from "./sleeper.ts";
import type { DraftType } from "./snake.ts";

export interface DraftContext {
  draft: SleeperDraft;
  league: SleeperLeague | null;
  numTeams: number;
  rounds: number;
  type: DraftType;
  isAuction: boolean;
  reversalRound: number | null;
  /** slot (1-indexed) -> roster_id */
  slotToRosterId: Map<number, number>;
  /** roster_id -> slot (1-indexed) */
  rosterIdToSlot: Map<number, number>;
  /** slot (1-indexed) -> user_id (from draft_order) */
  userIdBySlot: Map<number, string>;
  usersById: Map<string, SleeperUser>;
  rostersById: Map<number, SleeperRoster>;
  /** best available human label for a roster / team */
  teamLabel(rosterId: number | null | undefined): string;
  ownerLabel(userId: string | null | undefined): string;
}

export async function resolveDraftId(input: {
  draftId?: string;
  leagueId?: string;
}): Promise<string> {
  if (input.draftId) return input.draftId;
  if (!input.leagueId) {
    throw new Error("Provide either draft_id or league_id.");
  }
  const drafts = await getLeagueDrafts(input.leagueId);
  if (!drafts || drafts.length === 0) {
    throw new Error(`No drafts found for league ${input.leagueId}.`);
  }
  // Most recent draft first (Sleeper returns newest first, but sort to be sure).
  drafts.sort((a, b) => (b.start_time ?? 0) - (a.start_time ?? 0));
  return drafts[0].draft_id;
}

export async function buildDraftContext(input: {
  draftId?: string;
  leagueId?: string;
}): Promise<DraftContext> {
  const draftId = await resolveDraftId(input);
  const draft = await getDraft(draftId);

  const leagueId = draft.league_id ?? input.leagueId ?? null;
  let league: SleeperLeague | null = null;
  let users: SleeperUser[] = [];
  let rosters: SleeperRoster[] = [];
  if (leagueId) {
    // Mock drafts have no league; tolerate failures here rather than blow up.
    const results = await Promise.allSettled([
      getLeague(leagueId),
      getLeagueUsers(leagueId),
      getLeagueRosters(leagueId),
    ]);
    if (results[0].status === "fulfilled") league = results[0].value;
    if (results[1].status === "fulfilled") users = results[1].value;
    if (results[2].status === "fulfilled") rosters = results[2].value;
  }

  const numTeams =
    draft.settings?.teams ??
    league?.total_rosters ??
    (draft.slot_to_roster_id
      ? Object.keys(draft.slot_to_roster_id).length
      : 0);
  if (!numTeams || numTeams < 1) {
    throw new Error(
      `Could not determine team count for draft ${draftId}. draft.settings.teams is missing.`,
    );
  }

  const rounds =
    draft.settings?.rounds ??
    (league?.roster_positions ? league.roster_positions.length : 15);

  const isAuction = draft.type === "auction";
  const type: DraftType = draft.type === "linear" ? "linear" : "snake";
  const reversalRound =
    draft.settings?.reversal_round && draft.settings.reversal_round > 0
      ? draft.settings.reversal_round
      : null;

  const slotToRosterId = new Map<number, number>();
  const rosterIdToSlot = new Map<number, number>();
  if (draft.slot_to_roster_id) {
    for (const [slotStr, rosterId] of Object.entries(draft.slot_to_roster_id)) {
      const slot = Number(slotStr);
      slotToRosterId.set(slot, rosterId);
      rosterIdToSlot.set(rosterId, slot);
    }
  }

  const userIdBySlot = new Map<number, string>();
  if (draft.draft_order) {
    for (const [userId, slot] of Object.entries(draft.draft_order)) {
      userIdBySlot.set(Number(slot), userId);
    }
  }

  const usersById = new Map(users.map((u) => [u.user_id, u]));
  const rostersById = new Map(rosters.map((r) => [r.roster_id, r]));

  const ownerLabel = (userId: string | null | undefined): string => {
    if (!userId) return "(unknown owner)";
    const u = usersById.get(userId);
    if (!u) return `user ${userId}`;
    const teamName = u.metadata?.team_name;
    return teamName
      ? `${teamName} (${u.display_name ?? u.username ?? userId})`
      : u.display_name ?? u.username ?? `user ${userId}`;
  };

  const teamLabel = (rosterId: number | null | undefined): string => {
    if (rosterId == null) return "(unknown team)";
    const roster = rostersById.get(rosterId);
    const ownerId = roster?.owner_id ?? null;
    if (ownerId) return `${ownerLabel(ownerId)} [roster ${rosterId}]`;
    // Fall back to draft_order mapping via slot.
    const slot = rosterIdToSlot.get(rosterId);
    if (slot != null) {
      const userId = userIdBySlot.get(slot);
      if (userId) return `${ownerLabel(userId)} [roster ${rosterId}]`;
    }
    return `roster ${rosterId}`;
  };

  return {
    draft,
    league,
    numTeams,
    rounds,
    type,
    isAuction,
    reversalRound,
    slotToRosterId,
    rosterIdToSlot,
    userIdBySlot,
    usersById,
    rostersById,
    teamLabel,
    ownerLabel,
  };
}
