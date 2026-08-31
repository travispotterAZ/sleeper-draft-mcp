import test from "node:test";
import assert from "node:assert/strict";

import { computeRosterNeeds } from "../src/needs.ts";

const STANDARD = [
  "QB",
  "RB",
  "RB",
  "WR",
  "WR",
  "TE",
  "FLEX",
  "K",
  "DEF",
  "BN",
  "BN",
  "BN",
  "BN",
  "BN",
  "BN",
];

test("empty roster: every starting slot is a need", () => {
  const needs = computeRosterNeeds(STANDARD, []);
  const qb = needs.byPosition.find((n) => n.position === "QB");
  assert.equal(qb?.short, 1);
  const rb = needs.byPosition.find((n) => n.position === "RB");
  assert.equal(rb?.short, 2);
  assert.equal(needs.benchCount, 6);
  assert.equal(needs.flex[0].short, 1);
  assert.ok(needs.thin.some((t) => t.startsWith("RB:")));
});

test("filled dedicated slots clear those needs", () => {
  const needs = computeRosterNeeds(STANDARD, [
    "QB",
    "RB",
    "RB",
    "WR",
    "WR",
    "TE",
    "K",
    "DEF",
  ]);
  for (const n of needs.byPosition) assert.equal(n.short, 0);
  // No surplus anywhere, so the FLEX is still uncovered.
  assert.equal(needs.flex[0].short, 1);
});

test("surplus RB covers the FLEX slot", () => {
  const needs = computeRosterNeeds(STANDARD, [
    "QB",
    "RB",
    "RB",
    "RB", // one extra RB
    "WR",
    "WR",
    "TE",
    "K",
    "DEF",
  ]);
  assert.equal(needs.flex[0].short, 0);
  assert.equal(needs.thin.length, 0);
});

test("superflex counts QB surplus", () => {
  const SUPERFLEX = ["QB", "RB", "WR", "SUPER_FLEX", "BN", "BN"];
  const covered = computeRosterNeeds(SUPERFLEX, ["QB", "QB", "RB", "WR"]);
  assert.equal(covered.flex[0].short, 0);
  const notCovered = computeRosterNeeds(SUPERFLEX, ["QB", "RB", "WR"]);
  assert.equal(notCovered.flex[0].short, 1);
});

test("specific flex gets first dibs on shared surplus", () => {
  // One WR surplus, both a REC_FLEX (WR/TE) and a FLEX (RB/WR/TE) open.
  // REC_FLEX is more specific -> it should consume the WR, leaving FLEX short.
  const positions = ["WR", "REC_FLEX", "FLEX", "BN"];
  const needs = computeRosterNeeds(positions, ["WR", "WR"]);
  const rec = needs.flex.find((f) => f.slotType === "REC_FLEX");
  const flx = needs.flex.find((f) => f.slotType === "FLEX");
  assert.equal(rec?.short, 0);
  assert.equal(flx?.short, 1);
});

test("bench/IR/taxi slots are excluded from starting slots", () => {
  const needs = computeRosterNeeds(["QB", "RB", "BN", "IR", "TAXI"], []);
  assert.deepEqual(needs.startingSlots, ["QB", "RB"]);
  assert.equal(needs.benchCount, 3);
});
