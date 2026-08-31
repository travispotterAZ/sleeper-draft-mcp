// Roster-needs math — browser port of the MCP server's src/needs.ts.

export const FLEX_ELIGIBILITY = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};
const BENCH = new Set(["BN", "IR", "TAXI"]);

export function computeRosterNeeds(rosterPositions, draftedPositions) {
  const dedicated = new Map();
  const flexSlots = new Map();
  let benchCount = 0;

  for (const slot of rosterPositions || []) {
    if (BENCH.has(slot)) benchCount++;
    else if (FLEX_ELIGIBILITY[slot]) flexSlots.set(slot, (flexSlots.get(slot) || 0) + 1);
    else dedicated.set(slot, (dedicated.get(slot) || 0) + 1);
  }

  const have = new Map();
  for (const pos of draftedPositions) {
    if (!pos) continue;
    have.set(pos, (have.get(pos) || 0) + 1);
  }

  const surplus = new Map(have);
  const byPosition = [];
  for (const [position, requiredStarters] of [...dedicated].sort()) {
    const owned = have.get(position) || 0;
    byPosition.push({
      position,
      requiredStarters,
      have: owned,
      short: Math.max(0, requiredStarters - owned),
    });
    surplus.set(position, Math.max(0, owned - requiredStarters));
  }

  const flex = [];
  const flexEntries = [...flexSlots].sort(
    (a, b) => FLEX_ELIGIBILITY[a[0]].length - FLEX_ELIGIBILITY[b[0]].length,
  );
  for (const [slotType, slots] of flexEntries) {
    const eligible = FLEX_ELIGIBILITY[slotType];
    let available = 0;
    for (const pos of eligible) available += surplus.get(pos) || 0;
    const filled = Math.min(slots, available);
    let toDrain = filled;
    for (const pos of eligible) {
      if (toDrain <= 0) break;
      const s = surplus.get(pos) || 0;
      const take = Math.min(s, toDrain);
      surplus.set(pos, s - take);
      toDrain -= take;
    }
    flex.push({ slotType, eligible, slots, surplusAvailable: available, short: slots - filled });
  }

  const thin = [];
  for (const n of byPosition) {
    if (n.short > 0) thin.push(`${n.position}: ${n.have}/${n.requiredStarters} (${n.short} short)`);
  }
  for (const f of flex) {
    if (f.short > 0) thin.push(`${f.slotType} (${f.eligible.join("/")}): ${f.short} open`);
  }

  return { byPosition, flex, benchCount, thin };
}
