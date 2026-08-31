// Optional "ask Claude for a pick" helper.
//
// Bring-your-own-key: the user's Anthropic API key is kept only in this
// browser's localStorage and sent straight to api.anthropic.com. It is never
// part of the deployed code and never touches any other server. See the README
// "AI pick suggestions" section for the threat model.

const KEY_STORE = "sleeper_anthropic_key";
const PLAN_STORE = "sleeper_draft_plan";
const MODEL = "claude-sonnet-5"; // fast + cheap; swap to claude-opus-5 for deeper reasoning
const ENDPOINT = "https://api.anthropic.com/v1/messages";

// A starter plan the user can drop in and edit. Free-text on purpose — Claude
// reads it as strategic guidance, not a rigid script.
export const PLAN_TEMPLATE = `Slot 4, 12-team half-PPR. Direction over absolutes — adapt to the board.

ROUND TARGETS
R1: Puka Nacua (WR); else best WR/RB available.
R2-3: anchor RB + a WR.
R4: whichever of RB2 / WR2 is thinner.
R5: best player available; lean TE on value.

MID / LATE TARGETS
- George Kittle (TE) in rounds 8-10.
- Jadarian Price (RB, SEA), MarShawn Lloyd (RB, GB), Jordan Mason (RB) as
  later-round upside — starting jobs / clear paths to touches.

PICK CRITERIA
- Draft for team fit and upside, not Sleeper's ADP. A lower-ranked player who
  fills a need or has a clearer path to touches beats a higher-ranked redundant
  piece.

POSITION TACTICS
- 2 WR and 2 RB established by the end of round 4.
- No QB before round 9.
- K and DEF only in the final 3 rounds.`;

export function getKey() {
  try {
    return localStorage.getItem(KEY_STORE) || "";
  } catch {
    return "";
  }
}
export function setKey(k) {
  try {
    if (k) localStorage.setItem(KEY_STORE, k.trim());
    else localStorage.removeItem(KEY_STORE);
  } catch {
    /* private mode / quota — nothing we can do */
  }
}
export function hasKey() {
  return getKey().length > 0;
}
export function getPlan() {
  try {
    return localStorage.getItem(PLAN_STORE) || "";
  } catch {
    return "";
  }
}
export function setPlan(t) {
  try {
    if (t && t.trim()) localStorage.setItem(PLAN_STORE, t.trim());
    else localStorage.removeItem(PLAN_STORE);
  } catch {
    /* private mode / quota */
  }
}
export function maskKey() {
  const k = getKey();
  if (!k) return "";
  return k.length <= 12 ? "•••" : `${k.slice(0, 7)}…${k.slice(-4)}`;
}

// ------------------------------------------------------------------ prompt
function fmtRoster(rows) {
  if (!rows.length) return "(no picks yet)";
  return rows
    .map((r) => `  ${r.round}.${String(r.slot).padStart(2, "0")} ${r.name} (${r.pos || "?"}${r.team ? ", " + r.team : ""})`)
    .join("\n");
}
function fmtAvailable(rows) {
  return rows
    .map(
      (p) =>
        `  - ${p.name} (${p.pos}${p.team ? ", " + p.team : ""}) · ADP rank ${p.rank}${p.inj ? ` · ${p.inj}` : ""}${p.planned ? "  <- named in my plan" : ""}`,
    )
    .join("\n");
}
function fmtRecent(rows) {
  if (!rows.length) return "(none)";
  return rows
    .map((r) => `  ${r.round}.${String(r.slot).padStart(2, "0")} ${r.name} (${r.pos || "?"}) → ${r.byTeam || "?"}`)
    .join("\n");
}
function fmtNeeds(needs) {
  if (!needs) return "(no league attached — required-starter data unavailable)";
  const lines = [];
  for (const n of needs.byPosition || []) {
    lines.push(`  ${n.position}: ${n.have}/${n.requiredStarters} starters${n.short ? ` — ${n.short} short` : " ✓"}`);
  }
  for (const f of needs.flex || []) {
    lines.push(`  ${f.slotType} (${(f.eligible || []).join("/")}): ${f.short ? `${f.short} open` : "covered ✓"}`);
  }
  if (needs.thin && needs.thin.length) lines.push(`  THIN: ${needs.thin.join("; ")}`);
  return lines.join("\n") || "(starting lineup covered)";
}

