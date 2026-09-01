import * as api from "./lib/sleeper.js";
import * as espn from "./lib/espn.js";
import { loadPlayers, clearPlayerCache } from "./lib/players.js";
import { computeRosterNeeds } from "./lib/needs.js";
import {
  currentPosition,
  positionForOverallPick,
  overallPickFor,
  picksForSlot,
  picksUntilSlot,
} from "./lib/snake.js";
import * as advisor from "./lib/advisor.js";

// Update this to your repo once pushed.
const REPO_URL = "https://github.com/tsjsp1/sleeper-draft-mcp";
document.getElementById("srcLink").href = REPO_URL;

const app = document.getElementById("app");
const topnav = document.getElementById("topnav");
const POLL_MS = 6_000;
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const posPill = (p) => (p ? `<span class="pill pos-${esc(p)}">${esc(p)}</span>` : "");

// ---------------------------------------------------------------- recent list
const RECENT_KEY = "sleeper_recent_drafts";
function rememberDraft(id, name) {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {}
  list = [{ id, name, ts: Date.now() }, ...list.filter((d) => d.id !== id)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {}
}
function recentDrafts() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- router
let teardownFn = null;
function teardown() {
  if (teardownFn) {
    teardownFn();
    teardownFn = null;
  }
}
function go(draftId) {
  location.hash = `#/draft/${draftId}`;
}
function router() {
  teardown();
  topnav.innerHTML = "";
  const h = location.hash.replace(/^#/, "") || "/";
  const m = h.match(/^\/draft\/([A-Za-z0-9_]+)/);
  if (m) renderDraftRoom(m[1]);
  else renderHome();
}
window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", router);
if (document.readyState !== "loading") router();

// ---------------------------------------------------------------- home
function renderHome() {
  const recents = recentDrafts();
  app.innerHTML = `
    <div class="home">
      <h1>Live draft room</h1>
      <p class="lead">Paste a Sleeper draft ID, league ID or username — or an ESPN draft link.</p>
      <form id="goForm">
        <input id="goInput" autocomplete="off" autofocus
          placeholder="sleeper.com/draft/… · fantasy.espn.com/football/draft?leagueId=… · or an ID" />
        <button class="primary" type="submit">Open</button>
      </form>
      <div class="error" id="homeErr"></div>
      <p class="hint">
        Sleeper: the number in a draft board URL
        (<code>sleeper.com/draft/nfl/<b>ID</b></code>); a league ID or username works too.
        ESPN: paste the full <code>fantasy.espn.com/football/draft?leagueId=…</code> link
        (mock-draft-lobby leagues work — the league must be public).
      </p>
      ${
        recents.length
          ? `<div class="recent"><h2>Recent</h2>${recents
              .map((d) => `<a href="#/draft/${esc(d.id)}">${esc(d.name || d.id)}</a>`)
              .join("")}</div>`
          : ""
      }
    </div>`;

  const form = document.getElementById("goForm");
  const input = document.getElementById("goInput");
  const err = document.getElementById("homeErr");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const btn = form.querySelector("button");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>';
    try {
      await resolveAndGo(input.value);
    } catch (ex) {
      err.textContent = ex.message || String(ex);
    } finally {
      btn.disabled = false;
      btn.textContent = "Open";
    }
  });
}

async function resolveAndGo(raw) {
  let v = (raw || "").trim();
  if (!v) throw new Error("Enter something first.");

  // ESPN: a draft/lobby/waitingroom link (…?leagueId=NNN&teamId=N), or a short
  // "espn 205412306 4". teamId is optional; it just pre-selects your team.
  const espnUrl = /espn\.com\/.*[?&]leagueid=(\d+)/i.exec(v);
  const espnShort = /^espn[\s:/]+(\d+)(?:[\s:/]+(\d+))?$/i.exec(v);
  if (espnUrl || espnShort) {
    const league = (espnUrl || espnShort)[1];
    const team = espnUrl
      ? (/[?&]teamid=(\d+)/i.exec(v) || [])[1]
      : espnShort[2];
    return go(`espn_${league}${team ? `_${team}` : ""}`);
  }

  const urlMatch =
    v.match(/draft\/(?:nfl\/)?(\d{5,25})/i) || v.match(/leagues?\/(\d{5,25})/i);
  if (urlMatch) v = urlMatch[1];

  if (/^\d{5,25}$/.test(v)) {
    // Numeric: could be a draft ID or a league ID. Try draft first.
    try {
      const d = await api.getDraft(v);
      if (d && d.draft_id) return go(d.draft_id);
    } catch {}
    try {
      const drafts = await api.getLeagueDrafts(v);
      if (Array.isArray(drafts) && drafts.length) {
        drafts.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
        return go(drafts[0].draft_id);
      }
      throw new Error("That league has no drafts yet.");
    } catch (ex) {
      throw new Error(
        ex.message?.includes("no drafts")
          ? ex.message
          : "Couldn't find a draft or league with that ID.",
      );
    }
  }

  // Otherwise treat as a username.
  const user = await api.getUser(v).catch(() => null);
  if (!user || !user.user_id) throw new Error(`No Sleeper user "${v}".`);
  const state = await api.getState().catch(() => null);
  const season = Number(state?.season) || new Date().getFullYear();
  let leagues = await api.getUserLeagues(user.user_id, season).catch(() => []);
  if (!leagues?.length) leagues = await api.getUserLeagues(user.user_id, season - 1).catch(() => []);
  if (!leagues?.length) throw new Error(`No leagues found for ${v}.`);
  renderLeaguePicker(user, leagues);
}

