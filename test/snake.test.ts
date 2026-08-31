import test from "node:test";
import assert from "node:assert/strict";

import {
  currentPosition,
  picksForSlot,
  picksUntilSlot,
  positionForOverallPick,
  roundIsForward,
} from "../src/snake.ts";

const TEN = { numTeams: 10, type: "snake" as const };

test("standard snake: round 1 runs slots 1..N in order", () => {
  for (let pick = 1; pick <= 10; pick++) {
    const p = positionForOverallPick(pick, TEN);
    assert.equal(p.round, 1);
    assert.equal(p.pickInRound, pick);
    assert.equal(p.slot, pick);
  }
});

test("standard snake: round 2 reverses (pick 11 -> slot 10, pick 20 -> slot 1)", () => {
  assert.deepEqual(positionForOverallPick(11, TEN), {
    overallPick: 11,
    round: 2,
    pickInRound: 1,
    slot: 10,
  });
  assert.deepEqual(positionForOverallPick(20, TEN), {
    overallPick: 20,
    round: 2,
    pickInRound: 10,
    slot: 1,
  });
});

test("standard snake: round 3 is forward again (pick 21 -> slot 1)", () => {
  assert.equal(positionForOverallPick(21, TEN).slot, 1);
  assert.equal(positionForOverallPick(30, TEN).slot, 10);
});

test("known 12-team draft order, first 3 rounds", () => {
  const opts = { numTeams: 12, type: "snake" as const };
  const slotFor = (n: number) => positionForOverallPick(n, opts).slot;
  // Round 1: 1..12
  assert.deepEqual([...Array(12)].map((_, i) => slotFor(i + 1)), [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  ]);
  // Round 2: 12..1
  assert.deepEqual([...Array(12)].map((_, i) => slotFor(i + 13)), [
    12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
  ]);
  // Round 3: 1..12
  assert.deepEqual([...Array(12)].map((_, i) => slotFor(i + 25)), [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  ]);
});

test("linear draft: every round runs slots 1..N", () => {
  const opts = { numTeams: 8, type: "linear" as const };
  assert.equal(positionForOverallPick(1, opts).slot, 1);
  assert.equal(positionForOverallPick(9, opts).slot, 1); // round 2, pick 1
  assert.equal(positionForOverallPick(16, opts).slot, 8);
  assert.equal(positionForOverallPick(17, opts).slot, 1); // round 3
});

test("third-round reversal (reversalRound=3), 10 teams", () => {
  const opts = { numTeams: 10, type: "snake" as const, reversalRound: 3 };
  const slotFor = (n: number) => positionForOverallPick(n, opts).slot;
  // R1 forward
  assert.equal(slotFor(1), 1);
  assert.equal(slotFor(10), 10);
  // R2 backward
  assert.equal(slotFor(11), 10);
  assert.equal(slotFor(20), 1);
  // R3 ALSO backward (the reversal)
  assert.equal(slotFor(21), 10);
  assert.equal(slotFor(30), 1);
  // R4 forward again
  assert.equal(slotFor(31), 1);
  assert.equal(slotFor(40), 10);
  // R5 backward
  assert.equal(slotFor(41), 10);
});

test("roundIsForward matches the parity rules", () => {
  assert.equal(roundIsForward(1, "snake"), true);
  assert.equal(roundIsForward(2, "snake"), false);
  assert.equal(roundIsForward(3, "snake"), true);
  assert.equal(roundIsForward(3, "snake", 3), false); // 3RR flips it
  assert.equal(roundIsForward(4, "snake", 3), true);
  assert.equal(roundIsForward(7, "linear"), true);
  assert.equal(roundIsForward(8, "linear", 3), true);
});

test("currentPosition: picksMade -> pick on the clock", () => {
  assert.equal(currentPosition(0, TEN).overallPick, 1);
  assert.equal(currentPosition(0, TEN).slot, 1);
  assert.equal(currentPosition(10, TEN).overallPick, 11);
  assert.equal(currentPosition(10, TEN).slot, 10);
});

test("picksForSlot: slot 3 in a 10-team, 5-round snake", () => {
  assert.deepEqual(picksForSlot(3, 5, TEN), [3, 18, 23, 38, 43]);
});

test("picksForSlot: slot 1 and slot 10 turn points in snake", () => {
  // slot 1 picks 1, then 20 (last of R2), then 21 (first of R3) -> back-to-back
  assert.deepEqual(picksForSlot(1, 3, TEN), [1, 20, 21]);
  // slot 10 picks 10 then 11 -> back-to-back at the turn
  assert.deepEqual(picksForSlot(10, 3, TEN), [10, 11, 30]);
});

test("picksUntilSlot: counts from the pick on the clock", () => {
  // 5 picks made -> pick 6 on the clock. Slot 8 picks at 8 -> 2 picks away.
  assert.equal(picksUntilSlot(8, 5, 5, TEN), 2);
  // Slot 6 picks at 6 -> on the clock right now (0 away).
  assert.equal(picksUntilSlot(6, 5, 5, TEN), 0);
  // No picks left for the slot within the round budget.
  assert.equal(picksUntilSlot(1, 45, 4, TEN), null);
});

test("input validation", () => {
  assert.throws(() => positionForOverallPick(0, TEN), /positive integer/);
  assert.throws(() => positionForOverallPick(1, { numTeams: 0 }), /positive integer/);
  assert.throws(() => currentPosition(-1, TEN), /non-negative/);
  assert.throws(() => picksForSlot(11, 3, TEN), /between 1 and 10/);
});