function buildPrompt(p) {
  const f = p.format;
  const typeLabel = f.reversalRound ? `snake, third-round reversal @ round ${f.reversalRound}` : f.type;
  const clock = p.onClock.isYou
    ? `I am ON THE CLOCK now — round ${p.onClock.round}, pick ${p.onClock.pickInRound}, overall #${p.onClock.overallPick}.`
    : p.onClock.picksUntilYou == null
      ? `I have no picks left.`
      : `My next pick is ${p.onClock.picksUntilYou} away (currently overall #${p.onClock.overallPick} is on the clock).`;

  return `LEAGUE FORMAT
  ${f.teams} teams, ${f.rounds} rounds, ${typeLabel}.
  Scoring: ${f.scoring || "unknown"}.
  Starting lineup: ${f.rosterPositions && f.rosterPositions.length ? f.rosterPositions.join(", ") : "unknown"}.

ME
  Team "${p.you.team}", draft slot ${p.you.slot}.
  ${clock}

MY ROSTER SO FAR
${fmtRoster(p.myRoster)}

MY ROSTER NEEDS
${fmtNeeds(p.needs)}

AVAILABLE PLAYERS — this is the candidate pool. The ADP rank is shown for reference only; it is NOT a recommended pick order. You may only recommend a player who appears in this list:
${fmtAvailable(p.available)}

RECENT PICKS (most recent last)
${fmtRecent(p.recentPicks)}
${p.plan ? `\nMY DRAFT PLAN (strategic guidance for my slot — a direction, not an absolute)\n${p.plan}\n` : ""}
Recommend the player who is best FOR MY TEAM right now. Keep it short.

Rules:
- Draft for team fit, not name value. Base the pick on: my roster needs and construction, positional scarcity and tier cliffs, a player's role/upside/path to touches, bye-week fit, the run of recent picks${p.plan ? ", and my draft plan" : ""}.
- ADP rank is only for judging whether a player will still be available at my next pick — a tiebreaker and a sanity check, never the deciding factor.
- If a lower-ADP player is the better roster fit, recommend that player and say why in one line. Do NOT default to the highest-ranked name.
- Recommend ONLY a player from the AVAILABLE PLAYERS list above. Never name a player who is not on it, and do not invent a rank.${
    p.plan
      ? "\n- Follow the draft plan when you reasonably can. Deviate only if a planned target is already gone or clearly better value has fallen — and say so in the PLAN line."
      : ""
  }

Answer in exactly this shape:
PICK: <player name> (<pos>) — one sentence why.${
    p.plan ? "\nPLAN: <one line — on track / behind on X / deviating because Y>" : ""
  }
ALTERNATIVES:
- <player name> (<pos>) — a few words
- <player name> (<pos>) — a few words
- <player name> (<pos>) — a few words`;
}

// ------------------------------------------------------------------ call
export async function askForPick(payload) {
  const key = getKey();
  if (!key) throw new Error("No API key set.");

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system:
          "You are an expert fantasy football draft advisor giving live, in-draft advice. Recommend the player who best fits the user's roster, situation, and plan — NOT simply the highest-ranked available name. Sleeper ADP is context for when a player will be gone, not the decision. Be decisive and concise. Only recommend players that appear in the AVAILABLE PLAYERS list in the user's message; never invent a player or a ranking. If the user provides a draft plan, treat it as strong strategic guidance: favor picks that advance it, but you may deviate when the board clearly dictates — say so briefly.",
        messages: [{ role: "user", content: buildPrompt(payload) }],
      }),
    });
  } catch (e) {
    throw new Error(`Network error calling Anthropic: ${e.message || e}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j?.error?.message || "";
    } catch {}
    if (res.status === 401) throw new Error("Anthropic rejected the API key (401). Re-enter it.");
    if (res.status === 429) throw new Error("Rate limited by Anthropic (429). Wait a moment and retry.");
    if (res.status === 400 && /credit|billing|quota/i.test(detail))
      throw new Error(`Anthropic: ${detail}`);
    throw new Error(`Anthropic error ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || "(no text in response)";
}

export { MODEL as ADVISOR_MODEL };
