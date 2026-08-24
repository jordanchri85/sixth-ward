// Sacrament Meeting planner: one agenda per Sunday, keyed by date.
// The agenda is an ordered list of items (speakers, hymns, prayers, business…)
// that can be added, removed, reordered (drag or ▲▼), each with allotted minutes.
// Two views: cards (with quick status) and a spreadsheet-style table with inline editing.
import { db } from "./firebase-init.js";
import { hasRole } from "./app.js";
import {
  collection, onSnapshot, doc, setDoc, deleteDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc, fmtDate, todayISO } from "./ui.js";

const ORGS = ["Relief Society", "Elders Quorum", "Primary", "Young Men", "Young Women"];

const DEFAULT_BISHOPRIC = ["Bishop Christensen", "Brother Bennett", "Brother Beach"];
let bishopric = [...DEFAULT_BISHOPRIC];
let priests = []; // ward priests, for Blessing the Sacrament dropdowns

const MEETING_TYPES = [
  ["sacrament", "Sacrament Meeting"],
  ["fast", "Fast & Testimony Meeting"],
  ["conference", "General Conference"],
  ["stakeconf", "Stake Conference"],
  ["primary", "Primary Program"],
  ["christmas", "Christmas Program"],
  ["easter", "Easter Program"],
  ["other", "Other (custom)"],
];

// ---- Agenda item kinds ----
const KINDS = {
  announcements:    { label: "Announcements" },
  wardBusiness:     { label: "Ward Business" },
  openingHymn:      { label: "Opening Hymn" },
  invocation:       { label: "Opening Prayer" },
  sacramentHymn:    { label: "Sacrament Hymn" },
  sacrament:        { label: "Administration of the Sacrament" },
  blessing:         { label: "Blessing the Sacrament" },
  primarySpeaker:   { label: "Primary Speaker" },
  youthSpeaker:     { label: "Youth Speaker" },
  speaker:          { label: "Speaker" },
  musical:          { label: "Special Musical Number" },
  intermediateHymn: { label: "Intermediate Hymn" },
  babyBlessing:     { label: "Baby Blessing" },
  testimonies:      { label: "Bearing of Testimonies" },
  closingHymn:      { label: "Closing Hymn" },
  benediction:      { label: "Closing Prayer" },
  custom:           { label: "Custom Item" },
};

const HYMN_KINDS = ["openingHymn", "sacramentHymn", "intermediateHymn", "closingHymn"];
// compact labels for the table's Type column
const SHORT_TYPE = {
  sacrament: "—", fast: "Fast & Testimony", conference: "Gen. Conference",
  stakeconf: "Stake Conf.", primary: "Primary Prog.", christmas: "Christmas",
  easter: "Easter", other: "Other",
};
// types with no ward sacrament meeting at all
const NO_MEETING = (t) => t === "conference" || t === "stakeconf";
// types where assigned speakers don't apply (washed out in the table)
const NO_SPEAKERS = (t) => t === "fast" || t === "primary";
const SPEAKER_KINDS = ["primarySpeaker", "youthSpeaker", "speaker"];
const PRAYER_KINDS = ["invocation", "benediction"];

// canonical meeting order, used when the table view adds a missing item
const CANON = ["announcements", "openingHymn", "invocation", "wardBusiness", "sacramentHymn",
  "sacrament", "blessing", "babyBlessing", "primarySpeaker", "youthSpeaker", "speaker", "musical",
  "intermediateHymn", "testimonies", "closingHymn", "benediction", "custom"];

function defaultItems(type) {
  const mk = (kind, time) => blankItem(kind, time);
  if (type === "fast") {
    return [
      mk("announcements", 3), mk("openingHymn", 3), mk("invocation", 2),
      mk("wardBusiness", 3), mk("sacramentHymn", 3), mk("blessing", 12),
      mk("testimonies", 30), mk("closingHymn", 3), mk("benediction", 2),
    ];
  }
  return [
    mk("announcements", 3), mk("openingHymn", 3), mk("invocation", 2),
    mk("wardBusiness", 3), mk("sacramentHymn", 3), mk("blessing", 12),
    mk("primarySpeaker", 3), mk("youthSpeaker", 5), mk("speaker", 10),
    mk("intermediateHymn", 3), mk("speaker", 12), mk("closingHymn", 3),
    mk("benediction", 2),
  ];
}

function blankItem(kind, time = 5) {
  const it = { kind, time };
  if (HYMN_KINDS.includes(kind)) Object.assign(it, { num: "", title: "" });
  else if (SPEAKER_KINDS.includes(kind)) Object.assign(it, { name: "", topic: "" });
  else if (PRAYER_KINDS.includes(kind)) Object.assign(it, { name: "", org: "" });
  else if (kind === "musical") Object.assign(it, { who: "", hymn: "", accompanist: "" });
  else if (kind === "blessing") Object.assign(it, { priest1: "", priest2: "" });
  else if (kind === "babyBlessing") Object.assign(it, { name: "" });
  else if (kind === "wardBusiness") Object.assign(it, { sustainings: [], releasings: [], other: "" });
  else if (kind === "custom") Object.assign(it, { label: "", text: "" });
  else Object.assign(it, { text: "" });
  return it;
}

// ---- Sunday helpers ----
const ordinal = (n) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

function nthSunday(dateISO) {
  return Math.floor((Number(dateISO.slice(8, 10)) - 1) / 7) + 1;
}

// General Conference: 1st Sunday of April & October.
// Fast Sunday: the first Sunday each month that sacrament meeting is held.
function defaultTypeFor(dateISO) {
  const month = Number(dateISO.slice(5, 7));
  const nth = nthSunday(dateISO);
  const confMonth = month === 4 || month === 10;
  if (confMonth && nth === 1) return "conference";
  if (nth === 1) return "fast";
  if (confMonth && nth === 2) return "fast";
  return "sacrament";
}

// ---- State ----
let meetings = {};   // date -> doc data
let started = false;
let viewMode = localStorage.getItem("sw-sacview") || "cards";
let viewYear = new Date().getFullYear();
let showPast = false; // table: include the current year's earlier Sundays

