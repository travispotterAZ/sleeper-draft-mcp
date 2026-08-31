/**
 * Pure draft-position math. No I/O, no Sleeper types — easy to unit test.
 *
 * Vocabulary:
 *   - overallPick   1-indexed pick number across the whole draft (1, 2, 3, ...)
 *   - round         1-indexed round number
 *   - pickInRound   1-indexed position within the round
 *   - slot          1-indexed draft slot (the seat at the table). In a snake
 *                   draft the slot that picks in round 1 at position k also owns
 *                   every future round; only the *order* the slots pick in flips.
 *
 * Draft types handled:
 *   - "linear"  every round runs slots 1..N
 *   - "snake"   odd rounds run 1..N, even rounds run N..1
 *   - snake + "reversal_round" (a.k.a. third-round reversal / 3RR): the flip that
 *     would normally happen going into `reversalRound` is applied one round early
 *     and then continues alternating. Concretely with reversalRound = 3:
 *       R1 -> 1..N, R2 -> N..1, R3 -> N..1, R4 -> 1..N, R5 -> N..1, ...
 */

export type DraftType = "snake" | "linear";

export interface DraftMathOptions {
  numTeams: number;
  type?: DraftType;
  /** Sleeper's `settings.reversal_round`. 0 / undefined / null means "no reversal". */
  reversalRound?: number | null;
}

export interface DraftPosition {
  overallPick: number;
  round: number;
  pickInRound: number;
  slot: number;
}

function assertValid(numTeams: number, overallPick: number): void {
  if (!Number.isInteger(numTeams) || numTeams < 1) {
    throw new Error(`numTeams must be a positive integer, got ${numTeams}`);
  }
  if (!Number.isInteger(overallPick) || overallPick < 1) {
    throw new Error(`overallPick must be a positive integer, got ${overallPick}`);
  }
}

/** Does this round run its slots low->high (true) or high->low (false)? */
export function roundIsForward(
  round: number,
  type: DraftType,
  reversalRound?: number | null,
): boolean {
  if (type === "linear") return true;

  let forward = round % 2 === 1; // plain snake: odd rounds go forward
  if (reversalRound && reversalRound > 0 && round >= reversalRound) {
    forward = !forward;
  }
  return forward;
}

/** Which draft slot (1-indexed) is on the clock for a given overall pick. */
export function positionForOverallPick(
  overallPick: number,
  opts: DraftMathOptions,
): DraftPosition {
  const { numTeams, type = "snake", reversalRound = null } = opts;
  assertValid(numTeams, overallPick);

  const zeroBased = overallPick - 1;
  const round = Math.floor(zeroBased / numTeams) + 1;
  const posInRoundZero = zeroBased % numTeams;

  const forward = roundIsForward(round, type, reversalRound);
  const slotZero = forward ? posInRoundZero : numTeams - 1 - posInRoundZero;

  return {
    overallPick,
    round,
    pickInRound: posInRoundZero + 1,
    slot: slotZero + 1,
  };
}

/**
 * Given how many picks have already been made, describe the pick that is now
 * on the clock (i.e. pick number picksMade + 1).
 */
export function currentPosition(
  picksMade: number,
  opts: DraftMathOptions,
): DraftPosition {
  if (!Number.isInteger(picksMade) || picksMade < 0) {
    throw new Error(`picksMade must be a non-negative integer, got ${picksMade}`);
  }
  return positionForOverallPick(picksMade + 1, opts);
}

/** Every overall pick number that belongs to `slot`, for `rounds` rounds. */
export function picksForSlot(
  slot: number,
  rounds: number,
  opts: DraftMathOptions,
): number[] {
  const { numTeams, type = "snake", reversalRound = null } = opts;
  if (!Number.isInteger(slot) || slot < 1 || slot > numTeams) {
    throw new Error(`slot must be between 1 and ${numTeams}, got ${slot}`);
  }
  const out: number[] = [];
  for (let round = 1; round <= rounds; round++) {
    const forward = roundIsForward(round, type, reversalRound);
    const posInRoundZero = forward ? slot - 1 : numTeams - slot;
    out.push((round - 1) * numTeams + posInRoundZero + 1);
  }
  return out;
}

/**
 * How many picks until `slot` is next on the clock, counting from the pick that
 * is currently on the clock. Returns 0 if `slot` is on the clock right now.
 * Returns null if the slot has no remaining picks within `rounds`.
 */
export function picksUntilSlot(
  slot: number,
  picksMade: number,
  rounds: number,
  opts: DraftMathOptions,
): number | null {
  const nextOverall = picksMade + 1;
  const upcoming = picksForSlot(slot, rounds, opts).filter(
    (p) => p >= nextOverall,
  );
  if (upcoming.length === 0) return null;
  return upcoming[0] - nextOverall;
}
