// Optional "ask Claude for a pick" helper.
//
// Bring-your-own-key: the user's Anthropic API key is kept only in this
// browser's localStorage and sent straight to api.anthropic.com. It is never
// part of the deployed code and never touches any other server. See the README
// "AI pick suggestions" section for the threat model.

const KEY_STORE = "sleeper_anthropic_key";
const MODEL = "claude-sonnet-5"; // fast + cheap; swap to claude-opus-5 for deeper reasoning
const ENDPOINT = "https://api.anthropic.com/v1/messages";

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
    .map((p, i) => `  ${i + 1}. ${p.name} (${p.pos}${p.team ? ", " + p.team : ""}, ADP rank ${p.rank})${p.inj ? " [" + p.inj + "]" : ""}`)
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

TOP AVAILABLE PLAYERS (by Sleeper ADP rank, lower = earlier). These are the ONLY players you may recommend — every one is currently on an NFL roster:
${fmtAvailable(p.available)}

RECENT PICKS (most recent last)
${fmtRecent(p.recentPicks)}

Recommend who I should take. Weigh roster construction, positional scarcity, ADP value, and the run of recent picks. Keep it short.

Rules:
- Recommend ONLY players from the TOP AVAILABLE PLAYERS list above. Never name a player who is not on that list.
- Use the ADP rank exactly as given above; do not invent a rank.

Answer in exactly this shape:
PICK: <player name> (<pos>) — one sentence why.
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
          "You are an expert fantasy football draft advisor giving live, in-draft advice. Be decisive and concise. You may ONLY recommend players that appear in the TOP AVAILABLE PLAYERS list in the user's message — never name a player who is not on that list, and never invent a ranking.",
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