function renderLeaguePicker(user, leagues) {
  app.innerHTML = `
    <div class="home">
      <h1>${esc(user.display_name || user.username)}'s leagues</h1>
      <p class="lead">Pick one to open its draft.</p>
      <div class="recent" id="lp"></div>
      <div class="error" id="lpErr"></div>
      <p class="hint"><a href="#/">← back</a></p>
    </div>`;
  const box = document.getElementById("lp");
  const err = document.getElementById("lpErr");
  for (const lg of leagues) {
    const a = document.createElement("a");
    a.href = "#";
    a.innerHTML = `${esc(lg.name)} <span class="muted">· ${esc(lg.season)} · ${lg.total_rosters} teams · ${esc(lg.status)}</span>`;
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      err.textContent = "";
      try {
        if (lg.draft_id) return go(lg.draft_id);
        const drafts = await api.getLeagueDrafts(lg.league_id);
        if (!drafts?.length) throw new Error("No draft for that league yet.");
        drafts.sort((x, y) => (y.start_time || 0) - (x.start_time || 0));
        go(drafts[0].draft_id);
      } catch (ex) {
        err.textContent = ex.message || String(ex);
      }
    });
    box.appendChild(a);
  }
}

// ---------------------------------------------------------------- draft room
// draftId is the hash token: a bare Sleeper id, or `espn_<leagueId>[_<teamId>]`.
function espnSource(leagueId) {
  // One league fetch carries picks + settings + teams; memo it briefly so a
  // poll cycle's getDraft() + getDraftPicks() share a single request.
  let inflight = null;
  let at = 0;
  const raw = () => {
    if (!inflight || Date.now() - at > 2000) {
      at = Date.now();
      inflight = espn.getLeagueRaw(leagueId);
    }
    return inflight;
  };
  return {
    getDraft: async () => espn.toDraft(await raw(), leagueId),
    getDraftPicks: async () => espn.toPicks(await raw()),
  };
}
function sleeperSource(id) {
  return {
    getDraft: () => api.getDraft(id),
    getDraftPicks: () => api.getDraftPicks(id),
  };
}

function renderDraftRoom(draftId) {
  const espnM = /^espn_(\d+)(?:_(\d+))?$/.exec(draftId);
  const S = {
    draftId,
    platform: espnM ? "espn" : "sleeper",
    espnLeagueId: espnM ? espnM[1] : null,
    espnTeamId: espnM && espnM[2] ? Number(espnM[2]) : null,
    src: espnM ? espnSource(espnM[1]) : sleeperSource(draftId),
    draft: null,
    picks: [],
    players: {},
    teamBySlot: new Map(), // slot -> label
    teamByRoster: new Map(), // roster_id -> label
    slotToRoster: new Map(),
    rosterToSlot: new Map(),
    rosterPositions: null,
    opts: null,
    numTeams: 0,
    rounds: 0,
    youRoster: loadYou(draftId),
    filterPos: "ALL",
    search: "",
    leftView: "avail", // "avail" | "mine" — left panel toggle
    showBoard: false,
    auto: true,
    lastUpdated: 0,
    timer: null,
  };
  // ESPN draft links carry your teamId — pre-select it the first time in.
  if (S.platform === "espn" && S.espnTeamId != null && S.youRoster == null) {
    S.youRoster = S.espnTeamId;
    saveYou(draftId, S.youRoster);
  }

  app.innerHTML = `<p class="muted"><span class="spin"></span> Loading draft ${esc(draftId)}…</p>`;
  topnav.innerHTML = `<button id="refreshPlayers" title="Re-download the player list">↻ players</button><a href="#/">＋ New</a>`;
  topnav.querySelector("#refreshPlayers").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.innerHTML = '<span class="spin"></span>';
    try {
      if (S.platform === "espn") {
        espn.clearEspnPlayerCache(S.espnLeagueId);
        S.players = await espn.loadEspnPlayers(S.espnLeagueId, { force: true });
      } else {
        clearPlayerCache();
        S.players = (await loadPlayers({ force: true })).players;
      }
      renderLeftPanel(S);
      renderPicks(S);
      if (S.showBoard) renderBoard(S);
    } finally {
      b.disabled = false;
      b.textContent = "↻ players";
    }
  });

  teardownFn = () => {
    if (S.timer) clearInterval(S.timer);
  };

  (async () => {
    try {
      await bootstrap(S);
    } catch (ex) {
      app.innerHTML = `<div class="home"><div class="error">${esc(ex.message || ex)}</div>
        <p class="hint"><a href="#/">← try another ID</a></p></div>`;
      return;
    }
    paintShell(S);
    refreshDynamic(S);
    if (S.auto) startPolling(S);
  })();
}