export function initSacrament() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-sacrament");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Sacrament Meeting</h2>
        <p class="panel-sub">Agenda, speakers, hymns, and prayers for each Sunday.</p>
      </div>
      <div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
        <div class="chips">
          ${[viewYear, viewYear + 1].map((y) => `<button class="chip" data-year="${y}">${y}</button>`).join("")}
        </div>
        <div class="chips">
          <button class="chip" data-view-mode="cards">Cards</button>
          <button class="chip" data-view-mode="table">Table</button>
        </div>
        ${hasRole("bishopric") ? `<button class="btn" id="btn-edit-bishopric">⚙ Settings</button>` : ""}
      </div>
    </div>
    <div id="sunday-list"></div>`;

  panel.querySelector("#btn-edit-bishopric")?.addEventListener("click", editBishopric);
  panel.querySelectorAll("[data-view-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      viewMode = b.dataset.viewMode;
      localStorage.setItem("sw-sacview", viewMode);
      render();
    }));
  panel.querySelectorAll("[data-year]").forEach((b) =>
    b.addEventListener("click", () => {
      viewYear = Number(b.dataset.year);
      render();
    }));

  loadBishopric();
  onSnapshot(collection(db, "meetings"), (qs) => {
    meetings = {};
    qs.docs.forEach((d) => (meetings[d.id] = d.data()));
    render();
  });
}

async function loadBishopric() {
  try {
    const snap = await getDoc(doc(db, "settings", "leadership"));
    if (snap.exists()) {
      const d = snap.data();
      if (Array.isArray(d.bishopric) && d.bishopric.length) bishopric = d.bishopric;
      if (Array.isArray(d.priests)) priests = d.priests;
    } else if (hasRole("bishopric")) {
      await setDoc(doc(db, "settings", "leadership"), { bishopric: DEFAULT_BISHOPRIC, priests: [] });
    }
  } catch { /* keep defaults */ }
  render();
}

function editBishopric() {
  const nameRows = (cls, list) => list.map((n) =>
    `<div class="speaker-row"><input class="${cls}" value="${esc(n)}"><button class="btn btn-sm set-del" type="button">✕</button></div>`).join("");
  const el = openModal(`
    <h3>Settings</h3>
    <div class="mtg-sec-title">Bishopric</div>
    <p class="row-sub" style="margin:0 0 .5rem">These names fill the Presiding and Conducting dropdowns.</p>
    <div id="bp-rows">${nameRows("bp-name", bishopric)}</div>
    <button class="btn btn-sm" id="bp-add" type="button">+ Add name</button>
    <div class="mtg-sec-title" style="margin-top:1.1rem">Priests</div>
    <p class="row-sub" style="margin:0 0 .5rem">These names fill the "Blessing the Sacrament" dropdowns.</p>
    <div id="pr-rows">${nameRows("pr-name", priests)}</div>
    <button class="btn btn-sm" id="pr-add" type="button">+ Add priest</button>
    <div class="modal-actions">
      <div class="right">
        <button class="btn" id="bp-cancel">Cancel</button>
        <button class="btn btn-primary" id="bp-save">Save</button>
      </div>
    </div>`);
  el.addEventListener("click", (e) => {
    if (e.target.classList.contains("set-del")) e.target.closest(".speaker-row").remove();
  });
  const addRow = (wrapId, cls) => el.querySelector(wrapId).insertAdjacentHTML("beforeend",
    `<div class="speaker-row"><input class="${cls}" value=""><button class="btn btn-sm set-del" type="button">✕</button></div>`);
  el.querySelector("#bp-add").addEventListener("click", () => addRow("#bp-rows", "bp-name"));
  el.querySelector("#pr-add").addEventListener("click", () => addRow("#pr-rows", "pr-name"));
  el.querySelector("#bp-cancel").addEventListener("click", closeModal);
  el.querySelector("#bp-save").addEventListener("click", async () => {
    const names = [...el.querySelectorAll(".bp-name")].map((i) => i.value.trim()).filter(Boolean);
    const priestNames = [...el.querySelectorAll(".pr-name")].map((i) => i.value.trim()).filter(Boolean);
    if (!names.length) { toast("Add at least one bishopric name"); return; }
    try {
      await setDoc(doc(db, "settings", "leadership"), { bishopric: names, priests: priestNames });
      bishopric = names;
      priests = priestNames;
      closeModal(); toast("Settings saved"); render();
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
}

// ---- Sunday helpers ----
const isoOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function currentWeekSunday() {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 7) % 7));
  return isoOf(d);
}

// every Sunday of a year; pass fromISO to start at that date instead of Jan 1
function sundaysOfYear(year, fromISO) {
  const out = [];
  const d = new Date(year, 0, 1, 12);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  while (d.getFullYear() === year) {
    const iso = isoOf(d);
    if (!fromISO || iso >= fromISO) out.push(iso);
    d.setDate(d.getDate() + 7);
  }
  return out;
}

function typeLabel(m, date) {
  const t = m?.type || defaultTypeFor(date);
  if (t === "other" && m?.customType) return m.customType;
  return MEETING_TYPES.find(([k]) => k === t)?.[1] || t;
}

function itemsFor(m, date) {
  return m?.items ?? defaultItems(m?.type || defaultTypeFor(date));
}

// ---- Quick status chips ----
function statusChips(m, date) {
  const type = m?.type || defaultTypeFor(date);
  if (NO_MEETING(type)) return "";
  const items = itemsFor(m, date);
  const planned = !!m;
  const can = hasRole("bishopric");
  const of = (k) => items.filter((i) => i.kind === k);
  // ok + name -> green pill that expands to show the person;
  // qe -> pill is clickable for quick inline assignment
  const chip = (label, ok, name, qe) => {
    const cls = ok ? "st-ok" : planned ? "st-miss" : "st-off";
    const clickable = qe && can;
    return `<span class="st ${cls}${clickable ? " st-click" : ""}"${clickable ? ` data-qe='${JSON.stringify(qe)}' title="Click to assign"` : ""}>${ok ? "✓" : "○"} ${label}${ok && name ? `<span class="st-name">${esc(name)}</span>` : ""}</span>`;
  };

  const hymns = items.filter((i) => HYMN_KINDS.includes(i.kind));
  const hymnsFilled = hymns.filter((h) => h.num || h.title).length;
  const inv = of("invocation")[0];
  const ben = of("benediction")[0];

  const chips = [
    chip("Conducting", !!m?.conducting, m?.conducting, { t: "c" }),
    chip("Open Prayer", !!inv?.name, inv?.name, { t: "i", k: "invocation", o: 0 }),
    chip("Close Prayer", !!ben?.name, ben?.name, { t: "i", k: "benediction", o: 0 }),
    chip(`Hymns ${hymnsFilled}/${hymns.length}`, hymns.length > 0 && hymnsFilled === hymns.length, null, { t: "h" }),
  ];

  // Ward Business: grey when none entered; green + clickable when there is some
  const wb = of("wardBusiness");
  const susCount = wb.reduce((a, b) => a + (b.sustainings?.length || 0), 0);
  const relCount = wb.reduce((a, b) => a + (b.releasings?.length || 0), 0);
  const wbOther = wb.some((b) => (b.other || "").trim());
  if (susCount || relCount || wbOther) {
    const parts = [];
    if (susCount) parts.push(`${susCount} sustain`);
    if (relCount) parts.push(`${relCount} release`);
    if (wbOther) parts.push("other");
    chips.push(`<span class="st st-ok st-click" data-wb="${date}" title="Click to view">✓ Ward Business<span class="st-name">${parts.join(" · ")}</span></span>`);
  } else {
    chips.push(`<span class="st st-off">○ Ward Business</span>`);
  }

  // one pill per speaker slot, regular speakers numbered
  const regTotal = of("speaker").length;
  let sNum = 0;
  const occ = {};
  items.forEach((it) => {
    if (!SPEAKER_KINDS.includes(it.kind)) return;
    const o = occ[it.kind] ?? 0;
    occ[it.kind] = o + 1;
    let label = KINDS[it.kind].label;
    if (it.kind === "speaker") { sNum++; if (regTotal > 1) label = `Speaker ${sNum}`; }
    chips.push(chip(label, !!it.name, it.name, { t: "i", k: it.kind, o }));
  });

  // musical number: grey when not on the agenda, red when unassigned, green + name when set
  const mus = of("musical");
  if (mus.length) mus.forEach((x, o) => chips.push(chip("Musical #", !!x.who, x.who, { t: "i", k: "musical", o })));
  else chips.push(`<span class="st st-off${can ? " st-click" : ""}"${can ? ` data-qe='{"t":"i","k":"musical","o":0}' title="Click to assign"` : ""}>○ Musical #</span>`);

  return `<div class="st-row">${chips.join("")}</div>`;
}

