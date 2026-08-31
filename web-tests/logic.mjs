// Quick parity check: the browser snake.js port must agree with known results.
import assert from "node:assert/strict";
import { positionForOverallPick, overallPickFor, picksUntilSlot } from "../web/lib/snake.js";

const T10 = { numTeams: 10, type: "snake" };

// round 1 forward, round 2 reversed, round 3 forward
assert.equal(positionForOverallPick(1, T10).slot, 1);
assert.equal(positionForOverallPick(10, T10).slot, 10);
assert.equal(positionForOverallPick(11, T10).slot, 10);
assert.equal(positionForOverallPick(20, T10).slot, 1);
assert.equal(positionForOverallPick(21, T10).slot, 1);

// inverse round-trips
for (let r = 1; r <= 6; r++) {
  for (let s = 1; s <= 10; s++) {
    const overall = overallPickFor(r, s, T10);
    const back = positionForOverallPick(overall, T10);
    assert.equal(back.round, r);
    assert.equal(back.slot, s);
  }
}

// 3RR
const RR = { numTeams: 10, type: "snake", reversalRound: 3 };
assert.equal(positionForOverallPick(21, RR).slot, 10); // R3 stays reversed
assert.equal(positionForOverallPick(31, RR).slot, 1); // R4 back to forward

// linear
const L = { numTeams: 8, type: "linear" };
assert.equal(positionForOverallPick(9, L).slot, 1);
assert.equal(positionForOverallPick(16, L).slot, 8);

// picksUntilSlot
assert.equal(picksUntilSlot(8, 5, 5, T10), 2);
assert.equal(picksUntilSlot(6, 5, 5, T10), 0);

console.log("web snake.js port: all parity checks passed");