function loadYou(draftId) {
  try {
    const v = localStorage.getItem(`sleeper_you_${draftId}`);
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}
function saveYou(draftId, rosterId) {
  try {
    if (rosterId == null) localStorage.removeItem(`sleeper_you_${draftId}`);
    else localStorage.setItem(`sleeper_you_${draftId}`, String(rosterId));
  } catch {}
}

async function bootstrap(S) {
  const [draft, players] = await Promise.all([
    S.src.getDraft(),
    S.platform === "espn"
      ? espn.loadEspnPlayers(S.espnLeagueId)
      : loadPlayers().then((env) => env.players),
  ]);
  if (!draft || !draft.draft_id) throw new Error(`No draft with ID ${S.draftId}.`);
  S.draft = draft;
  S.players = players;

  S.numTeams =
    draft.settings?.teams ||
    (draft.slot_to_roster_id ? Object.keys(draft.slot_to_roster_id).length : 0);
  S.rounds = draft.settings?.rounds || 15;
  S.opts = {
    numTeams: S.numTeams,
    type: draft.type === "linear" ? "linear" : "snake",
    reversalRound:
      draft.settings?.reversal_round && draft.settings.reversal_round > 0
        ? draft.settings.reversal_round
        : null,
  };

  if (draft.slot_to_roster_id) {
    for (const [slotStr, rid] of Object.entries(draft.slot_to_roster_id)) {
      S.slotToRoster.set(Number(slotStr), rid);
      S.rosterToSlot.set(rid, Number(slotStr));
    }
  }

  // Required-starter slots normally come from the league. Mock drafts have no
  // league, but Sleeper still puts the slot counts on the draft's own settings —
  // fall back to those so roster needs (and the advisor) work for mocks too.
  let users = [],
    rosters = [];
  S.rosterPositions = null;
  if (draft.league_id) {
    const [lu, lr, lg] = await Promise.allSettled([
      api.getLeagueUsers(draft.league_id),
      api.getLeagueRosters(draft.league_id),
      api.getLeague(draft.league_id),
    ]);
    if (lu.status === "fulfilled") users = lu.value || [];
    if (lr.status === "fulfilled") rosters = lr.value || [];
    if (lg.status === "fulfilled") S.rosterPositions = lg.value?.roster_positions || null;
  }
  if (!S.rosterPositions) S.rosterPositions = rosterPositionsFromDraft(draft.settings);
  const userById = new Map(users.map((u) => [u.user_id, u]));
  const nameForUser = (uid) => {
    const u = userById.get(uid);
    if (!u) return null;
    return u.metadata?.team_name || u.display_name || u.username || null;
  };
  for (const r of rosters) {
    S.teamByRoster.set(r.roster_id, nameForUser(r.owner_id) || `Roster ${r.roster_id}`);
  }
  const slotByUser = draft.draft_order || {};
  const slotLabels = draft.slot_labels || {}; // ESPN gives team names straight up
  for (let slot = 1; slot <= S.numTeams; slot++) {
    const rid = S.slotToRoster.get(slot);
    let label = rid != null ? S.teamByRoster.get(rid) : null;
    if (!label) label = slotLabels[slot] || null;
    if (!label) {
      const uid = Object.keys(slotByUser).find((k) => slotByUser[k] === slot);
      if (uid) label = nameForUser(uid);
    }
    S.teamBySlot.set(slot, label || `Slot ${slot}`);
    if (rid != null && !S.teamByRoster.has(rid)) S.teamByRoster.set(rid, label || `Slot ${slot}`);
  }

  rememberDraft(
    S.draftId,
    draft.metadata?.name || `Draft ${S.draftId} (${draft.type})`,
  );
}

// Rebuild a league-style roster_positions array from a draft's own slot counts.
// Sleeper draft settings use keys like slots_qb / slots_flex / slots_super_flex / slots_bn.
const DRAFT_SLOT_TOKENS = {
  slots_qb: "QB",
  slots_rb: "RB",
  slots_wr: "WR",
  slots_te: "TE",
  slots_k: "K",
  slots_def: "DEF",
  slots_dl: "DL",
  slots_lb: "LB",
  slots_db: "DB",
  slots_flex: "FLEX",
  slots_wrrb_flex: "WRRB_FLEX",
  slots_wr_rb_flex: "WRRB_FLEX",
  slots_rec_flex: "REC_FLEX",
  slots_super_flex: "SUPER_FLEX",
  slots_idp_flex: "IDP_FLEX",
  slots_bn: "BN",
  slots_ir: "IR",
  slots_taxi: "TAXI",
};
function rosterPositionsFromDraft(settings) {
  if (!settings) return null;
  const out = [];
  for (const [key, token] of Object.entries(DRAFT_SLOT_TOKENS)) {
    const n = Number(settings[key]) || 0;
    for (let i = 0; i < n; i++) out.push(token);
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------- shell / static parts
function paintShell(S) {
  const d = S.draft;
  const typeLabel = S.opts.reversalRound
    ? `snake · 3RR@R${S.opts.reversalRound}`
    : d.type;
  const statusCls =
    d.status === "drafting" ? "live" : d.status === "complete" ? "done" : "";

  app.innerHTML = `
    <div class="dhead">
      <h1>${esc(d.metadata?.name || "Draft")}</h1>
      <span class="badge ${statusCls}">${esc(d.status)}</span>
      <span class="badge">${esc(S.platform === "espn" ? "ESPN" : "Sleeper")}</span>
      <span class="badge">${esc(typeLabel)}</span>
      <span class="badge">${S.numTeams} teams · ${S.rounds} rounds</span>
      <span class="badge">ID ${esc(S.platform === "espn" ? S.espnLeagueId : S.draftId)}</span>
    </div>

    <div class="controls">
      <label>You:
        <select id="youSel">
          <option value="">— pick your team —</option>
          ${[...S.teamBySlot.entries()]
            .map(([slot, label]) => {
              const rid = S.slotToRoster.get(slot);
              return `<option value="${rid ?? ""}" ${rid === S.youRoster ? "selected" : ""}>${esc(
                label,
              )}${rid == null ? "" : ` (slot ${slot})`}</option>`;
            })
            .join("")}
        </select>
      </label>
      <button id="boardBtn">${S.showBoard ? "Hide" : "Show"} board</button>
      <label><input type="checkbox" id="autoChk" ${S.auto ? "checked" : ""} /> auto-refresh</label>
      <button id="refreshBtn">Refresh now</button>
      <span class="spacer"></span>
      <span class="updated" id="updated"></span>
    </div>

    <div id="clock"></div>

    <div class="grid2">
      <section class="panel">
        <h2 id="leftTitle">
          <span id="leftTitleText">Available</span> <span id="availCount" class="muted"></span>
          <span class="left-toggle" id="leftToggle">
            <button class="chip active" data-view="avail">Available</button>
            <button class="chip" data-view="mine">My picks</button>
          </span>
        </h2>
        <div class="filters" id="availFilters">
          ${["ALL", ...POSITIONS]
            .map(
              (p) =>
                `<button class="chip ${p === S.filterPos ? "active" : ""}" data-pos="${p}">${p}</button>`,
            )
            .join("")}
          <input id="search" placeholder="search name…" value="${esc(S.search)}" />
        </div>
        <div class="body">
          <ul class="list" id="availList"></ul>
          <ul class="list" id="myPicksList" style="display:none"></ul>
        </div>
      </section>

      <div>
        <section class="panel" style="margin-bottom:16px">
          <h2>Recent picks <span id="pickCount" class="muted"></span></h2>
          <div class="body"><ul class="list" id="pickList"></ul></div>
        </section>
        <section class="panel">
          <h2>Your roster &amp; needs</h2>
          <div id="needs" class="needs"></div>
        </section>
        <section class="panel" style="margin-top:16px">
          <h2>Claude's pick <span id="advKey" class="muted"></span></h2>
          <div class="advisor" id="advisor">
            <div class="advisor-actions">
              <button id="askClaudeBtn" class="primary">Ask Claude for a pick</button>
              <button id="advKeyBtn">Set key</button>
            </div>
            <details class="plan" id="planBox">
              <summary>Draft plan <span id="planState" class="muted"></span></summary>
              <textarea id="planText" rows="10" spellcheck="false"
                placeholder="Round targets, mid/late targets, position tactics… free text, treated as a direction not a script."></textarea>
              <div class="advisor-actions">
                <button id="planSave">Save plan</button>
                <button id="planTemplate" type="button">Use template</button>
              </div>
            </details>
            <div id="advisorOut" class="advisor-out muted">
              Your Anthropic API key stays in this browser only. Set a spend cap on it.
            </div>
          </div>
        </section>
      </div>
    </div>

    <div class="board-wrap" id="boardWrap" style="display:${S.showBoard ? "block" : "none"}">
      <h2>Draft board</h2>
      <div class="board-scroll" id="board"></div>
    </div>`;

  document.getElementById("youSel").addEventListener("change", (e) => {
    S.youRoster = e.target.value === "" ? null : Number(e.target.value);
    saveYou(S.draftId, S.youRoster);
    renderClock(S);
    renderLeftPanel(S);
    renderNeeds(S);
    renderBoard(S);
  });
  document.getElementById("boardBtn").addEventListener("click", () => {
    S.showBoard = !S.showBoard;
    document.getElementById("boardWrap").style.display = S.showBoard ? "block" : "none";
    document.getElementById("boardBtn").textContent = (S.showBoard ? "Hide" : "Show") + " board";
    if (S.showBoard) renderBoard(S);
  });
  document.getElementById("autoChk").addEventListener("change", (e) => {
    S.auto = e.target.checked;
    if (S.auto) startPolling(S);
    else if (S.timer) {
      clearInterval(S.timer);
      S.timer = null;
    }
  });
  document.getElementById("refreshBtn").addEventListener("click", () => refreshDynamic(S));

  document.getElementById("leftToggle").addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (!b || b.disabled) return;
    S.leftView = b.dataset.view;
    renderLeftPanel(S);
  });

  const filters = app.querySelector(".filters");
  filters.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    S.filterPos = b.dataset.pos;
    filters.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === b));
    renderAvailable(S);
  });
  document.getElementById("search").addEventListener("input", (e) => {
    S.search = e.target.value;
    renderAvailable(S);
  });

  wireAdvisor(S);
}