// ---- Render ----
function render() {
  const wrap = document.getElementById("sunday-list");
  if (!wrap) return;
  document.querySelectorAll("#panel-sacrament [data-view-mode]").forEach((b) =>
    b.classList.toggle("active", b.dataset.viewMode === viewMode));
  document.querySelectorAll("#panel-sacrament [data-year]").forEach((b) =>
    b.classList.toggle("active", Number(b.dataset.year) === viewYear));
  if (viewMode === "table") renderTable(wrap);
  else renderCards(wrap);
}

// rest of the current year; the whole year for other years
function viewDates() {
  const thisYear = new Date().getFullYear();
  return sundaysOfYear(viewYear, viewYear === thisYear ? currentWeekSunday() : null);
}

// ===== Cards view =====
function renderCards(wrap) {
  const canEdit = hasRole("bishopric");
  const today = todayISO();

  wrap.innerHTML = viewDates().map((date) => {
    const m = meetings[date];
    const type = m?.type || defaultTypeFor(date);
    const isPast = date < today;
    const planned = !!m;
    const isConf = NO_MEETING(type);
    const nth = nthSunday(date);
    const total = planned ? (m.items || []).reduce((s, i) => s + (Number(i.time) || 0), 0) : 0;
    const babies = planned ? (m.items || []).filter((i) => i.kind === "babyBlessing") : [];
    return `
    <div class="card clickable ${isConf ? "conf-card" : ""}" data-date="${date}" style="${isPast ? "opacity:.6" : ""}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.75rem;flex-wrap:wrap">
        <div>
          <h3 style="margin:0">${fmtDate(date, { year: true })}
            ${type !== "sacrament" ? `<span class="pill ${isConf ? "pill-conf" : type === "fast" ? "pill-inprogress" : "pill-approved"}" style="vertical-align:middle">${esc(typeLabel(m, date))}</span>` : ""}
            ${m?.theme ? `<span class="theme-tag">“${esc(m.theme)}”</span>` : ""}
            ${babies.map((b) => `<span class="pill pill-baby" style="vertical-align:middle">👶 Baby Blessing${b.name ? ": " + esc(b.name) : ""}</span>`).join(" ")}
          </h3>
          <div class="row-sub">${nth === 5 ? `<span class="nth-pill nth-5">5th Sunday</span> ` : ""}${planned && total ? `${total} min` : ""}${isConf ? "no sacrament meeting" : ""}</div>
        </div>
        ${canEdit ? `<button class="btn btn-sm" data-edit="${date}">${planned ? "Edit" : "Plan"}</button>` : ""}
      </div>
      ${statusChips(m, date)}
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); editMeeting(b.dataset.edit); }));
  wrap.querySelectorAll("[data-wb]").forEach((el) =>
    el.addEventListener("click", (e) => { e.stopPropagation(); wbModal(el.dataset.wb); }));
  wrap.querySelectorAll("[data-qe]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      quickEdit(el.closest("[data-date]").dataset.date, JSON.parse(el.dataset.qe));
    }));
  wrap.querySelectorAll(".card.clickable").forEach((card) =>
    card.addEventListener("click", () => viewMeeting(card.dataset.date)));
}

// find the o-th item of a kind
function nthItem(items, kind, o) {
  let c = 0;
  for (const it of items) if (it.kind === kind) { if (c === o) return it; c++; }
  return null;
}

// ===== Quick assignment from a status pill =====
function quickEdit(date, q) {
  const cur = meetings[date];
  const type = cur?.type || defaultTypeFor(date);
  const items = cur?.items ? cur.items : defaultItems(type);
  const dateLabel = `<span class="row-sub">· ${fmtDate(date, { year: true })}</span>`;

  const orgSel = (id, val) => `
    <select id="${id}"><option value="">Arranged by…</option>
      ${ORGS.map((o) => `<option value="${o}" ${val === o ? "selected" : ""}>${o}</option>`).join("")}
    </select>`;

  let html = "", onSave = null;

  if (q.t === "c") {
    html = `<h3>Conducting ${dateLabel}</h3>
      <label class="field">Conducting ${personSelect("qe-cond", cur?.conducting || "")}</label>`;
    onSave = (el) => {
      const val = readPersonSelect(el, "qe-cond");
      return (m) => { m.conducting = val; };
    };
  } else if (q.t === "h") {
    const hymnRows = [];
    const occ = {};
    items.forEach((it) => {
      if (!HYMN_KINDS.includes(it.kind)) return;
      const o = occ[it.kind] ?? 0;
      occ[it.kind] = o + 1;
      hymnRows.push({ kind: it.kind, o, num: it.num || "", title: it.title || "" });
    });
    html = `<h3>Hymns ${dateLabel}</h3>
      ${hymnRows.map((h, i) => `
        <label class="field" style="margin-bottom:.6rem">${KINDS[h.kind].label}
          <div style="display:flex;gap:.4rem">
            <input id="qe-num-${i}" placeholder="#" inputmode="numeric" style="width:4.5rem" value="${esc(h.num)}">
            <input id="qe-title-${i}" placeholder="Hymn title" style="flex:1" value="${esc(h.title)}">
          </div>
        </label>`).join("")}`;
    onSave = (el) => {
      const vals = hymnRows.map((h, i) => ({
        kind: h.kind, o: h.o,
        num: el.querySelector(`#qe-num-${i}`).value.trim(),
        title: el.querySelector(`#qe-title-${i}`).value.trim(),
      }));
      return (m) => vals.forEach((v) => {
        let it = nthItem(m.items, v.kind, v.o);
        if (!it) { it = blankItem(v.kind, 3); insertCanonical(m.items, it); }
        it.num = v.num; it.title = v.title;
      });
    };
  } else {
    const it = nthItem(items, q.k, q.o) || blankItem(q.k);
    const label = KINDS[q.k]?.label || q.k;
    if (PRAYER_KINDS.includes(q.k)) {
      html = `<h3>${label} ${dateLabel}</h3>
        <label class="field">Name <input id="qe-name" value="${esc(it.name || "")}"></label>
        <label class="field" style="margin-top:.6rem">Arranged by ${orgSel("qe-org", it.org || "")}</label>`;
      onSave = (el) => {
        const name = el.querySelector("#qe-name").value.trim();
        const org = el.querySelector("#qe-org").value;
        return (m) => { const t = ensureQE(m, q); t.name = name; t.org = org; };
      };
    } else if (SPEAKER_KINDS.includes(q.k)) {
      html = `<h3>${label} ${dateLabel}</h3>
        <label class="field">Name <input id="qe-name" value="${esc(it.name || "")}"></label>
        <label class="field" style="margin-top:.6rem">Topic (optional) <input id="qe-topic" value="${esc(it.topic || "")}"></label>`;
      onSave = (el) => {
        const name = el.querySelector("#qe-name").value.trim();
        const topic = el.querySelector("#qe-topic").value.trim();
        return (m) => { const t = ensureQE(m, q); t.name = name; t.topic = topic; };
      };
    } else if (q.k === "musical") {
      html = `<h3>${label} ${dateLabel}</h3>
        <label class="field">Who (person/group) <input id="qe-who" value="${esc(it.who || "")}"></label>
        <label class="field" style="margin-top:.6rem">Hymn / piece <input id="qe-hymn" value="${esc(it.hymn || "")}"></label>
        <label class="field" style="margin-top:.6rem">Accompanist <input id="qe-acc" value="${esc(it.accompanist || "")}"></label>`;
      onSave = (el) => {
        const who = el.querySelector("#qe-who").value.trim();
        const hymn = el.querySelector("#qe-hymn").value.trim();
        const acc = el.querySelector("#qe-acc").value.trim();
        return (m) => { const t = ensureQE(m, q); t.who = who; t.hymn = hymn; t.accompanist = acc; };
      };
    } else return;
  }

  const el = openModal(html + `
    <div class="modal-actions">
      <div class="right">
        <button class="btn" id="qe-cancel">Cancel</button>
        <button class="btn btn-primary" id="qe-save">Save</button>
      </div>
    </div>`);
  el.querySelector("#qe-cancel").addEventListener("click", closeModal);
  el.querySelector("#qe-save").addEventListener("click", async () => {
    const mutate = onSave(el);
    await patchMeeting(date, mutate);
    closeModal();
  });
  el.querySelector("input, select")?.focus();
}

