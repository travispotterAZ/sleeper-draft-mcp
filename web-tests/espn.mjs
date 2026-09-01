// The ESPN adapter must emit the same shapes app.js gets from lib/sleeper.js.
import assert from "node:assert/strict";
import { toDraft, toPicks } from "../web/lib/espn.js";

// Trimmed stand-in for a real lm-api-reads league payload
// (?view=mDraftDetail&view=mSettings&view=mTeam).
const raw = {
  settings: {
    size: 10,
    name: "Beginner 10-Team H2H Points PPR Mock",
    draftSettings: { type: "SNAKE", pickOrder: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    rosterSettings: {
      lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 20: 7, 21: 1, 23: 1 },
    },
    scoringSettings: { playerRankType: "PPR" },
  },
  teams: [
    { id: 1, abbrev: "HHT", name: "Heidi's Heated Team" },
    { id: 2, abbrev: "MMT", name: "Matthew's Magnificent Team" },
    { id: 3, abbrev: "LLT", name: "Logan's Loud Team" },
    { id: 4, abbrev: "TTT", name: "Travis's Talented Team" },
    { id: 5, abbrev: "MXT", name: "Maxwell's Monstrous Team" },
    { id: 6, abbrev: "CCT", name: "Carter's Competitive Team" },
    { id: 7, abbrev: "TYT", name: "Tyler's Top Team" },
    { id: 8, abbrev: "SST", name: "Steve's Smart Team" },
    { id: 9, abbrev: "TM9", name: "Team 9" },
    { id: 10, abbrev: "JST", name: "Jordan's Scary Team" },
  ],
  draftDetail: {
    drafted: false,
    inProgress: true,
    picks: [
      // round 1: three real picks then the rest unmade
      { overallPickNumber: 1, roundId: 1, roundPickNumber: 1, teamId: 1, playerId: 4429795 },
      { overallPickNumber: 2, roundId: 1, roundPickNumber: 2, teamId: 2, playerId: 4430807 },
      { overallPickNumber: 3, roundId: 1, roundPickNumber: 3, teamId: 3, playerId: 4362628 },
      ...Array.from({ length: 7 }, (_, i) => ({
        overallPickNumber: 4 + i,
        roundId: 1,
        roundPickNumber: 4 + i,
        teamId: 4 + i,
        playerId: -1,
      })),
      // round 2 snakes back: pick 1 belongs to slot 10, and it's a D/ST (negative id)
      { overallPickNumber: 11, roundId: 2, roundPickNumber: 1, teamId: 10, playerId: -16034 },
      ...Array.from({ length: 9 }, (_, i) => ({
        overallPickNumber: 12 + i,
        roundId: 2,
        roundPickNumber: 2 + i,
        teamId: 9 - i,
        playerId: -1,
      })),
    ],
  },
};

const d = toDraft(raw, "205412306");
assert.equal(d.draft_id, "espn_205412306");
assert.equal(d.type, "snake");
assert.equal(d.status, "drafting");
assert.equal(d.settings.teams, 10);
assert.equal(d.settings.rounds, 2, "rounds = totalPicks / teams");
assert.equal(d.settings.reversal_round, 0);
assert.equal(d.settings.scoring_type, "ppr");
assert.equal(d.league_id, null);
assert.equal(d.slot_to_roster_id[4], 4);
assert.equal(d.slot_labels[4], "Travis's Talented Team");
// lineupSlotCounts -> slots_* keys rosterPositionsFromDraft() understands
assert.equal(d.settings.slots_qb, 1);
assert.equal(d.settings.slots_rb, 2);
assert.equal(d.settings.slots_wr, 2);
assert.equal(d.settings.slots_te, 1);
assert.equal(d.settings.slots_k, 1);
assert.equal(d.settings.slots_def, 1);
assert.equal(d.settings.slots_flex, 1);
assert.equal(d.settings.slots_bn, 7);
assert.equal(d.settings.slots_ir, 1);

const picks = toPicks(raw);
assert.equal(picks.length, 4, "3 round-1 picks + 1 round-2 D/ST; unmade (-1) excluded");
assert.deepEqual(
  picks.map((p) => p.pick_no),
  [1, 2, 3, 11],
);
assert.equal(picks[0].player_id, "4429795");
assert.equal(picks[0].roster_id, 1);
assert.equal(picks[0].round, 1);
assert.equal(picks[0].draft_slot, 1);
// D/ST: negative id must survive as a real pick, mapped to the snaked-back slot
const dst = picks[3];
assert.equal(dst.player_id, "-16034");
assert.equal(dst.round, 2);
assert.equal(dst.draft_slot, 10);
assert.equal(dst.roster_id, 10);

console.log("web espn.js adapter: all checks passed");