// ---------------------------------------------------------------- advisor (optional Claude call)
function refreshAdvKeyLabel() {
  const el = document.getElementById("advKey");
  const btn = document.getElementById("advKeyBtn");
  if (!el || !btn) return;
  if (advisor.hasKey()) {
    el.textContent = `key ${advisor.maskKey()}`;
    btn.textContent = "Change / clear key";
  } else {
    el.textContent = "no key set";
    btn.textContent = "Set key";
  }
}

function refreshPlanState() {
  const el = document.getElementById("planState");
  if (!el) return;
  const p = advisor.getPlan();
  el.textContent = p ? "✓ saved" : "none";
}

function wireAdvisor(S) {
  refreshAdvKeyLabel();
  refreshPlanState();
  const keyBtn = document.getElementById("advKeyBtn");
  const askBtn = document.getElementById("askClaudeBtn");
  const out = document.getElementById("advisorOut");

  const planText = document.getElementById("planText");
  if (planText) {
    planText.value = advisor.getPlan();
    document.getElementById("planSave").addEventListener("click", () => {
      advisor.setPlan(planText.value);
      planText.value = advisor.getPlan();
      refreshPlanState();
      out.classList.add("muted");
      out.textContent = advisor.getPlan()
        ? "Plan saved — used on the next “Ask Claude”."
        : "Plan cleared.";
    });
    document.getElementById("planTemplate").addEventListener("click", () => {
      planText.value = advisor.PLAN_TEMPLATE;
      planText.focus();
    });
  }

  keyBtn.addEventListener("click", () => {
    const current = advisor.hasKey() ? advisor.maskKey() : "";
    const entered = window.prompt(
      "Anthropic API key (stored only in this browser's localStorage).\nLeave blank and OK to clear it." +
        (current ? `\n\nCurrent: ${current}` : ""),
      "",
    );
    if (entered === null) return; // cancelled
    advisor.setKey(entered);
    refreshAdvKeyLabel();
    out.classList.add("muted");
    out.textContent = advisor.hasKey() ? "Key saved in this browser." : "Key cleared.";
  });

  askBtn.addEventListener("click", async () => {
    if (!advisor.hasKey()) {
      out.classList.remove("muted");
      out.textContent = "Set your Anthropic API key first (button above).";
      return;
    }
    if (S.youRoster == null) {
      out.classList.remove("muted");
      out.textContent = "Pick your team in the “You” dropdown first.";
      return;
    }
    if (S.draft.type === "auction") {
      out.classList.remove("muted");
      out.textContent = "Auction drafts aren't supported by the advisor.";
      return;
    }
    const payload = buildAdvisorPayload(S);
    if (!payload.available.length) {
      out.classList.remove("muted");
      out.textContent = "No available players loaded yet — try Refresh now.";
      return;
    }
    askBtn.disabled = true;
    askBtn.innerHTML = '<span class="spin"></span> asking…';
    out.classList.add("muted");
    out.textContent = "Thinking…";
    try {
      const text = await advisor.askForPick(payload);
      out.classList.remove("muted");
      out.innerHTML = renderAdvisorText(text);
    } catch (ex) {
      out.classList.remove("muted");
      out.innerHTML = `<span class="adv-err">${esc(ex.message || ex)}</span>`;
    } finally {
      askBtn.disabled = false;
      askBtn.textContent = "Ask Claude for a pick";
    }
  });
}