function ensureQE(m, q) {
  let it = nthItem(m.items, q.k, q.o);
  if (!it) { it = blankItem(q.k); insertCanonical(m.items, it); }
  return it;
}

// Ward Business quick popup
function wbModal(date) {
  const m = meetings[date];
  if (!m) return;
  const wb = (m.items || []).filter((i) => i.kind === "wardBusiness");
  const sus = wb.flatMap((b) => b.sustainings || []);
  const rel = wb.flatMap((b) => b.releasings || []);
  const other = wb.map((b) => (b.other || "").trim()).filter(Boolean);
  const line = (p) => `<div>${esc(p.name)}${p.calling ? ` — <span class="row-sub">${esc(p.calling)}</span>` : ""}</div>`;
  const el = openModal(`
    <h3>Ward Business <span class="row-sub">· ${fmtDate(date, { year: true })}</span></h3>
    <div class="agenda-view">
      ${sus.length ? `<div class="mtg-sec-title">Sustainings</div>${sus.map(line).join("")}` : ""}
      ${rel.length ? `<div class="mtg-sec-title" style="margin-top:.7rem">Releasings</div>${rel.map(line).join("")}` : ""}
      ${other.length ? `<div class="mtg-sec-title" style="margin-top:.7rem">Other</div>${other.map((o) => `<div>${esc(o)}</div>`).join("")}` : ""}
      ${!sus.length && !rel.length && !other.length ? `<div class="empty-note">No ward business entered.</div>` : ""}
    </div>
    <div class="modal-actions">
      <div class="right">
        <button class="btn" id="wb-close">Close</button>
        ${hasRole("bishopric") ? `<button class="btn btn-primary" id="wb-edit">Edit</button>` : ""}
      </div>
    </div>`);
  el.querySelector("#wb-close").addEventListener("click", closeModal);
  el.querySelector("#wb-edit")?.addEventListener("click", () => { closeModal(); editMeeting(date); });
}

// ===== View modal =====
function viewMeeting(date) {
  const m = meetings[date];
  const canEdit = hasRole("bishopric");
  if (!m) {
    if (canEdit) return editMeeting(date);
    return toast("Not planned yet");
  }
  const el = openModal(`
    <h3>${fmtDate(date, { year: true })} <span class="row-sub">·${nthSunday(date) === 5 ? " 5th Sunday ·" : ""} ${esc(typeLabel(m, date))}</span>
      ${m.theme ? `<div class="theme-tag" style="margin-top:.2rem">“${esc(m.theme)}”</div>` : ""}</h3>
    ${renderAgendaView(m)}
    <div class="modal-actions">
      <div class="right">
        <button class="btn" id="vw-close">Close</button>
        ${canEdit ? `<button class="btn btn-primary" id="vw-edit">Edit</button>` : ""}
      </div>
    </div>`);
  el.querySelector("#vw-close").addEventListener("click", closeModal);
  el.querySelector("#vw-edit")?.addEventListener("click", () => { closeModal(); editMeeting(date); });
}

