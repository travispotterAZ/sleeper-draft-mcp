/**
 * Roster-needs math: compare the players a team has drafted against the league's
 * required starting lineup and flag thin spots. Pure / testable.
 */

export const FLEX_ELIGIBILITY: Record<string, string[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};

const BENCH_SLOTS = new Set(["BN", "IR", "TAXI"]);

export interface FlexNeed {
  slotType: string;
  eligible: string[];
  slots: number;
  surplusAvailable: number;
  short: number; // slots we can't currently cover from surplus
}

export interface PositionNeed {
  position: string;
  requiredStarters: number;
  have: number;
  short: number; // requiredStarters - have, floored at 0
}

export interface RosterNeeds {
  startingSlots: string[];
  byPosition: PositionNeed[];
  flex: FlexNeed[];
  benchCount: number;
  thin: string[]; // human-readable summary of the gaps
}

/**
 * @param rosterPositions Sleeper league `roster_positions`, e.g.
 *   ["QB","RB","RB","WR","WR","TE","FLEX","K","DEF","BN","BN","BN"]
 * @param draftedPositions the primary position of each player the team owns,
 *   e.g. ["RB","WR","QB","RB"]
 */
export function computeRosterNeeds(
  rosterPositions: string[],
  draftedPositions: string[],
): RosterNeeds {
  const dedicatedSlots = new Map<string, number>();
  const flexSlots = new Map<string, number>();
  let benchCount = 0;

  for (const slot of rosterPositions) {
    if (BENCH_SLOTS.has(slot)) {
      benchCount++;
    } else if (FLEX_ELIGIBILITY[slot]) {
      flexSlots.set(slot, (flexSlots.get(slot) ?? 0) + 1);
    } else {
      dedicatedSlots.set(slot, (dedicatedSlots.get(slot) ?? 0) + 1);
    }
  }

  const have = new Map<string, number>();
  for (const pos of draftedPositions) {
    if (!pos) continue;
    have.set(pos, (have.get(pos) ?? 0) + 1);
  }

  // Dedicated positions first; track surplus for flex fills.
  const surplus = new Map<string, number>();
  for (const [pos, count] of have) surplus.set(pos, count);

  const byPosition: PositionNeed[] = [];
  for (const [position, requiredStarters] of [...dedicatedSlots].sort()) {
    const owned = have.get(position) ?? 0;
    const short = Math.max(0, requiredStarters - owned);
    byPosition.push({ position, requiredStarters, have: owned, short });
    surplus.set(position, Math.max(0, owned - requiredStarters));
  }

  // Flex slots consume surplus from their eligible positions (greedy, larger
  // eligibility sets processed last so specific flexes get first dibs).
  const flex: FlexNeed[] = [];
  const flexEntries = [...flexSlots].sort(
    (a, b) => FLEX_ELIGIBILITY[a[0]].length - FLEX_ELIGIBILITY[b[0]].length,
  );
  for (const [slotType, slots] of flexEntries) {
    const eligible = FLEX_ELIGIBILITY[slotType];
    let available = 0;
    for (const pos of eligible) available += surplus.get(pos) ?? 0;
    const filled = Math.min(slots, available);
    // Drain surplus proportionally-ish (just walk positions in order).
    let toDrain = filled;
    for (const pos of eligible) {
      if (toDrain <= 0) break;
      const s = surplus.get(pos) ?? 0;
      const take = Math.min(s, toDrain);
      surplus.set(pos, s - take);
      toDrain -= take;
    }
    flex.push({
      slotType,
      eligible,
      slots,
      surplusAvailable: available,
      short: slots - filled,
    });
  }

  const thin: string[] = [];
  for (const need of byPosition) {
    if (need.short > 0) {
      thin.push(
        `${need.position}: have ${need.have}, need ${need.requiredStarters} starter(s) (${need.short} short)`,
      );
    }
  }
  for (const f of flex) {
    if (f.short > 0) {
      thin.push(
        `${f.slotType} (${f.eligible.join("/")}): ${f.short} slot(s) not covered by surplus`,
      );
    }
  }

  return {
    startingSlots: rosterPositions.filter(
      (s) => !BENCH_SLOTS.has(s),
    ),
    byPosition,
    flex,
    benchCount,
    thin,
  };
}