function renderAdvisorText(text) {
  // Plain text -> minimal HTML: escape everything, bold "PICK:" / "ALTERNATIVES:",
  // turn "- " lines into a list.
  const lines = String(text).split(/\r?\n/);
  let html = "";
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${esc(line.replace(/^[-*]\s+/, ""))}</li>`;
      continue;
    }
    if (inList) {
      html += "</ul>";
      inList = false;
    }
    const m = line.match(/^([A-Z][A-Z ]{2,}:)\s*(.*)$/);
    if (m) html += `<p><b>${esc(m[1])}</b> ${esc(m[2])}</p>`;
    else html += `<p>${esc(line)}</p>`;
  }
  if (inList) html += "</ul>";
  return html || esc(text);
}

function buildAdvisorPayload(S) {
  const made = S.picks.length;
  const total = S.numTeams * S.rounds;
  const pos = currentPosition(made, S.opts);
  const mySlot = S.rosterToSlot.get(S.youRoster);
  const isYou = mySlot != null && pos.slot === mySlot;
  const picksUntilYou =
    mySlot == null ? null : picksUntilSlot(mySlot, made, S.rounds, S.opts);

  const mine = S.picks
    .filter((p) => isMyPick(S, p))
    .map((pk) => {
      const info = playerName(S, pk);
      return { round: pk.round, slot: pk.draft_slot, name: info.name, pos: info.pos, team: info.team };
    });

  const myPositions = mine.map((r) => r.pos).filter(Boolean);
  const needs = S.rosterPositions
    ? computeRosterNeeds(S.rosterPositions, myPositions)
    : null;

  const drafted = draftedSet(S);
  const pool = [];
  for (const id in S.players) {
    if (drafted.has(id)) continue;
    const p = S.players[id];
    // Advisor only sees real, draftable players: ranked AND on an active NFL
    // roster. Sleeper's dictionary keeps retired/FA players (Todd Gurley, etc.),
    // sometimes with a stale search_rank — exclude them so Claude can't suggest one.
    if (p.r == null || p.r >= 3000 || !p.t) continue;
    pool.push({ name: p.n, pos: p.p, team: p.t, rank: p.r, inj: p.inj });
  }
  pool.sort((a, b) => a.rank - b.rank);

  // Candidate pool = top N by ADP PLUS any still-available player named in the
  // plan (so late-round targets like a rookie RB are actually pickable, not
  // filtered out for being ADP ~120). Mark the planned ones.
  const TOP_N = 50;
  const planText = advisor.getPlan().toLowerCase();
  const available = pool.slice(0, TOP_N);
  const inList = new Set(available.map((p) => p.name));
  if (planText) {
    for (const p of pool.slice(TOP_N)) {
      if (!inList.has(p.name) && planText.includes(p.name.toLowerCase())) {
        available.push(p);
        inList.add(p.name);
      }
    }
    for (const p of available) {
      if (planText.includes(p.name.toLowerCase())) p.planned = true;
    }
  }

  const recentPicks = S.picks
    .slice()
    .reverse()
    .slice(0, 15)
    .reverse()
    .map((pk) => {
      const info = playerName(S, pk);
      return {
        round: pk.round,
        slot: pk.draft_slot,
        name: info.name,
        pos: info.pos,
        byTeam: pk.roster_id != null ? S.teamByRoster.get(pk.roster_id) : null,
      };
    });

  return {
    format: {
      teams: S.numTeams,
      rounds: S.rounds,
      type: S.opts.type,
      reversalRound: S.opts.reversalRound,
      rosterPositions: S.rosterPositions,
      scoring: S.draft.metadata?.scoring_type || S.draft.settings?.scoring_type || null,
    },
    you: { team: S.teamBySlot.get(mySlot) || `Slot ${mySlot}`, slot: mySlot, rosterId: S.youRoster },
    onClock: {
      round: pos.round,
      pickInRound: pos.pickInRound,
      overallPick: pos.overallPick,
      isYou,
      picksUntilYou,
    },
    myRoster: mine,
    needs,
    available,
    recentPicks,
    plan: advisor.getPlan(),
  };
}

// ---------------------------------------------------------------- polling + dynamic render
function startPolling(S) {
  if (S.timer) clearInterval(S.timer);
  S.timer = setInterval(() => refreshDynamic(S), POLL_MS);
}

async function refreshDynamic(S) {
  if (S.refreshing) return; // don't stack overlapping polls / button mashes
  S.refreshing = true;
  try {
    // Settle independently: a flaky /draft call shouldn't wipe out a good /picks
    // result (or vice-versa) and make the room "jump" between states.
    const [picksR, draftR] = await Promise.allSettled([
      S.src.getDraftPicks(),
      S.src.getDraft(),
    ]);
    if (picksR.status === "rejected" && draftR.status === "rejected") {
      const u = document.getElementById("updated");
      if (u) u.textContent = `⚠ ${picksR.reason?.message || picksR.reason}`;
      return;
    }
    if (draftR.status === "fulfilled" && draftR.value) {
      S.draft = draftR.value;
    }
    if (picksR.status === "fulfilled" && Array.isArray(picksR.value)) {
      const next = picksR.value.slice().sort((a, b) => a.pick_no - b.pick_no);
      // Picks only ever grow during a live draft. If a poll returns fewer
      // (usually a stale/empty CDN cache), keep what we have instead of
      // flickering the board back — unless the draft genuinely reset.
      if (next.length >= S.picks.length || S.draft.status !== "drafting") {
        S.picks = next;
      }
    }
    S.lastUpdated = Date.now();
    renderClock(S);
    renderLeftPanel(S);
    renderPicks(S);
    renderNeeds(S);
    if (S.showBoard) renderBoard(S);
    const u = document.getElementById("updated");
    if (u) {
      const badge = document.querySelector(".dhead .badge");
      if (badge) {
        badge.className =
          "badge " +
          (S.draft.status === "drafting" ? "live" : S.draft.status === "complete" ? "done" : "");
        badge.textContent = S.draft.status;
      }
      u.textContent = `updated ${new Date(S.lastUpdated).toLocaleTimeString()}`;
    }
  } finally {
    S.refreshing = false;
  }
}

function draftedSet(S) {
  return new Set(S.picks.map((p) => p.player_id));
}

// Is this pick one of mine? Mock drafts often leave pick.roster_id null (there's
// no league / rosters), so fall back to matching my draft slot.
function isMyPick(S, pick) {
  if (S.youRoster == null) return false;
  if (pick.roster_id != null && pick.roster_id === S.youRoster) return true;
  const mySlot = S.rosterToSlot.get(S.youRoster);
  return mySlot != null && pick.draft_slot === mySlot;
}

function renderClock(S) {
  const box = document.getElementById("clock");
  if (!box) return;
  const total = S.numTeams * S.rounds;
  const made = S.picks.length;

  if (S.draft.type === "auction") {
    box.className = "clock";
    box.innerHTML = `<div class="who">Auction draft</div><div class="sub">No snake turn order. ${made} picks recorded.</div>`;
    return;
  }
  if (made >= total || S.draft.status === "complete") {
    box.className = "clock";
    box.innerHTML = `<div class="who">Draft complete</div><div class="sub">${made} / ${total} picks.</div>`;
    return;
  }

  const pos = currentPosition(made, S.opts);
  const rid = S.slotToRoster.get(pos.slot);
  const team = S.teamBySlot.get(pos.slot) || `Slot ${pos.slot}`;
  const isYou = S.youRoster != null && rid === S.youRoster;
  box.className = "clock" + (isYou ? " you" : "");

  const next = [];
  for (let i = 1; i <= 3 && made + i < total; i++) {
    const np = positionForOverallPick(pos.overallPick + i, S.opts);
    next.push(S.teamBySlot.get(np.slot) || `Slot ${np.slot}`);
  }

  let youLine = "";
  if (S.youRoster != null) {
    const mySlot = S.rosterToSlot.get(S.youRoster);
    if (mySlot) {
      const until = picksUntilSlot(mySlot, made, S.rounds, S.opts);
      youLine =
        until == null
          ? `<div class="next">You have no picks left.</div>`
          : until === 0
            ? `<div class="next"><b>You're on the clock.</b></div>`
            : `<div class="next">Your next pick: <b>${until}</b> away (overall #${
                positionForOverallPick(pos.overallPick, S.opts).overallPick + until
              }).</div>`;
    }
  }

  box.innerHTML = `
    <div class="who">${isYou ? "🎯 You're up" : esc(team)}</div>
    <div class="sub">Round ${pos.round}, pick ${pos.pickInRound} · overall #${pos.overallPick} of ${total}${
      isYou ? "" : ""
    }</div>
    ${next.length ? `<div class="next">On deck: ${next.map(esc).join(" → ")}</div>` : ""}
    ${youLine}`;
}