function renderAgendaView(m) {
  if (NO_MEETING(m.type)) {
    return `<div class="row-sub" style="margin-top:.4rem">🏛 ${esc(typeLabel(m, m.date))} — no ward sacrament meeting.${m.notes ? " " + esc(m.notes) : ""}</div>`;
  }
  const head = [
    m.presiding ? `<div><span class="ag-label">Presiding:</span> ${esc(m.presiding)}</div>` : "",
    m.conducting ? `<div><span class="ag-label">Conducting:</span> ${esc(m.conducting)}</div>` : "",
    m.chorister ? `<div><span class="ag-label">Music conductor:</span> ${esc(m.chorister)}</div>` : "",
    m.organist ? `<div><span class="ag-label">Organist:</span> ${esc(m.organist)}</div>` : "",
  ].join("");
  const items = (m.items || []).map((it) => {
    const t = it.time ? ` <span class="row-sub">(${it.time} min)</span>` : "";
    const label = it.kind === "custom" ? (it.label || "Item") : (KINDS[it.kind]?.label || it.kind);
    let val = "";
    if (HYMN_KINDS.includes(it.kind)) {
      val = esc([it.num ? "#" + it.num : "", it.title].filter(Boolean).join(" "));
    } else if (SPEAKER_KINDS.includes(it.kind)) {
      val = esc([it.name, it.topic ? "— " + it.topic : ""].filter(Boolean).join(" "));
    } else if (PRAYER_KINDS.includes(it.kind)) {
      val = esc(it.name || "") + (it.org ? ` <span class="row-sub">(arranged by ${esc(it.org)})</span>` : "");
    } else if (it.kind === "musical") {
      val = esc([it.who, it.hymn ? "— " + it.hymn : ""].filter(Boolean).join(" "))
        + (it.accompanist ? ` <span class="row-sub">(accompanist: ${esc(it.accompanist)})</span>` : "");
    } else if (it.kind === "blessing") {
      val = esc([it.priest1, it.priest2].filter(Boolean).join(" & "));
    } else if (it.kind === "babyBlessing") {
      val = esc(it.name || "");
    } else if (it.kind === "wardBusiness") {
      const parts = [];
      (it.sustainings || []).forEach((s) => parts.push(`Sustain: ${esc(s.name)}${s.calling ? " — " + esc(s.calling) : ""}`));
      (it.releasings || []).forEach((r) => parts.push(`Release: ${esc(r.name)}${r.calling ? " — " + esc(r.calling) : ""}`));
      if (it.other) parts.push(esc(it.other));
      val = parts.join("; ");
    } else {
      val = esc(it.text || "");
    }
    return `<div><span class="ag-label">${esc(label)}:</span> ${val}${t}</div>`;
  }).join("");
  return `<div class="agenda-view" style="margin-top:.6rem">${head}${items}${m.notes ? `<div><span class="ag-label">Notes:</span> ${esc(m.notes)}</div>` : ""}</div>`;
}

// ===== Table (spreadsheet) view =====
function renderTable(wrap) {
  const canEdit = hasRole("bishopric");
  const today = todayISO();
  const thisYear = new Date().getFullYear();
  // default: this week onward; "show previous" reveals the whole year (past rows dimmed)
  const dates = (viewYear === thisYear && !showPast)
    ? sundaysOfYear(viewYear, currentWeekSunday())
    : sundaysOfYear(viewYear);

  const rows = dates.map((date) => {
    const m = meetings[date];
    const type = m?.type || defaultTypeFor(date);
    const isConf = NO_MEETING(type);
    const planned = !!m;
    const items = planned ? m.items || [] : [];
    const first = (k) => items.find((i) => i.kind === k);
    const dis = canEdit ? "" : "disabled";
    const nth = nthSunday(date);
    const shortDate = new Date(date + "T12:00:00")
      .toLocaleDateString("en-US", { month: "short", day: "numeric" });

    const hymnCell = (kind) => {
      if (isConf) return `<td class="conf-cell"></td>`;
      const it = first(kind);
      return `
      <td><div class="hymn-cell">
        <input class="cell-in cell-num" data-date="${date}" data-cell="hymnNum" data-kind="${kind}"
          value="${esc(it?.num || "")}" placeholder="#" inputmode="numeric" ${dis}>
        <input class="cell-in" data-date="${date}" data-cell="hymnTitle" data-kind="${kind}"
          value="${esc(it?.title || "")}" placeholder="name" ${dis}>
      </div></td>`;
    };

    const prayerCell = (kind) => {
      if (isConf) return `<td class="conf-cell"></td>`;
      const it = first(kind);
      return `
      <td><input class="cell-in" data-date="${date}" data-cell="prayerName" data-kind="${kind}"
          value="${esc(it?.name || "")}" placeholder="name" ${dis}>
        <select class="cell-sel" data-date="${date}" data-cell="prayerOrg" data-kind="${kind}" ${dis}>
          <option value="">org…</option>
          ${ORGS.map((o) => `<option value="${o}" ${it?.org === o ? "selected" : ""}>${o}</option>`).join("")}
        </select></td>`;
    };

    const textCell = (cell, value, ph) => isConf ? `<td class="conf-cell"></td>` :
      `<td><input class="cell-in" data-date="${date}" data-cell="${cell}" value="${esc(value || "")}" placeholder="${ph}" ${dis}></td>`;

    // Speakers: always show the four default slots; washed out where speakers don't apply
    let spkHtml = "";
    if (!isConf) {
      const tag = { primarySpeaker: "P", youthSpeaker: "Y", speaker: "S" };
      if (NO_SPEAKERS(type)) {
        spkHtml = `<div class="spk-washed">P · Y · S1 · S2<br>${type === "fast" ? "testimonies" : "primary program"}</div>`;
      } else {
        const slots = (planned ? items : defaultItems(type)).filter((i) => SPEAKER_KINDS.includes(i.kind));
        let sNum = 0;
        const regTotal = slots.filter((s) => s.kind === "speaker").length;
        spkHtml = slots.map((s) => {
          let t = tag[s.kind];
          if (s.kind === "speaker") { sNum++; if (regTotal > 1) t = "S" + sNum; }
          return `<div>${t}: ${s.name ? esc(s.name) : "<span class='row-sub'>—</span>"}</div>`;
        }).join("") || "<span class='row-sub'>—</span>";
      }
    }

    const mus = first("musical");
    const interHtml = isConf ? "" :
      mus ? `♫ ${esc(mus.who || "—")}` : `
      <div class="hymn-cell">
        <input class="cell-in cell-num" data-date="${date}" data-cell="hymnNum" data-kind="intermediateHymn" value="${esc(first("intermediateHymn")?.num || "")}" placeholder="#" inputmode="numeric" ${dis}>
        <input class="cell-in" data-date="${date}" data-cell="hymnTitle" data-kind="intermediateHymn" value="${esc(first("intermediateHymn")?.title || "")}" placeholder="name" ${dis}>
      </div>`;

    return `
    <tr class="${date < today ? "row-past" : ""} ${planned ? "" : "row-unplanned"} ${isConf ? "row-conf" : ""} ${type === "fast" ? "row-fast" : ""}">
      <td class="cell-date" data-view="${date}">
        <b>${shortDate}</b>
        ${nth === 5 ? `<div><span class="nth-pill nth-5">5th</span></div>` : ""}
      </td>
      <td>
        <select class="cell-sel" data-date="${date}" data-cell="type" ${dis}>
          ${MEETING_TYPES.map(([k]) => `<option value="${k}" ${type === k ? "selected" : ""}>${SHORT_TYPE[k] || k}</option>`).join("")}
        </select>
        ${isConf ? "" : `<input class="cell-in cell-theme" data-date="${date}" data-cell="theme" value="${esc(m?.theme || "")}" placeholder="theme" ${dis}>`}
      </td>
      <td>${isConf ? "" : `
        <select class="cell-sel" data-date="${date}" data-cell="conducting" ${dis}>
          <option value="">—</option>
          ${bishopric.map((n) => `<option value="${esc(n)}" ${m?.conducting === n ? "selected" : ""}>${esc(n)}</option>`).join("")}
          ${m?.conducting && !bishopric.includes(m.conducting) ? `<option value="${esc(m.conducting)}" selected>${esc(m.conducting)}</option>` : ""}
        </select>`}
      </td>
      <td>${isConf ? "" : `
        <input class="cell-in" data-date="${date}" data-cell="chorister" value="${esc(m?.chorister || "")}" placeholder="conductor" ${dis}>
        <input class="cell-in" data-date="${date}" data-cell="organist" value="${esc(m?.organist || "")}" placeholder="organist" ${dis}>`}
      </td>
      ${hymnCell("openingHymn")}
      ${prayerCell("invocation")}
      ${hymnCell("sacramentHymn")}
      <td class="cell-spk ${canEdit && !isConf ? "clickable" : ""}" ${canEdit && !isConf ? `data-editspk="${date}"` : ""}>${spkHtml}</td>
      <td>${interHtml}</td>
      ${hymnCell("closingHymn")}
      ${prayerCell("benediction")}
    </tr>`;
  }).join("");

  wrap.innerHTML = `
    <div class="card table-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;gap:.6rem">
        ${viewYear === new Date().getFullYear()
          ? `<button class="btn btn-sm" id="tbl-past">${showPast ? "Hide previous Sundays" : "← Show previous Sundays"}</button>`
          : "<span></span>"}
        <span class="row-sub">${viewYear} · ${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}</span>
        <span></span>
      </div>
      <div class="table-scroll">
        <table class="sheet">
          <thead><tr>
            <th>Date</th><th>Type / Theme</th><th>Conducting</th><th>Conductor / Organist</th>
            <th>Opening Hymn</th><th>Opening Prayer</th><th>Sacrament Hymn</th><th>Speakers</th>
            <th>Interm. / Musical</th><th>Closing Hymn</th><th>Closing Prayer</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="row-sub" style="margin:.6rem 0 0">Type directly in a cell to assign — changes save when you leave the cell. Click a date to see the full agenda, or the Speakers cell to open the full editor.</p>
    </div>`;

  wrap.querySelector("#tbl-past")?.addEventListener("click", () => { showPast = !showPast; render(); });
  wrap.querySelectorAll("[data-view]").forEach((td) =>
    td.addEventListener("click", () => viewMeeting(td.dataset.view)));
  wrap.querySelectorAll("[data-editspk]").forEach((td) =>
    td.addEventListener("click", () => editMeeting(td.dataset.editspk)));

  if (!canEdit) return;
  wrap.querySelectorAll(".cell-in, .cell-sel").forEach((el) =>
    el.addEventListener("change", () => commitCell(el)));
}

