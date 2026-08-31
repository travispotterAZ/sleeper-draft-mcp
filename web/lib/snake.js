// Pure draft-position math — a browser port of the MCP server's src/snake.ts.
// snake / linear / third-round-reversal (3RR).

export function roundIsForward(round, type, reversalRound) {
  if (type === "linear") return true;
  let forward = round % 2 === 1; // plain snake: odd rounds go forward
  if (reversalRound && reversalRound > 0 && round >= reversalRound) forward = !forward;
  return forward;
}

// overallPick is 1-indexed. Returns { overallPick, round, pickInRound, slot } (all 1-indexed).
export function positionForOverallPick(overallPick, { numTeams, type = "snake", reversalRound = null }) {
  const zero = overallPick - 1;
  const round = Math.floor(zero / numTeams) + 1;
  const posZero = zero % numTeams;
  const forward = roundIsForward(round, type, reversalRound);
  const slotZero = forward ? posZero : numTeams - 1 - posZero;
  return { overallPick, round, pickInRound: posZero + 1, slot: slotZero + 1 };
}

// Inverse: which overall pick number belongs to (round, slot)?
export function overallPickFor(round, slot, { numTeams, type = "snake", reversalRound = null }) {
  const forward = roundIsForward(round, type, reversalRound);
  const posInRound = forward ? slot : numTeams - slot + 1; // 1-indexed
  return (round - 1) * numTeams + posInRound;
}

// picksMade -> the pick now on the clock.
export function currentPosition(picksMade, opts) {
  return positionForOverallPick(picksMade + 1, opts);
}

// Every overall pick number owned by `slot` across `rounds` rounds.
export function picksForSlot(slot, rounds, opts) {
  const out = [];
  for (let r = 1; r <= rounds; r++) out.push(overallPickFor(r, slot, opts));
  return out;
}

// Picks until `slot` is next on the clock, counting from the pick on the clock.
// 0 = on the clock now; null = no picks left within `rounds`.
export function picksUntilSlot(slot, picksMade, rounds, opts) {
  const next = picksMade + 1;
  const upcoming = picksForSlot(slot, rounds, opts).filter((p) => p >= next);
  return upcoming.length ? upcoming[0] - next : null;
}