// Left panel shows the "Available" pool or "Your picks" in draft order, chosen
// by the header toggle. "My picks" needs a selected team, so it falls back to
// "Available" until you pick one.
function renderLeftPanel(S) {
  const titleText = document.getElementById("leftTitleText");
  const filters = document.getElementById("availFilters");
  const availUl = document.getElementById("availList");
  const mineUl = document.getElementById("myPicksList");
  const toggle = document.getElementById("leftToggle");
  if (!titleText || !availUl || !mineUl) return;

  const hasTeam = S.youRoster != null;
  const view = S.leftView === "mine" && hasTeam ? "mine" : "avail";
  const mine = view === "mine";

  if (toggle) {
    const mineBtn = toggle.querySelector('[data-view="mine"]');
    mineBtn.disabled = !hasTeam;
    mineBtn.title = hasTeam ? "" : "Pick your team above first";
    toggle.querySelectorAll("[data-view]").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === view),
    );
  }
  filters.style.display = mine ? "none" : "";
  availUl.style.display = mine ? "none" : "";
  mineUl.style.display = mine ? "" : "none";
  titleText.textContent = mine ? "Your picks" : "Available";

  if (mine) renderMyPicks(S);
  else renderAvailable(S);
}

function renderMyPicks(S) {
  const ul = document.getElementById("myPicksList");
  if (!ul) return;
  const mine = S.picks
    .filter((p) => isMyPick(S, p))
    .slice()
    .sort((a, b) => a.pick_no - b.pick_no);
  const count = document.getElementById("availCount");
  if (count) count.textContent = `(${mine.length})`;
  ul.innerHTML =
    mine
      .map((pk) => {
        const info = playerName(S, pk);
        return `<li>
          <span class="pick-no">${pk.round}.${String(pk.draft_slot).padStart(2, "0")}</span>
          <span class="pname">${esc(info.name)}</span>
          ${posPill(info.pos)}
          <span class="pmeta">${esc(info.team || "")}</span>
        </li>`;
      })
      .join("") ||
    `<li class="muted" style="padding:14px">No picks yet — your selections show up here in draft order.</li>`;
}