// insert a table-created item at its canonical spot in the agenda
function insertCanonical(items, it) {
  const r = CANON.indexOf(it.kind);
  let idx = items.findIndex((x) => CANON.indexOf(x.kind) > r);
  if (idx < 0) idx = items.length;
  items.splice(idx, 0, it);
}

async function patchMeeting(date, mutate) {
  const cur = meetings[date];
  const type = cur?.type || defaultTypeFor(date);
  const m = cur
    ? JSON.parse(JSON.stringify(cur))
    : { date, type, customType: "", theme: "", presiding: "", conducting: "", chorister: "", organist: "", items: defaultItems(type), notes: "" };
  mutate(m);
  m.updatedAt = serverTimestamp();
  try {
    await setDoc(doc(db, "meetings", date), m);
    toast("Saved");
  } catch (err) {
    toast("Couldn't save: " + (err.code || err.message));
  }
}

function commitCell(el) {
  const { date, cell, kind } = el.dataset;
  const val = el.value;
  patchMeeting(date, (m) => {
    const ensure = (k) => {
      let it = m.items.find((i) => i.kind === k);
      if (!it) { it = blankItem(k, k.includes("Hymn") ? 3 : 2); insertCanonical(m.items, it); }
      return it;
    };
    if (cell === "type") {
      const wasUnplanned = !meetings[date];
      m.type = val;
      if (wasUnplanned || (m.items.length === 0 && val !== "conference")) m.items = defaultItems(val);
    } else if (cell === "theme") {
      m.theme = val.trim();
    } else if (cell === "chorister") {
      m.chorister = val.trim();
    } else if (cell === "organist") {
      m.organist = val.trim();
    } else if (cell === "conducting") {
      m.conducting = val;
    } else if (cell === "hymnNum") {
      ensure(kind).num = val.trim();
    } else if (cell === "hymnTitle") {
      ensure(kind).title = val.trim();
    } else if (cell === "prayerName") {
      ensure(kind).name = val.trim();
    } else if (cell === "prayerOrg") {
      ensure(kind).org = val;
    }
  });
}

// =========================================================
// Editor
// =========================================================
let draft = null; // { items: [...] } being edited

function personSelect(id, value, extraBlankLabel) {
  const known = bishopric.includes(value);
  return `
    <select id="${id}" data-other="${id}-other">
      <option value="">${extraBlankLabel || "—"}</option>
      ${bishopric.map((n) => `<option value="${esc(n)}" ${value === n ? "selected" : ""}>${esc(n)}</option>`).join("")}
      <option value="__other__" ${value && !known ? "selected" : ""}>Other…</option>
    </select>
    <input id="${id}-other" placeholder="Name" value="${value && !known ? esc(value) : ""}"
      style="margin-top:.3rem;${value && !known ? "" : "display:none"}">`;
}

function readPersonSelect(el, id) {
  const sel = el.querySelector("#" + id);
  if (!sel) return "";
  return sel.value === "__other__" ? el.querySelector("#" + id + "-other").value.trim() : sel.value;
}