function renderAvailable(S) {
  const ul = document.getElementById("availList");
  if (!ul) return;
  const drafted = draftedSet(S);
  const q = S.search.trim().toLowerCase();
  const wantPos = S.filterPos === "ALL" ? null : S.filterPos;

  const rows = [];
  for (const id in S.players) {
    if (drafted.has(id)) continue;
    const p = S.players[id];
    if (wantPos && p.p !== wantPos && !(p.fp && p.fp.includes(wantPos))) continue;
    if (q && !p.n.toLowerCase().includes(q)) continue;
    rows.push(p);
  }
  rows.sort((a, b) => (a.r ?? 1e9) - (b.r ?? 1e9));

  document.getElementById("availCount").textContent = `(${rows.length})`;
  ul.innerHTML =
    rows
      .slice(0, 200)
      .map(
        (p) => `
      <li>
        <span class="rank">${p.r ?? "—"}</span>
        <span class="pname">${esc(p.n)}</span>
        ${posPill(p.p)}
        <span class="pmeta">${esc(p.t || "FA")}${p.inj ? ` · ${esc(p.inj)}` : ""}</span>
      </li>`,
      )
      .join("") || `<li class="muted" style="padding:14px">Nothing matches.</li>`;
}

function playerName(S, pick) {
  const cached = S.players[pick.player_id];
  if (cached) return { name: cached.n, pos: cached.p, team: cached.t };
  const m = pick.metadata || {};
  return {
    name: [m.first_name, m.last_name].filter(Boolean).join(" ") || pick.player_id,
    pos: m.position || null,
    team: m.team || null,
  };
}