function editMeeting(date) {
  const m = meetings[date] || {};
  const type = m.type || defaultTypeFor(date);
  draft = {
    items: m.items ? JSON.parse(JSON.stringify(m.items)) : defaultItems(type),
  };

  const el = openModal(`
    <h3>${fmtDate(date, { year: true })}${nthSunday(date) === 5 ? ` <span class="nth-pill nth-5">5th Sunday</span>` : ""}</h3>
    <div class="form-grid two-col">
      <label class="field">Meeting type
        <select id="mt-type">
          ${MEETING_TYPES.map(([k, l]) => `<option value="${k}" ${type === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label class="field" id="mt-custom-wrap" style="${type === "other" ? "" : "display:none"}">Custom name
        <input id="mt-custom" value="${esc(m.customType || "")}">
      </label>
      <label class="field full">Theme
        <input id="mt-theme" placeholder='e.g. "Repentance", "The Restoration"' value="${esc(m.theme || "")}">
      </label>
      <label class="field">Presiding ${personSelect("mt-presiding", m.presiding || "")}</label>
      <label class="field">Conducting ${personSelect("mt-conducting", m.conducting || "")}</label>
      <label class="field">Music conductor <input id="mt-chorister" value="${esc(m.chorister || "")}"></label>
      <label class="field">Organist <input id="mt-organist" value="${esc(m.organist || "")}"></label>
    </div>
    <div id="mt-agenda-wrap" style="${NO_MEETING(type) ? "display:none" : ""}">
      <div class="mtg-sec-title" style="margin-top:1rem;display:flex;justify-content:space-between;align-items:center">
        <span>Agenda &nbsp;<span class="row-sub" id="mt-total"></span></span>
        <span>
          <select id="mt-add-kind" style="font-size:.82rem;padding:.25rem">
            ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}
          </select>
          <button class="btn btn-sm" id="mt-add-item" type="button">+ Add</button>
        </span>
      </div>
      <div id="mt-items"></div>
    </div>
    <label class="field" style="margin-top:.8rem">Notes
      <textarea id="mt-notes" rows="2">${esc(m.notes || "")}</textarea>
    </label>
    <div class="modal-actions">
      ${meetings[date] ? `<button class="btn btn-ghost btn-danger" id="mt-clear">Clear plan</button>` : ""}
      <div class="right">
        <span id="mt-autosave" class="row-sub" style="align-self:center"></span>
        <button class="btn btn-primary" id="mt-save">Done</button>
      </div>
    </div>`);

  el.classList.add("modal-wide");
  renderItems(el);

  // ---- autosave: every field change (tab/blur/select) writes the plan ----
  const buildData = () => {
    syncDraft(el);
    const t = el.querySelector("#mt-type").value;
    return {
      date,
      type: t,
      customType: t === "other" ? el.querySelector("#mt-custom").value.trim() : "",
      theme: el.querySelector("#mt-theme").value.trim(),
      presiding: readPersonSelect(el, "mt-presiding"),
      conducting: readPersonSelect(el, "mt-conducting"),
      chorister: el.querySelector("#mt-chorister").value.trim(),
      organist: el.querySelector("#mt-organist").value.trim(),
      items: NO_MEETING(t) ? [] : draft.items,
      notes: el.querySelector("#mt-notes").value.trim(),
      updatedAt: serverTimestamp(),
    };
  };
  let autoTimer = null;
  const scheduleAutosave = () => {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(async () => {
      try {
        await setDoc(doc(db, "meetings", date), buildData());
        const tag = el.querySelector("#mt-autosave");
        if (tag) { tag.textContent = "Saved ✓"; setTimeout(() => { tag.textContent = ""; }, 1800); }
      } catch (err) {
        toast("Couldn't save: " + (err.code || err.message));
      }
    }, 400);
  };
  el.addEventListener("change", scheduleAutosave);

  // person selects: toggle "Other…" inputs
  el.addEventListener("change", (e) => {
    const other = e.target.dataset?.other;
    if (other) {
      const inp = el.querySelector("#" + other);
      inp.style.display = e.target.value === "__other__" ? "" : "none";
      if (e.target.value === "__other__") inp.focus();
    }
  });

  el.querySelector("#mt-type").addEventListener("change", (e) => {
    const t = e.target.value;
    el.querySelector("#mt-custom-wrap").style.display = t === "other" ? "" : "none";
    el.querySelector("#mt-agenda-wrap").style.display = NO_MEETING(t) ? "none" : "";
    // offer a fresh default agenda when switching between sacrament and fast
    if ((t === "fast" || t === "sacrament") && confirm("Reset the agenda to the default for this meeting type?")) {
      draft.items = defaultItems(t);
      renderItems(el);
    }
  });

  el.querySelector("#mt-add-item").addEventListener("click", () => {
    syncDraft(el);
    draft.items.push(blankItem(el.querySelector("#mt-add-kind").value));
    renderItems(el);
    scheduleAutosave();
  });

  el.querySelector("#mt-clear")?.addEventListener("click", async () => {
    if (!confirm("Clear this Sunday's plan?")) return;
    clearTimeout(autoTimer); // don't let a pending autosave resurrect the plan
    await deleteDoc(doc(db, "meetings", date));
    closeModal(); toast("Plan cleared");
  });
  el.querySelector("#mt-save").addEventListener("click", async () => {
    clearTimeout(autoTimer);
    try {
      await setDoc(doc(db, "meetings", date), buildData());
      closeModal(); toast("Saved");
    } catch (err) {
      toast("Couldn't save: " + (err.code || err.message));
    }
  });
}

// ---- Agenda item editor ----
function renderItems(el) {
  const wrap = el.querySelector("#mt-items");
  wrap.innerHTML = draft.items.map((it, i) => itemCard(it, i)).join("");
  el.querySelector("#mt-total").textContent =
    "· total " + draft.items.reduce((s, i) => s + (Number(i.time) || 0), 0) + " min";

  // move / delete
  wrap.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      syncDraft(el);
      const i = Number(b.closest(".item-card").dataset.idx);
      const act = b.dataset.act;
      if (act === "up" && i > 0) [draft.items[i - 1], draft.items[i]] = [draft.items[i], draft.items[i - 1]];
      if (act === "down" && i < draft.items.length - 1) [draft.items[i + 1], draft.items[i]] = [draft.items[i], draft.items[i + 1]];
      if (act === "del") draft.items.splice(i, 1);
      if (act === "addsus") draft.items[i].sustainings.push({ name: "", calling: "" });
      if (act === "addrel") draft.items[i].releasings.push({ name: "", calling: "" });
      if (act === "delsus") draft.items[i].sustainings.splice(Number(b.dataset.row), 1);
      if (act === "delrel") draft.items[i].releasings.splice(Number(b.dataset.row), 1);
      renderItems(el);
      el.dispatchEvent(new Event("change")); // structural edits autosave too
    }));

  // drag & drop (grab the ≡ handle)
  let dragIdx = null;
  wrap.querySelectorAll(".item-card").forEach((card) => {
    const handle = card.querySelector(".drag-handle");
    handle.addEventListener("mousedown", () => (card.draggable = true));
    handle.addEventListener("touchstart", () => (card.draggable = true), { passive: true });
    card.addEventListener("dragstart", (e) => {
      syncDraft(el);
      dragIdx = Number(card.dataset.idx);
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => { card.draggable = false; card.classList.remove("dragging"); });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      const overIdx = Number(card.dataset.idx);
      if (dragIdx === null || overIdx === dragIdx) return;
      const [moved] = draft.items.splice(dragIdx, 1);
      draft.items.splice(overIdx, 0, moved);
      dragIdx = null;
      renderItems(el);
      el.dispatchEvent(new Event("change"));
    });
  });
}

function itemCard(it, i) {
  const label = KINDS[it.kind]?.label || it.kind;
  let body = "";
  if (HYMN_KINDS.includes(it.kind)) {
    body = `<input class="f-num" placeholder="#" inputmode="numeric" style="width:4rem" value="${esc(it.num || "")}">
            <input class="f-title" placeholder="Hymn title" style="flex:1" value="${esc(it.title || "")}">`;
  } else if (SPEAKER_KINDS.includes(it.kind)) {
    body = `<input class="f-name" placeholder="Name" style="flex:1" value="${esc(it.name || "")}">
            <input class="f-topic" placeholder="Topic (optional)" style="flex:1" value="${esc(it.topic || "")}">`;
  } else if (PRAYER_KINDS.includes(it.kind)) {
    body = `<input class="f-name" placeholder="Name" style="flex:1" value="${esc(it.name || "")}">
            <select class="f-org" style="flex:1">
              <option value="">Arranged by…</option>
              ${ORGS.map((o) => `<option value="${o}" ${it.org === o ? "selected" : ""}>${o}</option>`).join("")}
            </select>`;
  } else if (it.kind === "musical") {
    body = `<input class="f-who" placeholder="Who (person/group)" style="flex:1" value="${esc(it.who || "")}">
            <input class="f-hymn" placeholder="Hymn / piece" style="flex:1" value="${esc(it.hymn || "")}">
            <input class="f-acc" placeholder="Accompanist" style="flex:1" value="${esc(it.accompanist || "")}">`;
  } else if (it.kind === "blessing") {
    const priestSel = (cls, val) => `
      <select class="${cls}" style="flex:1">
        <option value="">— Priest —</option>
        ${priests.map((p) => `<option value="${esc(p)}" ${val === p ? "selected" : ""}>${esc(p)}</option>`).join("")}
        ${val && !priests.includes(val) ? `<option value="${esc(val)}" selected>${esc(val)}</option>` : ""}
      </select>`;
    body = priestSel("f-p1", it.priest1 || "") + priestSel("f-p2", it.priest2 || "")
      + (priests.length ? "" : `<div class="row-sub" style="width:100%">Add priests under ⚙ Settings to fill these dropdowns.</div>`);
  } else if (it.kind === "babyBlessing") {
    body = `<input class="f-name" placeholder="Baby's name" style="flex:1" value="${esc(it.name || "")}">`;
  } else if (it.kind === "custom") {
    body = `<input class="f-label" placeholder="Item name" style="flex:1" value="${esc(it.label || "")}">
            <input class="f-text" placeholder="Details" style="flex:2" value="${esc(it.text || "")}">`;
  } else if (it.kind === "wardBusiness") {
    body = `
      <div style="width:100%">
        <div class="row-sub" style="margin:.2rem 0">Sustainings
          <button class="btn btn-sm" data-act="addsus" type="button">+ Add</button></div>
        ${(it.sustainings || []).map((s, r) => `
          <div class="speaker-row">
            <input class="f-sus-name" data-row="${r}" placeholder="Name" value="${esc(s.name || "")}">
            <input class="f-sus-calling" data-row="${r}" placeholder="Calling" value="${esc(s.calling || "")}">
            <button class="btn btn-sm" data-act="delsus" data-row="${r}" type="button">✕</button>
          </div>`).join("")}
        <div class="row-sub" style="margin:.2rem 0">Releasings
          <button class="btn btn-sm" data-act="addrel" type="button">+ Add</button></div>
        ${(it.releasings || []).map((s, r) => `
          <div class="speaker-row">
            <input class="f-rel-name" data-row="${r}" placeholder="Name" value="${esc(s.name || "")}">
            <input class="f-rel-calling" data-row="${r}" placeholder="Calling" value="${esc(s.calling || "")}">
            <button class="btn btn-sm" data-act="delrel" data-row="${r}" type="button">✕</button>
          </div>`).join("")}
        <input class="f-other" placeholder="Other business (optional)" style="width:100%" value="${esc(it.other || "")}">
      </div>`;
  } else { // announcements, testimonies, sacrament, etc.
    body = `<input class="f-text" placeholder="Details (optional)" style="flex:1" value="${esc(it.text || "")}">`;
  }
  return `
    <div class="item-card" data-idx="${i}" data-kind="${it.kind}">
      <div class="item-head">
        <span class="drag-handle" title="Drag to reorder">≡</span>
        <span class="item-label">${esc(label)}</span>
        <span class="item-time"><input class="f-time" type="number" min="0" max="90" value="${esc(it.time ?? "")}" title="Allotted minutes"> min</span>
        <button class="btn btn-sm" data-act="up" type="button" title="Move up">▲</button>
        <button class="btn btn-sm" data-act="down" type="button" title="Move down">▼</button>
        <button class="btn btn-sm" data-act="del" type="button" title="Remove">✕</button>
      </div>
      <div class="item-body">${body}</div>
    </div>`;
}

// read current input values back into draft (before re-render or save)
function syncDraft(el) {
  el.querySelectorAll(".item-card").forEach((card) => {
    const it = draft.items[Number(card.dataset.idx)];
    if (!it) return;
    const v = (cls) => card.querySelector("." + cls)?.value.trim() ?? "";
    it.time = Number(card.querySelector(".f-time")?.value) || 0;
    if (HYMN_KINDS.includes(it.kind)) { it.num = v("f-num"); it.title = v("f-title"); }
    else if (SPEAKER_KINDS.includes(it.kind)) { it.name = v("f-name"); it.topic = v("f-topic"); }
    else if (PRAYER_KINDS.includes(it.kind)) { it.name = v("f-name"); it.org = card.querySelector(".f-org")?.value || ""; }
    else if (it.kind === "musical") { it.who = v("f-who"); it.hymn = v("f-hymn"); it.accompanist = v("f-acc"); }
    else if (it.kind === "blessing") { it.priest1 = card.querySelector(".f-p1")?.value || ""; it.priest2 = card.querySelector(".f-p2")?.value || ""; }
    else if (it.kind === "babyBlessing") { it.name = v("f-name"); }
    else if (it.kind === "custom") { it.label = v("f-label"); it.text = v("f-text"); }
    else if (it.kind === "wardBusiness") {
      it.sustainings = [...card.querySelectorAll(".f-sus-name")].map((inp, r) => ({
        name: inp.value.trim(),
        calling: card.querySelectorAll(".f-sus-calling")[r]?.value.trim() || "",
      })).filter((s) => s.name || s.calling);
      it.releasings = [...card.querySelectorAll(".f-rel-name")].map((inp, r) => ({
        name: inp.value.trim(),
        calling: card.querySelectorAll(".f-rel-calling")[r]?.value.trim() || "",
      })).filter((s) => s.name || s.calling);
      it.other = v("f-other");
    }
    else { it.text = v("f-text"); }
  });
}