function renderPicks(S) {
  const ul = document.getElementById("pickList");
  if (!ul) return;
  document.getElementById("pickCount").textContent = `(${S.picks.length})`;
  const recent = S.picks.slice().reverse().slice(0, 40);
  ul.innerHTML =
    recent
      .map((pk) => {
        const info = playerName(S, pk);
        const team = pk.roster_id != null ? S.teamByRoster.get(pk.roster_id) : null;
        const mine = isMyPick(S, pk);
        return `<li${mine ? ' style="background:color-mix(in srgb,var(--good) 12%,transparent)"' : ""}>
          <span class="pick-no">${pk.round}.${String(pk.draft_slot).padStart(2, "0")}</span>
          <span class="pname">${esc(info.name)}</span>
          ${posPill(info.pos)}
          <span class="pmeta">${esc(info.team || "")}</span>
          <span class="pick-team">${esc(team || "")}</span>
        </li>`;
      })
      .join("") || `<li class="muted" style="padding:14px">${
        S.platform === "espn" && S.draft?.status === "drafting"
          ? "No picks published yet. ESPN's read API can lag a live mock badly " +
            "(often nothing until the draft completes) — this board fills in when it appears."
          : "No picks yet."
      }</li>`;
}

function renderNeeds(S) {
  const box = document.getElementById("needs");
  if (!box) return;
  if (S.youRoster == null) {
    box.innerHTML = `<span class="muted">Pick your team above to see roster needs.</span>`;
    return;
  }
  const rosterPositions = S.rosterPositions;
  const mine = S.picks.filter((p) => isMyPick(S, p));
  const myPositions = mine.map((p) => playerName(S, p).pos).filter(Boolean);

  const counts = {};
  for (const pos of myPositions) counts[pos] = (counts[pos] || 0) + 1;
  const countLine = POSITIONS.filter((p) => counts[p])
    .map((p) => `${posPill(p)} ${counts[p]}`)
    .join(" &nbsp; ");

  let needsHtml = "";
  if (rosterPositions) {
    const n = computeRosterNeeds(rosterPositions, myPositions);
    needsHtml =
      n.byPosition
        .map(
          (r) =>
            `<div class="row"><span>${posPill(r.position)} starters</span>
             <span class="${r.short ? "short" : "ok"}">${r.have}/${r.requiredStarters}${
               r.short ? ` · ${r.short} short` : " ✓"
             }</span></div>`,
        )
        .join("") +
      n.flex
        .map(
          (f) =>
            `<div class="row"><span>${esc(f.slotType)} (${esc(f.eligible.join("/"))})</span>
             <span class="${f.short ? "short" : "ok"}">${f.short ? `${f.short} open` : "covered ✓"}</span></div>`,
        )
        .join("") +
      (n.thin.length
        ? `<div class="thinbox"><b>Thin:</b> ${n.thin.map(esc).join(" · ")}</div>`
        : `<div class="thinbox ok">Starting lineup covered.</div>`);
  } else {
    needsHtml = `<div class="muted" style="margin-top:6px">No league attached to this draft, so required-starter data isn't available. Position counts only.</div>`;
  }

  box.innerHTML = `
    <div><b>${mine.length}</b> pick${mine.length === 1 ? "" : "s"} · ${countLine || "—"}</div>
    <div style="margin-top:8px">${needsHtml}</div>`;
}

function renderBoard(S) {
  const wrap = document.getElementById("board");
  if (!wrap) return;
  const made = S.picks.length;
  const onClock = made < S.numTeams * S.rounds ? currentPosition(made, S.opts) : null;
  const byOverall = new Map(S.picks.map((p) => [p.pick_no, p]));

  let head = "<tr><th>R</th>";
  for (let slot = 1; slot <= S.numTeams; slot++) {
    head += `<th>${esc(S.teamBySlot.get(slot) || `Slot ${slot}`)}</th>`;
  }
  head += "</tr>";

  let rowsHtml = "";
  for (let r = 1; r <= S.rounds; r++) {
    rowsHtml += `<tr><th>${r}</th>`;
    for (let slot = 1; slot <= S.numTeams; slot++) {
      const overall = overallPickFor(r, slot, S.opts);
      const pk = byOverall.get(overall);
      const rid = S.slotToRoster.get(slot);
      const mine = S.youRoster != null && rid === S.youRoster;
      const isClock = onClock && onClock.overallPick === overall;
      let inner = `<span class="cell-meta">#${overall}</span>`;
      if (pk) {
        const info = playerName(S, pk);
        inner = `<span class="cell-name">${esc(info.name)}</span><span class="cell-meta">${esc(
          info.pos || "",
        )} ${esc(info.team || "")}</span>`;
      }
      rowsHtml += `<td class="${isClock ? "on-clock" : ""} ${mine ? "mine" : ""}">${inner}</td>`;
    }
    rowsHtml += "</tr>";
  }
  wrap.innerHTML = `<table class="board"><thead>${head}</thead><tbody>${rowsHtml}</tbody></table>`;
}
