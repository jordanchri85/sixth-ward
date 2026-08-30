// Sacrament Meeting planner: one agenda per Sunday, keyed by date.
// The agenda is an ordered list of items (speakers, hymns, prayers, business…)
// that can be added, removed, reordered (drag or ▲▼), each with allotted minutes.
// Two views: cards (with quick status) and a spreadsheet-style table with inline editing.
import { db } from "./firebase-init.js?v=1788128283";
import { ctx, hasRole } from "./app.js?v=1788128283";
import {
  collection, onSnapshot, doc, setDoc, deleteDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc, fmtDate, todayISO } from "./ui.js?v=1788128283";
import { HYMNS } from "./hymns.js?v=1788128283";


// dates in this tab are always Sundays — no weekday prefix needed
function fmtDay(iso, opts = {}) {
  if (!iso) return "";
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
    month: "short", day: "numeric", ...(opts.year ? { year: "numeric" } : {}),
  });
}

const ORGS = ["Relief Society", "Elders Quorum", "Primary", "Young Men", "Young Women"];
// short badge labels for the card pills
const ORG_ABBR = { "Relief Society": "RS", "Elders Quorum": "EQ", "Primary": "Primary", "Young Men": "YM", "Young Women": "YW" };

const DEFAULT_BISHOPRIC = ["Bishop Christensen", "Brother Bennett", "Brother Beach"];
let bishopric = [...DEFAULT_BISHOPRIC];
let priests = [];    // ward priests, for Blessing the Sacrament dropdowns
let organists = [];  // suggestions for the Organist field
let conductors = []; // suggestions for the music Conductor field
let customHymns = []; // [{num, title}] added under ⚙ Settings, merged into the catalog
let blockedHymns = [];      // hymn numbers un-approved by the bishop: stay listed, leave the pickers
let sacramentApproved = []; // hymn numbers approved for the Sacrament Hymn slot

// ---- Hymn catalog (both hymnbooks + custom additions) ----
function hymnCatalog() {
  return HYMNS.map(([n, t]) => ({ num: String(n), title: t }))
    .concat(customHymns.map((h) => ({ num: String(h.num || ""), title: h.title || "" })));
}
function hymnTitleForNum(num) {
  const n = String(num).trim();
  return hymnCatalog().find((h) => h.num === n)?.title || "";
}
function hymnNumForTitle(title) {
  const t = String(title).trim().toLowerCase();
  return hymnCatalog().find((h) => h.title.toLowerCase() === t)?.num || "";
}
// pickers only offer approved hymns; the sacrament slot narrows further when
// a sacrament-approved set exists
function approvedCatalog() {
  const blocked = new Set(blockedHymns.map(String));
  return hymnCatalog().filter((h) => !blocked.has(h.num));
}
function sacramentCatalog() {
  const appr = approvedCatalog();
  if (!sacramentApproved.length) return appr;
  const sac = new Set(sacramentApproved.map(String));
  return appr.filter((h) => sac.has(h.num));
}
function hymnDatalists() {
  const opts = (cat, id, byTitle) => `<datalist id="${id}">${cat.map((h) =>
    byTitle ? `<option value="${esc(h.title)}" label="#${esc(h.num)}"></option>`
            : `<option value="${esc(h.num)}" label="${esc(h.title)}"></option>`).join("")}</datalist>`;
  const cat = approvedCatalog();
  const sac = sacramentCatalog();
  return opts(cat, "dl-hymn-nums") + opts(cat, "dl-hymn-titles", true)
       + opts(sac, "dl-sac-hymn-nums") + opts(sac, "dl-sac-hymn-titles", true);
}
function warnIfBlocked(num) {
  const n = String(num || "").trim();
  if (n && blockedHymns.map(String).includes(n)) {
    toast(`⚠️ Hymn #${n} is not on the approved list`);
  }
}
// pair a #-input with its title-input: picking/typing one fills the other
function wireHymnAutofill(numInput, titleInput) {
  if (!numInput || !titleInput) return;
  numInput.addEventListener("change", () => {
    const t = hymnTitleForNum(numInput.value);
    if (t) titleInput.value = t;
    warnIfBlocked(numInput.value);
  });
  titleInput.addEventListener("change", () => {
    const n = hymnNumForTitle(titleInput.value);
    if (n) numInput.value = n;
    warnIfBlocked(numInput.value);
  });
}

const MEETING_TYPES = [
  ["sacrament", "Sacrament Meeting"],
  ["fast", "Fast & Testimony Meeting"],
  ["conference", "General Conference"],
  ["stakeconf", "Stake Conference"],
  ["wardconf", "Ward Conference"],
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
  choir:            { label: "Choir" },
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
  stakeconf: "Stake Conf.", wardconf: "Ward Conf.", primary: "Primary Prog.",
  christmas: "Christmas", easter: "Easter", other: "Other",
};
// types with no ward sacrament meeting at all
const NO_MEETING = (t) => t === "conference" || t === "stakeconf";
// types where assigned speakers don't apply (washed out in the table)
const NO_SPEAKERS = (t) => t === "fast" || t === "primary";
const SPEAKER_KINDS = ["primarySpeaker", "youthSpeaker", "speaker"];
const PRAYER_KINDS = ["invocation", "benediction"];

// canonical meeting order, used when the table view adds a missing item
const CANON = ["announcements", "openingHymn", "invocation", "wardBusiness", "babyBlessing",
  "sacramentHymn", "sacrament", "blessing", "primarySpeaker", "youthSpeaker", "speaker", "musical",
  "choir", "intermediateHymn", "testimonies", "closingHymn", "benediction", "custom"];

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
  else if (SPEAKER_KINDS.includes(kind)) Object.assign(it, { name: "", topic: "", confirmed: false, confirmedBy: "" });
  else if (PRAYER_KINDS.includes(kind)) Object.assign(it, { name: "", org: "", confirmed: false, confirmedBy: "" });
  else if (kind === "musical") Object.assign(it, { who: "", hymn: "", accompanist: "", confirmed: false, confirmedBy: "" });
  else if (kind === "choir") Object.assign(it, { hymn: "", accompanist: "", confirmed: false, confirmedBy: "" });
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
        <button class="btn btn-sm" id="btn-toggle-past">Show previous Sundays</button>
        ${hasRole("bishopric") ? `<button class="btn" id="btn-edit-bishopric">⚙ Settings</button>` : ""}
      </div>
    </div>
    <div id="sunday-list"></div>`;

  panel.querySelector("#btn-edit-bishopric")?.addEventListener("click", editBishopric);
  panel.querySelector("#btn-toggle-past").addEventListener("click", () => {
    showPast = !showPast;
    render();
  });
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
      if (Array.isArray(d.organists)) organists = d.organists;
      if (Array.isArray(d.conductors)) conductors = d.conductors;
      if (Array.isArray(d.customHymns)) customHymns = d.customHymns;
      if (Array.isArray(d.blockedHymns)) blockedHymns = d.blockedHymns;
      if (Array.isArray(d.sacramentApproved)) sacramentApproved = d.sacramentApproved;
    } else if (hasRole("bishopric")) {
      await setDoc(doc(db, "settings", "leadership"), { bishopric: DEFAULT_BISHOPRIC, priests: [], organists: [], conductors: [] });
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
    <div class="mtg-sec-title" style="margin-top:1.1rem">Organists</div>
    <p class="row-sub" style="margin:0 0 .5rem">Suggested in the Organist field each week.</p>
    <div id="org-rows">${nameRows("org-name", organists)}</div>
    <button class="btn btn-sm" id="org-add" type="button">+ Add organist</button>
    <div class="mtg-sec-title" style="margin-top:1.1rem">Music Conductors</div>
    <p class="row-sub" style="margin:0 0 .5rem">Suggested in the Conductor field each week.</p>
    <div id="cond-rows">${nameRows("cond-name", conductors)}</div>
    <button class="btn btn-sm" id="cond-add" type="button">+ Add conductor</button>
    <div class="mtg-sec-title" style="margin-top:1.1rem">Custom hymns</div>
    <p class="row-sub" style="margin:0 0 .5rem">Both hymnbooks are built in. When the Church releases new hymns, add them here and they'll appear in every hymn dropdown.</p>
    <div id="ch-rows">${customHymns.map((h) => `
      <div class="speaker-row">
        <input class="ch-num" placeholder="#" inputmode="numeric" style="flex:0 0 5rem" value="${esc(h.num || "")}">
        <input class="ch-title" placeholder="Hymn title" value="${esc(h.title || "")}">
        <button class="btn btn-sm set-del" type="button">✕</button>
      </div>`).join("")}</div>
    <button class="btn btn-sm" id="ch-add" type="button">+ Add hymn</button>
    <div class="mtg-sec-title" style="margin-top:1.1rem">Hymn approvals</div>
    <p class="row-sub" style="margin:0 0 .5rem">Choose which hymns can be picked, and which are approved as sacrament hymns. (Save any changes above first — this opens a separate window.)</p>
    <button class="btn btn-sm" id="ch-manage" type="button">Manage hymn approvals…</button>
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
  el.querySelector("#org-add").addEventListener("click", () => addRow("#org-rows", "org-name"));
  el.querySelector("#cond-add").addEventListener("click", () => addRow("#cond-rows", "cond-name"));
  el.querySelector("#ch-add").addEventListener("click", () => el.querySelector("#ch-rows").insertAdjacentHTML("beforeend", `
      <div class="speaker-row">
        <input class="ch-num" placeholder="#" inputmode="numeric" style="flex:0 0 5rem">
        <input class="ch-title" placeholder="Hymn title">
        <button class="btn btn-sm set-del" type="button">✕</button>
      </div>`));
  el.querySelector("#ch-manage").addEventListener("click", () => { closeModal(); hymnApprovalModal(); });
  el.querySelector("#bp-cancel").addEventListener("click", closeModal);
  el.querySelector("#bp-save").addEventListener("click", async () => {
    const collect = (cls) => [...el.querySelectorAll("." + cls)].map((i) => i.value.trim()).filter(Boolean);
    const names = collect("bp-name");
    if (!names.length) { toast("Add at least one bishopric name"); return; }
    const priestNames = collect("pr-name");
    const organistNames = collect("org-name");
    const conductorNames = collect("cond-name");
    const hymnRows = [...el.querySelectorAll("#ch-rows .speaker-row")].map((row) => ({
      num: row.querySelector(".ch-num").value.trim(),
      title: row.querySelector(".ch-title").value.trim(),
    })).filter((h) => h.num || h.title);
    try {
      await setDoc(doc(db, "settings", "leadership"),
        { bishopric: names, priests: priestNames, organists: organistNames, conductors: conductorNames, customHymns: hymnRows });
      bishopric = names;
      priests = priestNames;
      organists = organistNames;
      conductors = conductorNames;
      customHymns = hymnRows;
      closeModal(); toast("Settings saved"); render();
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
}

// ---- Hymn approvals manager: block hymns from the pickers, mark sacrament-approved ----
function hymnApprovalModal() {
  const blocked = new Set(blockedHymns.map(String));
  const sacSet = new Set(sacramentApproved.map(String));
  const cat = hymnCatalog();

  const rowHtml = (h) => `
    <div class="ha-row${blocked.has(h.num) ? " ha-blocked" : ""}" data-num="${esc(h.num)}" data-search="${esc((h.num + " " + h.title).toLowerCase())}">
      <span class="ha-name">${esc(h.num)}. ${esc(h.title)}</span>
      <button class="chip ha-sac ${sacSet.has(h.num) ? "active" : ""}" type="button" title="Approved as a sacrament hymn">Sacrament</button>
      <button class="chip ha-appr ${blocked.has(h.num) ? "" : "active"}" type="button" title="Approved for selection">Approved</button>
    </div>`;

  const el = openModal(`
    <h3>Hymn approvals</h3>
    <p class="row-sub" style="margin:.2rem 0 .6rem">
      Un-approve a hymn to keep it listed here but out of every picker.
      Mark hymns <b>Sacrament</b> to control what's suggested for the sacrament hymn
      (if none are marked, all approved hymns are suggested).
    </p>
    <input id="ha-search" placeholder="Search by number or title…" autocomplete="off"
      style="width:100%;font:inherit;padding:.45rem .6rem;border:1px solid var(--line);border-radius:8px;margin-bottom:.5rem">
    <div class="chips" id="ha-filters" style="margin-bottom:.5rem">
      <button class="chip active" data-f="all" type="button">All</button>
      <button class="chip" data-f="sac" type="button">Sacrament</button>
      <button class="chip" data-f="blocked" type="button">Not approved</button>
    </div>
    <div id="ha-list" style="max-height:52vh;overflow-y:auto;border:1px solid var(--line);border-radius:8px;padding:.2rem .5rem">
      ${cat.map(rowHtml).join("")}
    </div>
    <div class="modal-actions">
      <div class="right">
        <button class="btn" id="ha-cancel">Cancel</button>
        <button class="btn btn-primary" id="ha-save">Save</button>
      </div>
    </div>`);
  el.classList.add("modal-wide");

  let filter = "all";
  const applyFilter = () => {
    const q = el.querySelector("#ha-search").value.trim().toLowerCase();
    el.querySelectorAll(".ha-row").forEach((row) => {
      const num = row.dataset.num;
      const matchesQ = !q || row.dataset.search.includes(q);
      const matchesF = filter === "all"
        || (filter === "sac" && sacSet.has(num))
        || (filter === "blocked" && blocked.has(num));
      row.style.display = matchesQ && matchesF ? "" : "none";
    });
  };
  el.querySelector("#ha-search").addEventListener("input", applyFilter);
  el.querySelector("#ha-filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    filter = chip.dataset.f;
    el.querySelectorAll("#ha-filters .chip").forEach((c) => c.classList.toggle("active", c === chip));
    applyFilter();
  });

  el.querySelector("#ha-list").addEventListener("click", (e) => {
    const row = e.target.closest(".ha-row");
    if (!row) return;
    const num = row.dataset.num;
    if (e.target.classList.contains("ha-sac")) {
      sacSet.has(num) ? sacSet.delete(num) : sacSet.add(num);
      e.target.classList.toggle("active", sacSet.has(num));
    } else if (e.target.classList.contains("ha-appr")) {
      blocked.has(num) ? blocked.delete(num) : blocked.add(num);
      e.target.classList.toggle("active", !blocked.has(num));
      row.classList.toggle("ha-blocked", blocked.has(num));
    }
  });

  el.querySelector("#ha-cancel").addEventListener("click", closeModal);
  el.querySelector("#ha-save").addEventListener("click", async () => {
    try {
      await setDoc(doc(db, "settings", "leadership"),
        { blockedHymns: [...blocked], sacramentApproved: [...sacSet] }, { merge: true });
      blockedHymns = [...blocked];
      sacramentApproved = [...sacSet];
      closeModal(); toast("Hymn approvals saved"); render();
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
}

// datalist suggestions for the Organist / music Conductor inputs (cards, table, editor)
function musicDatalists() {
  return `
    <datalist id="dl-organists">${organists.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
    <datalist id="dl-conductors">${conductors.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>`;
}

// ---- Sunday helpers ----
const isoOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// today if it's Sunday, otherwise the next Sunday — past Sundays never lead the page
function upcomingSunday() {
  const d = new Date();
  const dow = d.getDay();
  if (dow !== 0) d.setDate(d.getDate() + (7 - dow));
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

// small Ward Business pill for the table's Conducting cell: grey when empty,
// colored + summarized when there's content; click opens the quick editor.
function wbPillHtml(m, date, canEdit) {
  const items = itemsFor(m, date).filter((i) => i.kind === "wardBusiness");
  const susCount = items.reduce((a, b) => a + (b.sustainings?.length || 0), 0);
  const relCount = items.reduce((a, b) => a + (b.releasings?.length || 0), 0);
  const other = items.some((b) => (b.other || "").trim());
  const has = susCount || relCount || other;
  const parts = [];
  if (susCount) parts.push(`${susCount} sus`);
  if (relCount) parts.push(`${relCount} rel`);
  if (other) parts.push("other");
  const cls = has ? "wb-pill wb-has" : "wb-pill";
  const clickAttr = canEdit ? ` data-date="${date}" data-qe='{"t":"wb"}'` : "";
  return `<span class="${cls}${canEdit ? " st-click" : ""}"${clickAttr} title="Ward Business">${has ? "📋 " + parts.join(" · ") : "Ward Business"}</span>`;
}

// same idea for announcements: grey when none, colored + summarized when present
function annPillHtml(m, date, canEdit) {
  const text = itemsFor(m, date).find((i) => i.kind === "announcements")?.text || "";
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  const has = lines.length > 0;
  const cls = has ? "wb-pill ann-has" : "wb-pill";
  const clickAttr = canEdit ? ` data-date="${date}" data-qe='{"t":"announce"}'` : "";
  const title = has ? esc(lines.map((l) => "• " + l).join("\n").slice(0, 160)) : "Announcements";
  return `<span class="${cls}${canEdit ? " st-click" : ""}"${clickAttr} title="${title}">${has ? `📣 ${lines.length} announcement${lines.length > 1 ? "s" : ""}` : "Announcements"}</span>`;
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
  // no name -> grey/red (unassigned); name but not confirmed -> yellow "pending";
  // name + confirmed -> green with a checkmark and a "confirmed by" tooltip.
  // qe -> pill is clickable for quick inline assignment
  const chip = (label, name, qe, confirmed, confirmedBy, org, sub, confirmTarget) => {
    const hasName = !!name;
    const cls = !hasName ? (planned ? "st-miss" : "st-off") : confirmed ? "st-ok" : "st-pending";
    const clickable = qe && can;
    const title = hasName && confirmed && confirmedBy ? `Confirmed by ${confirmedBy}` : clickable ? "Click to assign" : "";
    // pending: an outline circle that confirms on the spot (bishopric only);
    // clicking anywhere else on the pill still opens the editor
    const iconHtml = hasName && confirmed
      ? `<span class="st-icon">✓</span>`
      : hasName && can && confirmTarget
      ? `<span class="st-icon st-confirm-dot" data-confirm='${JSON.stringify(confirmTarget)}' title="Click to mark confirmed">○</span>`
      : `<span class="st-icon">○</span>`;
    const orgBadge = org ? `<span class="st-org org-${org.toLowerCase().replace(/[^a-z]+/g, "-")}" title="${esc(org)}">${esc(ORG_ABBR[org] || org)}</span>` : "";
    const subLine = hasName && sub ? `<span class="st-sub">${esc(sub)}</span>` : "";
    // icon rides with the name (not the headline) so the title centers cleanly
    return `<span class="st ${cls}${clickable ? " st-click" : ""}"${clickable ? ` data-qe='${JSON.stringify(qe)}'` : ""}${title ? ` title="${esc(title)}"` : ""}><span class="st-head">${label}</span>${hasName ? `<span class="st-name">${iconHtml} ${esc(name)}</span>` : ""}${subLine}${orgBadge}</span>`;
  };

  // Hymns pill counts only actual hymn slots; the musical/choir slot gets its own pill
  // Hymns pill = only the fixed hymns; the intermediate slot is its own pill
  const hymnItems = items.filter((i) => HYMN_KINDS.includes(i.kind) && i.kind !== "intermediateHymn");
  const slotInterHymn = items.find((i) => i.kind === "intermediateHymn");
  const slotMusical = items.find((i) => i.kind === "musical");
  const slotChoir = items.find((i) => i.kind === "choir");
  const inv = of("invocation")[0];
  const ben = of("benediction")[0];

  // combined pill: a headline plus one line per slot, each line with its own
  // click-to-confirm dot. Green when every slot is named AND confirmed,
  // yellow once anything is named, red/grey when empty.
  const groupChip = (label, qe, lines, subhead, footer) => {
    // lines marked "none" (no speaker planned this week) don't count as
    // missing: a pill of all-none goes grey, and the rest can still go green
    const real = lines.filter((l) => !l.none);
    const named = real.filter((l) => l.name);
    const allDone = real.length > 0 && named.length === real.length && real.every((l) => l.confirmed);
    const cls = real.length === 0
      ? "st-off"
      : named.length === 0 ? (planned ? "st-miss" : "st-off") : allDone ? "st-ok" : "st-pending";
    const body = lines.map((l) => {
      if (l.none) {
        const editAttr = l.inlineEdit && can ? ` data-ed='${JSON.stringify(l.inlineEdit)}' title="Click to type here"` : "";
        return `<span class="st-line"${editAttr}><span class="st-li-ic"></span><span class="st-li-tag">${esc(l.tag)}:</span> <span class="st-li-name st-none">none</span></span>`;
      }
      // "light" lines (hymns) skip the icon column entirely — left-flush
      // tags and wrapping names buy room for long hymn titles
      const dot = l.light
        ? ""
        : l.name && l.confirmed
        ? `<span class="st-li-ic" title="${l.confirmedBy ? "Confirmed by " + esc(l.confirmedBy) : "Confirmed"}">✓</span>`
        : l.name && can
        ? `<span class="st-li-ic st-confirm-dot" data-confirm='${JSON.stringify({ k: l.k, o: l.o })}' title="Click to mark confirmed">○</span>`
        : `<span class="st-li-ic"></span>`;
      const orgTag = l.org ? ` <span class="st-li-org">${esc(ORG_ABBR[l.org] || l.org)}</span>` : "";
      // inlineEdit lines edit in place on click instead of opening the popup
      const editAttr = l.inlineEdit && can ? ` data-ed='${JSON.stringify(l.inlineEdit)}' title="Click to type here"` : "";
      return `<span class="st-line${l.light ? " st-line-light" : ""}"${editAttr}>${dot}<span class="st-li-tag">${esc(l.tag)}:</span> <span class="st-li-name${l.light ? " st-li-light" : ""}">${l.name ? esc(l.name) : "—"}</span>${orgTag}</span>`;
    }).join("");
    // no icon in the headline — the title stays cleanly centered; state
    // lives in the pill color and the per-line marks
    const sh = subhead ? (typeof subhead === "string" ? { html: subhead, attrs: "" } : subhead) : null;
    const shHtml = sh ? `<span class="st-subhead"${sh.attrs}>${sh.html}</span>` : "";
    return `<span class="st st-group ${cls}${can ? " st-click" : ""}"${can ? ` data-qe='${JSON.stringify(qe)}' title="Click to edit"` : ""}><span class="st-head">${label}</span>${shHtml}${body}${footer || ""}</span>`;
  };

  const spkLines = (kind, tagFn) => of(kind).map((it, i) => ({
    tag: tagFn(it, i), name: it.name, confirmed: it.confirmed, confirmedBy: it.confirmedBy, k: kind, o: i,
    none: !!it.none,
    inlineEdit: { t: "name", k: kind, o: i },
  }));
  const adultSpk = of("speaker");

  // hymn lines: a filled hymn counts as "confirmed" so the line gets a ✓
  // and the pill turns green once all three are chosen
  const HYMN_TAGS = { openingHymn: "Open", sacramentHymn: "Sacrament", closingHymn: "Closing" };
  const chips = [
    groupChip("Prayers", { t: "prayers" }, [
      { tag: "Open", name: inv?.name, org: inv?.org, confirmed: inv?.confirmed, confirmedBy: inv?.confirmedBy, k: "invocation", o: 0, inlineEdit: { t: "name", k: "invocation", o: 0 } },
      { tag: "Closing", name: ben?.name, org: ben?.org, confirmed: ben?.confirmed, confirmedBy: ben?.confirmedBy, k: "benediction", o: 0, inlineEdit: { t: "name", k: "benediction", o: 0 } },
    ]),
    groupChip("Hymns", { t: "h" }, hymnItems.map((h) => ({
      tag: HYMN_TAGS[h.kind] || KINDS[h.kind]?.label || h.kind,
      name: [h.num ? "#" + h.num : "", h.title].filter(Boolean).join(" | "),
      confirmed: !!(h.num || h.title),
      light: true, // hymn titles stay unbolded so more of the name fits
      inlineEdit: { t: "hymn", k: h.kind, o: 0 },
    })), {
      html: `Organ: ${esc(m?.organist || "—")} · Conduct: ${esc(m?.chorister || "—")}`,
      attrs: can ? ` data-musiced title="Click to set organist & conductor"` : "",
    }),
  ];

  // Intermediate slot: its own pill right after Hymns, with its own editor
  // (Hymn / Special Musical # / Choir toggle lives there).
  // where the music number sits relative to the adult speakers (small subtext)
  const slotPos = (() => {
    const slotIdx = items.findIndex((i) => ["intermediateHymn", "musical", "choir"].includes(i.kind));
    const spkIdxs = items.map((it, i) => (it.kind === "speaker" ? i : -1)).filter((i) => i >= 0);
    if (slotIdx < 0 || !spkIdxs.length) return "";
    const before = spkIdxs.filter((i) => i < slotIdx).length;
    return before === 0 ? "before the speakers" : `after speaker ${before}`;
  })();
  if (slotMusical) {
    chips.push(chip("Music Number", slotMusical.who, { t: "inter" }, slotMusical.confirmed, slotMusical.confirmedBy, null, [slotMusical.hymn, slotPos].filter(Boolean).join(" · "), { k: "musical", o: 0 }));
  } else if (slotChoir) {
    chips.push(chip("Music Number", "Choir", { t: "inter" }, slotChoir.confirmed, slotChoir.confirmedBy, null, [slotChoir.hymn, slotPos].filter(Boolean).join(" · "), { k: "choir", o: 0 }));
  } else if (slotInterHymn) {
    const hymnVal = [slotInterHymn.num ? "#" + slotInterHymn.num : "", slotInterHymn.title].filter(Boolean).join(" | ");
    chips.push(chip("Music Number", hymnVal, { t: "inter" }, true, null, null, slotPos));
  } else if (type !== "fast") {
    // Fast & Testimony has no intermediate slot — skip the empty pill there
    chips.push(`<span class="st st-off${can ? " st-click" : ""}"${can ? ` data-qe='{"t":"inter"}' title="Click to add"` : ""}><span class="st-head">Music Number</span></span>`);
  }

  // Youth pill = primary + youth speakers; Speakers pill = the adult speakers.
  const prim = of("primarySpeaker"), yth = of("youthSpeaker");
  const youthLines = [
    ...spkLines("primarySpeaker", (it, i) => prim.length > 1 ? `Primary ${i + 1}` : "Primary"),
    ...spkLines("youthSpeaker", (it, i) => yth.length > 1 ? `Youth ${i + 1}` : "Youth"),
  ];
  if (youthLines.length) chips.push(groupChip("Youth Speakers", { t: "py" }, youthLines));
  if (adultSpk.length) {
    // "+" under the last speaker line: opens the editor with a fresh row ready
    const addBtn = can ? `<span class="st-add" data-qe='${JSON.stringify({ t: "spk", k: "speaker", add: 1 })}' title="Add another speaker">+</span>` : "";
    chips.push(groupChip("Speakers", { t: "spk", k: "speaker" },
      spkLines("speaker", (it, i) => String(i + 1)), null, addBtn));
  }

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
  const pastBtn = document.getElementById("btn-toggle-past");
  if (pastBtn) {
    pastBtn.textContent = showPast ? "Hide previous Sundays" : "Show previous Sundays";
    // shown in every year view (even where no Sundays are past yet) so the
    // control sits in a consistent spot
    pastBtn.style.display = "";
  }
  if (viewMode === "table") renderTable(wrap);
  else renderCards(wrap);
}

// rest of the current year (or the whole year if showPast is on); the whole year for other years
function viewDates() {
  const thisYear = new Date().getFullYear();
  const fromDate = viewYear === thisYear && !showPast ? upcomingSunday() : null;
  return sundaysOfYear(viewYear, fromDate);
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
    const babies = planned ? (m.items || []).filter((i) => i.kind === "babyBlessing") : [];
    const announceText = planned ? (m.items || []).find((i) => i.kind === "announcements")?.text || "" : "";
    const megaphone = canEdit && !isConf ? `
      <button class="megaphone-btn${announceText ? " has-announce" : ""}" data-qe='{"t":"announce"}' title="${announceText ? esc(announceText.split("\n").filter(Boolean).map((l) => "• " + l).join("\n").slice(0, 160)) : "Add announcements"}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 5 6 9H3v6h3l5 4V5z"/>
          <path d="M15.5 8.5a4 4 0 0 1 0 7"/>
          <path d="M18.5 6a7.5 7.5 0 0 1 0 12"/>
        </svg>
      </button>` : "";
    // Ward Business: small clipboard icon beside the megaphone — grey when
    // empty, green when there's business. Bishopric edits; members view.
    const wbItems = planned ? (m.items || []).filter((i) => i.kind === "wardBusiness") : [];
    const wbSus = wbItems.reduce((a, b) => a + (b.sustainings?.length || 0), 0);
    const wbRel = wbItems.reduce((a, b) => a + (b.releasings?.length || 0), 0);
    const wbHas = wbSus || wbRel || wbItems.some((b) => (b.other || "").trim());
    const wbParts = [];
    if (wbSus) wbParts.push(`${wbSus} sustain`);
    if (wbRel) wbParts.push(`${wbRel} release`);
    if (wbItems.some((b) => (b.other || "").trim())) wbParts.push("other");
    const wbIcon = !isConf && (canEdit || wbHas) ? `
      <button class="megaphone-btn${wbHas ? " has-wb" : ""}" data-wbicon="${date}" title="${wbHas ? "Ward Business: " + esc(wbParts.join(" · ")) : "Add ward business"}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="8" y="2" width="8" height="4" rx="1"/>
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <path d="M9 12h6M9 16h6"/>
        </svg>
      </button>` : "";
    // conducting is assigned or not — no confirmation step
    // plain text, no pill color — assigned reads quietly on the date line
    const condChip = isConf ? "" : `
      <span class="cond-inline${m?.conducting ? "" : " cond-empty"}${canEdit ? " st-click" : ""}"${canEdit ? ` data-qe='{"t":"c"}' title="Click to assign"` : ""}>Conducting: ${m?.conducting ? esc(m.conducting) : "—"}</span>`;
    return `
    <div class="card ${isConf ? "conf-card" : ""}" data-date="${date}" style="${isPast ? "opacity:.6" : ""}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.75rem;flex-wrap:wrap">
        <div>
          <h3 style="margin:0"><span class="card-date">${fmtDay(date, { year: true })}</span>
            ${m?.theme ? `<span class="theme-tag">“${esc(m.theme)}”</span>` : ""}
            ${megaphone}${wbIcon}${type !== "sacrament" ? `<span class="pill head-pill ${isConf ? "pill-conf" : type === "fast" ? "pill-fast" : "pill-approved"}">${esc(typeLabel(m, date))}</span>` : ""}${nth === 5 ? `<span class="nth-pill nth-5 head-pill">5th Sunday</span>` : ""}${babies.map((b) => `<span class="pill-baby-bold head-pill">Blessing${b.name ? ": " + esc(b.name) : ""}</span>`).join("")}
          </h3>
          <div class="row-sub" style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">${condChip}${isConf ? "<span>no sacrament meeting</span>" : ""}</div>
        </div>
        <div style="display:flex;gap:.4rem">
          ${planned || isConf ? `<button class="btn btn-sm" data-view="${date}">View</button>` : ""}
          ${canEdit && !isConf ? `<button class="btn btn-sm" data-addbaby="${date}">+ Baby</button>` : ""}
          ${canEdit ? `<button class="btn btn-sm" data-edit="${date}">${planned ? "Edit" : "Plan"}</button>` : ""}
        </div>
      </div>
      ${statusChips(m, date)}
    </div>`;
  }).join("") + musicDatalists() + hymnDatalists();

  wrap.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); editMeeting(b.dataset.edit); }));
  wrap.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); viewMeeting(b.dataset.view); }));
  wrap.querySelectorAll("[data-wbicon]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (canEdit) quickEdit(el.dataset.wbicon, { t: "wb" });
      else wbModal(el.dataset.wbicon);
    }));
  wrap.querySelectorAll("[data-addbaby]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); quickAddBaby(b.dataset.addbaby); }));
  wrap.querySelectorAll("[data-qe]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      quickEdit(el.closest("[data-date]").dataset.date, JSON.parse(el.dataset.qe));
    }));
  // pending outline circle: one click marks the item confirmed, no popup
  wrap.querySelectorAll("[data-confirm]").forEach((el) =>
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { k, o } = JSON.parse(el.dataset.confirm);
      const date = el.closest("[data-date]").dataset.date;
      await patchMeeting(date, (m) => {
        const it = nthItem(m.items, k, o);
        if (it && (it.name || it.who || k === "choir")) {
          it.confirmed = true;
          it.confirmedBy = ctx.name;
        }
      });
    }));
  // pill lines edit in place: click swaps the line for inputs (hymn lines get
  // the #/title pair with datalist autofill; prayer/speaker lines a name box);
  // Enter or clicking away saves, Esc cancels
  const wireInline = (line, inputs, commitFn) => {
    let done = false;
    const commit = () => { if (done) return; done = true; commitFn(); };
    inputs.forEach((inp) => {
      inp.addEventListener("click", (ev) => ev.stopPropagation());
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        if (ev.key === "Escape") { ev.preventDefault(); done = true; render(); }
      });
    });
    // save once focus leaves the line (delayed so tabbing between inputs survives)
    line.addEventListener("focusout", () => {
      setTimeout(() => { if (!done && !line.contains(document.activeElement)) commit(); }, 120);
    });
  };
  wrap.querySelectorAll("[data-ed]").forEach((line) =>
    line.addEventListener("click", (e) => {
      e.stopPropagation();
      if (line.querySelector("input")) return; // already editing
      const ed = JSON.parse(line.dataset.ed);
      const { k, o } = ed;
      const date = line.closest("[data-date]").dataset.date;
      const it = nthItem(itemsFor(meetings[date], date), k, o);
      const tagHtml = line.querySelector(".st-li-tag")?.outerHTML || "";
      if (ed.t === "hymn") {
        const sac = k === "sacramentHymn";
        line.innerHTML = `${tagHtml}
          <input class="hymn-num st-in-num" list="${sac ? "dl-sac-hymn-nums" : "dl-hymn-nums"}" placeholder="#" inputmode="numeric" autocomplete="off" value="${esc(it?.num || "")}">
          <input class="hymn-title st-in-title" list="${sac ? "dl-sac-hymn-titles" : "dl-hymn-titles"}" placeholder="Hymn title" autocomplete="off" value="${esc(it?.title || "")}">`;
        const numIn = line.querySelector(".hymn-num"), titleIn = line.querySelector(".hymn-title");
        wireHymnAutofill(numIn, titleIn);
        numIn.focus();
        wireInline(line, [numIn, titleIn], () => patchMeeting(date, (mm) => {
          let t = nthItem(mm.items, k, o);
          if (!t) { t = blankItem(k, 3); insertCanonical(mm.items, t); }
          t.num = numIn.value.trim();
          t.title = titleIn.value.trim();
        }));
      } else {
        // name line (prayers / youth / speakers)
        line.innerHTML = `${tagHtml} <input class="st-in-title" autocomplete="off" placeholder="Name" value="${esc(it?.name || "")}">`;
        const nameIn = line.querySelector("input");
        nameIn.focus();
        wireInline(line, [nameIn], () => patchMeeting(date, (mm) => {
          let t = nthItem(mm.items, k, o);
          if (!t) { t = blankItem(k); insertCanonical(mm.items, t); }
          const newName = nameIn.value.trim();
          if (newName !== (it?.name || "")) { t.confirmed = false; t.confirmedBy = ""; } // a different person isn't confirmed yet
          if (newName) t.none = false; // typing a name overrides a "none this week" mark
          t.name = newName;
        }));
      }
    }));
  // organist / conductor edit in place on the Hymns subhead: settings lists
  // feed the dropdowns (datalists), custom names can be typed freely
  wrap.querySelectorAll("[data-musiced]").forEach((sh) =>
    sh.addEventListener("click", (e) => {
      e.stopPropagation();
      if (sh.querySelector("input")) return;
      const date = sh.closest("[data-date]").dataset.date;
      const m = meetings[date];
      sh.classList.add("st-sh-editing");
      sh.innerHTML = `
        <span class="st-music-row">Organ: <input class="st-in-title" list="dl-organists" autocomplete="off" placeholder="Name" value="${esc(m?.organist || "")}"></span>
        <span class="st-music-row">Conduct: <input class="st-in-title" list="dl-conductors" autocomplete="off" placeholder="Name" value="${esc(m?.chorister || "")}"></span>`;
      const [orgIn, condIn] = sh.querySelectorAll("input");
      orgIn.focus();
      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        patchMeeting(date, (mm) => {
          mm.organist = orgIn.value.trim();
          mm.chorister = condIn.value.trim();
        });
      };
      [orgIn, condIn].forEach((inp) => {
        inp.addEventListener("click", (ev) => ev.stopPropagation());
        inp.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); commit(); }
          if (ev.key === "Escape") { ev.preventDefault(); done = true; render(); }
        });
      });
      sh.addEventListener("focusout", () => {
        setTimeout(() => { if (!done && !sh.contains(document.activeElement)) commit(); }, 120);
      });
    }));
}

// quick "+ Baby" button: always adds a NEW baby blessing item (a Sunday can have more than one)
function quickAddBaby(date) {
  const el = openModal(`
    <h3>Add Baby Blessing <span class="row-sub">· ${fmtDay(date, { year: true })}</span></h3>
    <label class="field">Baby's name <input id="qe-baby-name" placeholder="Baby's name"></label>
    <div class="modal-actions">
      <div class="right">
        <button class="btn" id="qe-cancel">Cancel</button>
        <button class="btn btn-primary" id="qe-save">Add</button>
      </div>
    </div>`);
  el.querySelector("#qe-cancel").addEventListener("click", closeModal);
  el.querySelector("#qe-save").addEventListener("click", async () => {
    const name = el.querySelector("#qe-baby-name").value.trim();
    await patchMeeting(date, (m) => {
      insertCanonical(m.items, { kind: "babyBlessing", time: 3, name });
    });
    closeModal();
  });
  el.querySelector("input").focus();
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
  const dateLabel = `<span class="row-sub">· ${fmtDay(date, { year: true })}</span>`;

  const orgSel = (id, val) => `
    <select id="${id}"><option value="">Arranged by…</option>
      ${ORGS.map((o) => `<option value="${o}" ${val === o ? "selected" : ""}>${o}</option>`).join("")}
    </select>`;

  let html = "", onSave = null;

  const confirmField = (checked, byLine) => `
    <label class="field confirm-field" style="margin-top:.9rem">
      <span><input type="checkbox" id="qe-confirmed" ${checked ? "checked" : ""}> Confirmed</span>
      ${byLine ? `<span class="row-sub confirm-by">${esc(byLine)}</span>` : ""}
    </label>`;

  if (q.t === "c") {
    // conducting needs no confirmation step — assigned is assigned
    html = `<h3>Conducting ${dateLabel}</h3>
      <label class="field">Conducting ${personSelect("qe-cond", cur?.conducting || "")}</label>`;
    onSave = (el) => {
      const val = readPersonSelect(el, "qe-cond");
      return (m) => { m.conducting = val; };
    };
  } else if (q.t === "h") {
    // just the three fixed hymns; the intermediate slot has its own pill/editor
    const hymnRows = [];
    const occ = {};
    items.forEach((it) => {
      if (!HYMN_KINDS.includes(it.kind) || it.kind === "intermediateHymn") return;
      const o = occ[it.kind] ?? 0;
      occ[it.kind] = o + 1;
      hymnRows.push({ kind: it.kind, o, num: it.num || "", title: it.title || "" });
    });
    html = `<h3>Hymns ${dateLabel}</h3>
      ${hymnRows.map((h, i) => `
        <label class="field" style="margin-bottom:.6rem">${KINDS[h.kind].label}
          <div style="display:flex;gap:.4rem">
            <input id="qe-num-${i}" class="hymn-num" list="${h.kind === "sacramentHymn" ? "dl-sac-hymn-nums" : "dl-hymn-nums"}" placeholder="#" inputmode="numeric" autocomplete="off" style="width:4.5rem" value="${esc(h.num)}">
            <input id="qe-title-${i}" class="hymn-title" list="${h.kind === "sacramentHymn" ? "dl-sac-hymn-titles" : "dl-hymn-titles"}" placeholder="Hymn title" autocomplete="off" style="flex:1" value="${esc(h.title)}">
          </div>
        </label>`).join("")}
      ${hymnDatalists()}`;
    onSave = (el) => {
      const vals = hymnRows.map((h, i) => ({
        kind: h.kind, o: h.o,
        num: el.querySelector(`#qe-num-${i}`).value.trim(),
        title: el.querySelector(`#qe-title-${i}`).value.trim(),
      }));
      return (m) => {
        vals.forEach((v) => {
          let it = nthItem(m.items, v.kind, v.o);
          if (!it) { it = blankItem(v.kind, 3); insertCanonical(m.items, it); }
          it.num = v.num; it.title = v.title;
        });
      };
    };
  } else if (q.t === "inter") {
    // the intermediate slot: a hymn, a special musical number, or the choir
    const interHymn = items.find((i) => i.kind === "intermediateHymn");
    const interMusical = items.find((i) => i.kind === "musical");
    const interChoir = items.find((i) => i.kind === "choir");
    const interMode = interChoir ? "choir" : interMusical ? "musical" : "hymn";
    const modeBtn = (mode, label) =>
      `<button class="chip ${interMode === mode ? "active" : ""}" data-inter-mode="${mode}" type="button">${label}</button>`;
    // where the number lands in the meeting, relative to the adult speakers
    const SLOT_KINDS_POS = ["intermediateHymn", "musical", "choir"];
    const spkIdxs = items.map((it, i) => (it.kind === "speaker" ? i : -1)).filter((i) => i >= 0);
    const slotIdx = items.findIndex((i) => SLOT_KINDS_POS.includes(i.kind));
    const spkNames = items.filter((i) => i.kind === "speaker").map((s) => s.name);
    let curPos = "spk:0";
    if (slotIdx >= 0 && spkIdxs.length) {
      const before = spkIdxs.filter((i) => i < slotIdx).length;
      curPos = before === 0 ? "start" : `spk:${before - 1}`;
    }
    const posSel = spkIdxs.length ? `
      <label class="field" style="margin:.6rem 0 .2rem">Position in the meeting
        <select id="qe-inter-pos">
          <option value="start" ${curPos === "start" ? "selected" : ""}>Before the speakers</option>
          ${spkNames.map((n, i) => `<option value="spk:${i}" ${curPos === `spk:${i}` ? "selected" : ""}>After speaker ${i + 1}${n ? ` (${esc(n)})` : ""}</option>`).join("")}
        </select>
      </label>` : "";
    html = `<h3>Intermediate ${dateLabel}</h3>
      <div class="chips" style="margin:.3rem 0 .6rem">
        ${modeBtn("hymn", "Hymn")}${modeBtn("musical", "Special Musical #")}${modeBtn("choir", "Choir")}
      </div>
      <div id="qe-inter-hymn-fields" style="display:${interMode === "hymn" ? "flex" : "none"};gap:.4rem">
        <input id="qe-inter-num" class="hymn-num" list="dl-hymn-nums" placeholder="#" inputmode="numeric" autocomplete="off" style="width:4.5rem" value="${esc(interHymn?.num || "")}">
        <input id="qe-inter-title" class="hymn-title" list="dl-hymn-titles" placeholder="Hymn title" autocomplete="off" style="flex:1" value="${esc(interHymn?.title || "")}">
      </div>
      <div id="qe-inter-musical-fields" style="display:${interMode === "musical" ? "block" : "none"}">
        <label class="field" style="margin-bottom:.4rem">Hymn name
          <input id="qe-inter-piece" autocomplete="off" value="${esc(interMusical?.hymn || "")}">
        </label>
        <label class="field" style="margin-bottom:.4rem">Participants
          <input id="qe-inter-who" autocomplete="off" value="${esc(interMusical?.who || "")}">
        </label>
        <label class="field">Accompanist
          <input id="qe-inter-acc" autocomplete="off" value="${esc(interMusical?.accompanist || "")}">
        </label>
      </div>
      <div id="qe-inter-choir-fields" style="display:${interMode === "choir" ? "block" : "none"}">
        <label class="field">Hymn name
          <input id="qe-inter-choir-piece" autocomplete="off" value="${esc(interChoir?.hymn || "")}">
        </label>
      </div>
      ${posSel}
      ${hymnDatalists()}`;
    onSave = (el) => {
      const nowMode = el.querySelector("[data-inter-mode].active")?.dataset.interMode || "hymn";
      const posVal = el.querySelector("#qe-inter-pos")?.value || "";
      const interVal = nowMode === "musical"
        ? { who: el.querySelector("#qe-inter-who").value.trim(), hymn: el.querySelector("#qe-inter-piece").value.trim(), accompanist: el.querySelector("#qe-inter-acc").value.trim() }
        : nowMode === "choir"
        ? { hymn: el.querySelector("#qe-inter-choir-piece").value.trim() }
        : { num: el.querySelector("#qe-inter-num").value.trim(), title: el.querySelector("#qe-inter-title").value.trim() };
      return (m) => {
        // swap the intermediate slot between an intermediateHymn / musical / choir item
        const SLOT_KINDS = ["intermediateHymn", "musical", "choir"];
        const targetKind = nowMode === "hymn" ? "intermediateHymn" : nowMode;
        const firstSlot = m.items.find((i) => SLOT_KINDS.includes(i.kind));
        const time = firstSlot ? firstSlot.time : 3;
        // drop any slot items of a different kind so the swap never leaves duplicates
        m.items = m.items.filter((i) => !SLOT_KINDS.includes(i.kind) || i.kind === targetKind);
        const existing = m.items.find((i) => i.kind === targetKind);
        if (existing) {
          Object.assign(existing, interVal);
        } else {
          const base = targetKind === "intermediateHymn" ? {} : { confirmed: false, confirmedBy: "" };
          insertCanonical(m.items, { kind: targetKind, time, ...base, ...interVal });
        }
        // reposition relative to the adult speakers per the Position select
        if (posVal) {
          const slot = m.items.find((i) => i.kind === targetKind);
          m.items = m.items.filter((i) => i !== slot);
          const spks = m.items.filter((i) => i.kind === "speaker");
          let at = -1;
          if (posVal === "start" && spks[0]) at = m.items.indexOf(spks[0]);
          else if (posVal.startsWith("spk:")) {
            const anchor = spks[Math.min(Number(posVal.slice(4)), spks.length - 1)];
            if (anchor) at = m.items.indexOf(anchor) + 1;
          }
          if (at < 0) insertCanonical(m.items, slot);
          else m.items.splice(at, 0, slot);
        }
      };
    };
  } else if (q.t === "prayers") {
    // combined editor for the opening + closing prayers
    const inv = nthItem(items, "invocation", 0);
    const ben = nthItem(items, "benediction", 0);
    const sect = (id, label, it) => `
      <div class="qe-prayer-sect" data-pid="${id}">
        <div class="row-sub qe-prayer-head" draggable="true" title="Drag onto the other prayer to swap them" style="margin:.7rem 0 .25rem;font-weight:700"><span class="spk-drag">⠿</span> ${label}</div>
        <label class="field">Name <input id="qe-${id}-name" value="${esc(it?.name || "")}"></label>
        <label class="field" style="margin-top:.4rem">Arranged by ${orgSel(`qe-${id}-org`, it?.org || "")}</label>
        <label class="field confirm-field" style="margin-top:.4rem">
          <span><input type="checkbox" id="qe-${id}-conf" ${it?.confirmed ? "checked" : ""}> Confirmed</span>
          ${it?.confirmed && it?.confirmedBy ? `<span class="row-sub confirm-by">Confirmed by ${esc(it.confirmedBy)}</span>` : ""}
        </label>
      </div>`;
    html = `<h3>Prayers ${dateLabel}</h3>
      ${sect("inv", "Opening prayer", inv)}
      ${sect("ben", "Closing prayer", ben)}`;
    onSave = (el) => {
      const read = (id) => ({
        name: el.querySelector(`#qe-${id}-name`).value.trim(),
        org: el.querySelector(`#qe-${id}-org`).value,
        confirmed: el.querySelector(`#qe-${id}-conf`).checked,
      });
      const vals = [["invocation", read("inv"), inv], ["benediction", read("ben"), ben]];
      return (m) => {
        vals.forEach(([kind, v, prev]) => {
          const t = ensureQE(m, { k: kind, o: 0 });
          t.name = v.name; t.org = v.org;
          t.confirmed = v.confirmed;
          t.confirmedBy = v.confirmed ? (prev?.confirmed ? prev.confirmedBy : ctx.name) : "";
        });
      };
    };
  } else if (q.t === "spk" || q.t === "py") {
    // group editor for one or more speaker kinds: edit, confirm, add, remove slots.
    // "spk" edits a single kind (adult speakers); "py" edits the Youth pill's
    // two kinds (primary + youth speakers) in one modal.
    const kinds = q.t === "py" ? ["primarySpeaker", "youthSpeaker"] : [q.k];
    const title = q.t === "py" ? "Youth" : `${KINDS[q.k].label}s`;
    const rowHtml = (s) => `
      <div class="spk-row" style="display:flex;gap:.4rem;align-items:center;margin-bottom:.35rem">
        <span class="spk-drag" title="Drag to reorder">⠿</span>
        <input class="spk-name" placeholder="Name" autocomplete="off" style="flex:1" value="${esc(s.name || "")}">
        <input class="spk-topic" placeholder="Topic (optional)" autocomplete="off" style="flex:1" value="${esc(s.topic || "")}">
        <label style="display:flex;align-items:center;gap:.25rem;font-size:.78rem;white-space:nowrap">
          <input type="checkbox" class="spk-conf" ${s.confirmed ? "checked" : ""}> Confirmed</label>
        <button class="btn btn-sm spk-del" type="button" title="Remove this speaker slot">✕</button>
      </div>`;
    const sectHtml = (kind) => {
      const label = KINDS[kind].label;
      const list = items.filter((i) => i.kind === kind).map((s) => ({ ...s }));
      const noneMarked = list.some((s) => s.none);
      const rowsList = list.filter((s) => !s.none);
      // single-kind editor seeds a blank row; the combined Youth editor leaves
      // empty kinds empty so saving doesn't invent unassigned slots
      if (!rowsList.length && q.t === "spk") rowsList.push({ name: "", topic: "", confirmed: false, confirmedBy: "" });
      // Youth kinds can be marked "none this Sunday" — pill shows a grey "none"
      const noneBox = q.t === "py" ? `
        <label style="display:flex;align-items:center;gap:.3rem;font-size:.78rem;margin:.1rem 0 .35rem">
          <input type="checkbox" class="spk-none" data-kind="${kind}" ${noneMarked ? "checked" : ""}> No ${label.toLowerCase()} this Sunday</label>` : "";
      return `
        ${kinds.length > 1 ? `<div class="row-sub" style="margin:.7rem 0 .25rem;font-weight:700">${label}s</div>` : ""}
        ${noneBox}
        <div class="qe-spk-rows" data-kind="${kind}" style="${noneMarked ? "display:none" : ""}">${rowsList.map(rowHtml).join("")}</div>
        <button class="btn btn-sm" data-spkadd="${kind}" type="button" style="${noneMarked ? "display:none" : ""}">+ Add ${label.toLowerCase()}</button>`;
    };
    html = `<h3>${title} ${dateLabel}</h3>
      <p class="row-sub" style="margin:.2rem 0 .4rem">✕ removes a slot entirely; leave the name blank to keep an unassigned slot.</p>
      ${kinds.map(sectHtml).join("")}`;
    onSave = (el) => {
      const byKind = kinds.map((kind) => ({
        kind,
        none: !!el.querySelector(`.spk-none[data-kind="${kind}"]`)?.checked,
        rows: [...el.querySelectorAll(`.qe-spk-rows[data-kind="${kind}"] .spk-row`)].map((r) => ({
          name: r.querySelector(".spk-name").value.trim(),
          topic: r.querySelector(".spk-topic").value.trim(),
          confirmed: r.querySelector(".spk-conf").checked,
        })),
      }));
      return (m) => {
        byKind.forEach(({ kind, rows, none }) => {
          if (none) {
            // "no speaker this Sunday": one flag item replaces the kind's slots
            m.items = m.items.filter((i) => i.kind !== kind);
            const it = blankItem(kind);
            it.none = true;
            insertCanonical(m.items, it);
            return;
          }
          m.items = m.items.filter((i) => !(i.kind === kind && i.none));
          const existing = m.items.filter((i) => i.kind === kind);
          let used = 0; // rows consumed against existing slots
          rows.forEach((r) => {
            let it = existing[used];
            if (!it) {
              // a brand-new row only becomes a slot if something was entered —
              // opening via "+" and saving untouched must not add ghost slots
              if (!r.name && !r.topic && !r.confirmed) return;
              it = blankItem(kind); insertCanonical(m.items, it);
            }
            used++;
            const wasConfirmed = it.confirmed;
            it.none = false;
            it.name = r.name; it.topic = r.topic;
            it.confirmed = r.confirmed;
            it.confirmedBy = r.confirmed ? (wasConfirmed ? it.confirmedBy : ctx.name) : "";
          });
          if (existing.length > rows.length) {
            const surplus = new Set(existing.slice(rows.length));
            m.items = m.items.filter((i) => !surplus.has(i));
          }
        });
      };
    };
  } else if (q.t === "announce") {
    // one input row per announcement; stored as newline-separated text
    const annIt = items.find((i) => i.kind === "announcements") || blankItem("announcements");
    const lines = (annIt.text || "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) lines.push("");
    const rowHtml = (val) => `
      <div class="speaker-row">
        <span class="ann-dot">•</span>
        <input class="ann-line" autocomplete="off" placeholder="Announcement" value="${esc(val)}">
        <button class="btn btn-sm ann-del" type="button">✕</button>
      </div>`;
    html = `<h3>Announcements ${dateLabel}</h3>
      <div id="qe-ann-rows">${lines.map(rowHtml).join("")}</div>
      <button class="btn btn-sm" id="qe-ann-add" type="button">+ Add announcement</button>`;
    onSave = (el) => {
      const text = [...el.querySelectorAll(".ann-line")].map((i) => i.value.trim()).filter(Boolean).join("\n");
      return (m) => {
        let it = m.items.find((i) => i.kind === "announcements");
        if (!it) { it = blankItem("announcements"); insertCanonical(m.items, it); }
        it.text = text;
      };
    };
  } else if (q.t === "wb") {
    const wbIt = items.find((i) => i.kind === "wardBusiness") || blankItem("wardBusiness");
    const wbState = {
      sustainings: (wbIt.sustainings || []).map((s) => ({ ...s })),
      releasings: (wbIt.releasings || []).map((s) => ({ ...s })),
      other: wbIt.other || "",
    };
    const rowsHtml = (list, prefix) => list.map((s, r) => `
      <div class="speaker-row">
        <input class="wb-name" data-list="${prefix}" data-row="${r}" placeholder="Name" value="${esc(s.name || "")}">
        <input class="wb-calling" data-list="${prefix}" data-row="${r}" placeholder="Calling" value="${esc(s.calling || "")}">
        <button class="btn btn-sm" data-wbdel="${prefix}" data-row="${r}" type="button">✕</button>
      </div>`).join("");
    html = `<h3>Ward Business ${dateLabel}</h3>
      <div class="row-sub" style="margin:.2rem 0">Sustainings <button class="btn btn-sm" id="qe-wb-addsus" type="button">+ Add</button></div>
      <div id="qe-wb-sus">${rowsHtml(wbState.sustainings, "sus")}</div>
      <div class="row-sub" style="margin:.8rem 0 .2rem">Releasings <button class="btn btn-sm" id="qe-wb-addrel" type="button">+ Add</button></div>
      <div id="qe-wb-rel">${rowsHtml(wbState.releasings, "rel")}</div>
      <label class="field" style="margin-top:.8rem">Other business
        <textarea id="qe-wb-other" rows="2">${esc(wbState.other)}</textarea>
      </label>`;
    onSave = (el) => {
      const readList = (prefix) => [...el.querySelectorAll(`.wb-name[data-list="${prefix}"]`)].map((inp) => {
        const r = inp.dataset.row;
        const calling = el.querySelector(`.wb-calling[data-list="${prefix}"][data-row="${r}"]`)?.value.trim() || "";
        return { name: inp.value.trim(), calling };
      }).filter((s) => s.name || s.calling);
      const sustainings = readList("sus");
      const releasings = readList("rel");
      const other = el.querySelector("#qe-wb-other").value.trim();
      return (m) => {
        let t = m.items.find((i) => i.kind === "wardBusiness");
        if (!t) { t = blankItem("wardBusiness"); insertCanonical(m.items, t); }
        t.sustainings = sustainings; t.releasings = releasings; t.other = other;
      };
    };
  } else {
    const it = nthItem(items, q.k, q.o) || blankItem(q.k);
    const label = KINDS[q.k]?.label || q.k;
    const byLine = it.confirmed && it.confirmedBy ? `Confirmed by ${it.confirmedBy}` : "";
    if (PRAYER_KINDS.includes(q.k)) {
      html = `<h3>${label} ${dateLabel}</h3>
        <label class="field">Name <input id="qe-name" value="${esc(it.name || "")}"></label>
        <label class="field" style="margin-top:.6rem">Arranged by ${orgSel("qe-org", it.org || "")}</label>
        ${confirmField(it.confirmed, byLine)}`;
      onSave = (el) => {
        const name = el.querySelector("#qe-name").value.trim();
        const org = el.querySelector("#qe-org").value;
        const nowConfirmed = el.querySelector("#qe-confirmed").checked;
        return (m) => {
          const t = ensureQE(m, q);
          t.name = name; t.org = org;
          t.confirmed = nowConfirmed;
          t.confirmedBy = nowConfirmed ? (it.confirmed ? it.confirmedBy : ctx.name) : "";
        };
      };
    } else if (SPEAKER_KINDS.includes(q.k)) {
      html = `<h3>${label} ${dateLabel}</h3>
        <label class="field">Name <input id="qe-name" value="${esc(it.name || "")}"></label>
        <label class="field" style="margin-top:.6rem">Topic (optional) <input id="qe-topic" value="${esc(it.topic || "")}"></label>
        ${confirmField(it.confirmed, byLine)}`;
      onSave = (el) => {
        const name = el.querySelector("#qe-name").value.trim();
        const topic = el.querySelector("#qe-topic").value.trim();
        const nowConfirmed = el.querySelector("#qe-confirmed").checked;
        return (m) => {
          const t = ensureQE(m, q);
          t.name = name; t.topic = topic;
          t.confirmed = nowConfirmed;
          t.confirmedBy = nowConfirmed ? (it.confirmed ? it.confirmedBy : ctx.name) : "";
        };
      };
    } else if (q.k === "musical") {
      html = `<h3>${label} ${dateLabel}</h3>
        <label class="field">Who (person/group) <input id="qe-who" value="${esc(it.who || "")}"></label>
        <label class="field" style="margin-top:.6rem">Hymn / piece <input id="qe-hymn" value="${esc(it.hymn || "")}"></label>
        <label class="field" style="margin-top:.6rem">Accompanist <input id="qe-acc" value="${esc(it.accompanist || "")}"></label>
        ${confirmField(it.confirmed, byLine)}`;
      onSave = (el) => {
        const who = el.querySelector("#qe-who").value.trim();
        const hymn = el.querySelector("#qe-hymn").value.trim();
        const acc = el.querySelector("#qe-acc").value.trim();
        const nowConfirmed = el.querySelector("#qe-confirmed").checked;
        return (m) => {
          const t = ensureQE(m, q);
          t.who = who; t.hymn = hymn; t.accompanist = acc;
          t.confirmed = nowConfirmed;
          t.confirmedBy = nowConfirmed ? (it.confirmed ? it.confirmedBy : ctx.name) : "";
        };
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

  // ward-business row add/remove (event delegation so we don't have to re-bind on every change)
  el.addEventListener("click", (e) => {
    if (e.target.id === "qe-wb-addsus" || e.target.id === "qe-wb-addrel") {
      const prefix = e.target.id === "qe-wb-addsus" ? "sus" : "rel";
      const wrap = el.querySelector(prefix === "sus" ? "#qe-wb-sus" : "#qe-wb-rel");
      const r = wrap.children.length;
      wrap.insertAdjacentHTML("beforeend", `
        <div class="speaker-row">
          <input class="wb-name" data-list="${prefix}" data-row="${r}" placeholder="Name">
          <input class="wb-calling" data-list="${prefix}" data-row="${r}" placeholder="Calling">
          <button class="btn btn-sm" data-wbdel="${prefix}" data-row="${r}" type="button">✕</button>
        </div>`);
    }
    if (e.target.dataset.wbdel) e.target.closest(".speaker-row").remove();
    // announcements rows
    if (e.target.id === "qe-ann-add") {
      el.querySelector("#qe-ann-rows").insertAdjacentHTML("beforeend", `
        <div class="speaker-row">
          <span class="ann-dot">•</span>
          <input class="ann-line" autocomplete="off" placeholder="Announcement">
          <button class="btn btn-sm ann-del" type="button">✕</button>
        </div>`);
      el.querySelector("#qe-ann-rows .speaker-row:last-child .ann-line")?.focus();
    }
    if (e.target.classList.contains("ann-del")) e.target.closest(".speaker-row").remove();
    // speaker group rows (data-spkadd names the kind's row container)
    if (e.target.dataset.spkadd) {
      const wrap = el.querySelector(`.qe-spk-rows[data-kind="${e.target.dataset.spkadd}"]`);
      wrap.insertAdjacentHTML("beforeend", `
        <div class="spk-row" style="display:flex;gap:.4rem;align-items:center;margin-bottom:.35rem">
          <span class="spk-drag" title="Drag to reorder">⠿</span>
          <input class="spk-name" placeholder="Name" autocomplete="off" style="flex:1">
          <input class="spk-topic" placeholder="Topic (optional)" autocomplete="off" style="flex:1">
          <label style="display:flex;align-items:center;gap:.25rem;font-size:.78rem;white-space:nowrap">
            <input type="checkbox" class="spk-conf"> Confirmed</label>
          <button class="btn btn-sm spk-del" type="button" title="Remove this speaker slot">✕</button>
        </div>`);
      wrap.querySelector(".spk-row:last-child .spk-name")?.focus();
    }
    if (e.target.classList.contains("spk-del")) e.target.closest(".spk-row").remove();
    // "No speaker this Sunday" checkbox hides that kind's rows + add button
    if (e.target.classList.contains("spk-none")) {
      const kind = e.target.dataset.kind;
      const show = !e.target.checked;
      el.querySelector(`.qe-spk-rows[data-kind="${kind}"]`).style.display = show ? "" : "none";
      el.querySelector(`[data-spkadd="${kind}"]`).style.display = show ? "" : "none";
    }
  });

  // drag-and-drop: reorder speaker rows (grab the ⠿ handle; in the Youth
  // editor rows can also move between the Primary and Youth sections), and
  // drag one prayer's header onto the other prayer to swap them.
  let dragRow = null, dragPrayer = false;
  // rows are only draggable while the handle is held, so the text inputs
  // inside them keep normal selection behavior (touchstart covers iOS,
  // where the long-press drag needs draggable set before it begins)
  const armRow = (e) => {
    const handle = e.target.closest(".spk-row .spk-drag");
    if (handle) handle.closest(".spk-row").draggable = true;
  };
  el.addEventListener("mousedown", armRow);
  el.addEventListener("touchstart", armRow, { passive: true });
  el.addEventListener("dragstart", (e) => {
    const row = e.target.closest?.(".spk-row");
    const head = e.target.closest?.(".qe-prayer-head");
    if (row && row.draggable) { dragRow = row; row.classList.add("dragging"); }
    else if (head) dragPrayer = true;
    else return;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", ""); } catch {}
  });
  el.addEventListener("dragover", (e) => {
    if (dragRow) {
      const wrap = e.target.closest(".qe-spk-rows") || e.target.closest(".spk-row")?.parentElement;
      if (!wrap || !wrap.classList.contains("qe-spk-rows")) return;
      e.preventDefault();
      const over = e.target.closest(".spk-row");
      if (over && over !== dragRow) {
        const r = over.getBoundingClientRect();
        wrap.insertBefore(dragRow, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
      } else if (!over && !wrap.contains(dragRow)) {
        wrap.appendChild(dragRow); // dropped into an empty section
      }
    } else if (dragPrayer) {
      const sect = e.target.closest(".qe-prayer-sect");
      if (sect) { e.preventDefault(); sect.classList.add("drop-target"); }
    }
  });
  el.addEventListener("dragleave", (e) => {
    e.target.closest?.(".qe-prayer-sect")?.classList.remove("drop-target");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    if (dragPrayer) {
      // two fixed slots, so any prayer-to-prayer drop is a swap of the fields
      el.querySelectorAll(".qe-prayer-sect").forEach((s) => s.classList.remove("drop-target"));
      if (e.target.closest(".qe-prayer-sect")) {
        [["name", "value"], ["org", "value"], ["conf", "checked"]].forEach(([f, prop]) => {
          const a = el.querySelector(`#qe-inv-${f}`), b = el.querySelector(`#qe-ben-${f}`);
          const t = a[prop]; a[prop] = b[prop]; b[prop] = t;
        });
        // the "confirmed by" notes belong to the pre-swap assignments — drop them
        el.querySelectorAll(".qe-prayer-sect .confirm-by").forEach((s) => s.remove());
      }
    }
  });
  el.addEventListener("dragend", () => {
    if (dragRow) { dragRow.classList.remove("dragging"); dragRow.draggable = false; dragRow = null; }
    dragPrayer = false;
    el.querySelectorAll(".qe-prayer-sect").forEach((s) => s.classList.remove("drop-target"));
  });

  // "+" on the Speakers pill: arrive with a fresh row inserted and focused
  if ((q.t === "spk" || q.t === "py") && q.add) {
    el.querySelector(`[data-spkadd="${q.t === "py" ? "youthSpeaker" : q.k}"]`)?.click();
  }

  // intermediate slot: Hymn / Special Musical # / Choir toggle
  el.querySelectorAll("[data-inter-mode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const mode = btn.dataset.interMode;
      el.querySelector("#qe-inter-hymn-fields").style.display = mode === "hymn" ? "flex" : "none";
      el.querySelector("#qe-inter-musical-fields").style.display = mode === "musical" ? "block" : "none";
      el.querySelector("#qe-inter-choir-fields").style.display = mode === "choir" ? "block" : "none";
      el.querySelectorAll("[data-inter-mode]").forEach((b) => b.classList.toggle("active", b === btn));
    }));

  // hymn number <-> title autofill on any paired hymn inputs in this modal
  el.querySelectorAll(".hymn-num").forEach((n) =>
    wireHymnAutofill(n, n.parentElement.querySelector(".hymn-title")));

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
    <h3>Ward Business <span class="row-sub">· ${fmtDay(date, { year: true })}</span></h3>
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
    <h3>${fmtDay(date, { year: true })} <span class="row-sub">·${nthSunday(date) === 5 ? " 5th Sunday ·" : ""} ${esc(typeLabel(m, date))}</span>
      ${m.theme ? `<div class="theme-tag" style="margin-top:.2rem">“${esc(m.theme)}”</div>` : ""}</h3>
    <div id="ag-wrap">${renderAgendaView(m, canEdit)}</div>
    <div class="modal-actions">
      <button class="btn" id="vw-print" title="Print or save as PDF">🖨 Print</button>
      <div class="right">
        <button class="btn" id="vw-close">Close</button>
        ${canEdit ? `<button class="btn btn-primary" id="vw-edit">Edit</button>` : ""}
      </div>
    </div>`);
  el.querySelector("#vw-close").addEventListener("click", closeModal);
  el.querySelector("#vw-edit")?.addEventListener("click", () => { closeModal(); editMeeting(date); });
  // Print: swap in a clean print-only copy of the agenda and open the system
  // print dialog (which includes Save as PDF)
  el.querySelector("#vw-print").addEventListener("click", () => {
    const cur = meetings[date] || m;
    const holder = document.createElement("div");
    holder.id = "print-agenda";
    holder.innerHTML = `
      <h2 style="margin:0 0 .15rem">Sacrament Meeting</h2>
      <div style="color:#5b6675;margin-bottom:.8rem">${fmtDay(date, { year: true })}${nthSunday(date) === 5 ? " · 5th Sunday" : ""}${cur.type !== "sacrament" ? " · " + esc(typeLabel(cur, date)) : ""}</div>
      ${renderAgendaView(cur, false)}`;
    document.body.appendChild(holder);
    document.body.classList.add("printing");
    const cleanup = () => {
      holder.remove();
      document.body.classList.remove("printing");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
    setTimeout(cleanup, 1500); // fallback for browsers that skip afterprint
  });
  if (!canEdit) return;
  const refresh = () => { el.querySelector("#ag-wrap").innerHTML = renderAgendaView(meetings[date] || m, canEdit); };
  const inlineNum = (holder, curVal, style, onCommit) => {
    holder.innerHTML = `<input value="${esc(String(curVal))}" style="${style}">`;
    const inp = holder.querySelector("input");
    inp.focus(); inp.select();
    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      await onCommit(inp.value.trim());
      refresh();
    };
    inp.addEventListener("click", (ev) => ev.stopPropagation());
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      if (ev.key === "Escape") { ev.preventDefault(); done = true; refresh(); }
    });
    inp.addEventListener("blur", () => setTimeout(() => { if (!done) commit(); }, 100));
  };
  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tedit]");
    if (t && !t.querySelector("input")) {
      const idx = Number(t.dataset.tedit);
      inlineNum(t, meetings[date]?.items?.[idx]?.time ?? "", "width:3.2rem;font:inherit;font-size:.8rem;padding:.05rem .2rem;border:1px solid var(--line);border-radius:4px",
        (v) => patchMeeting(date, (mm) => { if (mm.items[idx]) mm.items[idx].time = Math.max(0, Number(v) || 0); }));
    }
  });
}

function renderAgendaView(m, canEdit = false) {
  if (NO_MEETING(m.type)) {
    return `<div class="row-sub" style="margin-top:.4rem">🏛 ${esc(typeLabel(m, m.date))} — no ward sacrament meeting.${m.notes ? " " + esc(m.notes) : ""}</div>`;
  }
  // running clock: each item row shows the wall time it starts at
  const startStr = m.startTime || "9:00";
  const sm = /^(\d{1,2}):(\d{2})$/.exec(startStr.trim());
  let curClock = sm ? Number(sm[1]) * 60 + Number(sm[2]) : 9 * 60;
  const fmtClock = (t) => `${((Math.floor(t / 60) + 11) % 12) + 1}:${String(t % 60).padStart(2, "0")}`;
  let totalMin = 0;
  // clock chip + minutes; minutes are click-to-edit for bishopric (idx = items index)
  const timeCell = (time, idx) => {
    if (!time && time !== 0) return "";
    const startsAt = fmtClock(curClock);
    const mins = Number(time) || 0;
    curClock += mins; totalMin += mins;
    return `<span class="ag-clock">${startsAt}</span><span class="ag-time${canEdit && idx != null ? " ag-tclick" : ""}"${canEdit && idx != null ? ` data-tedit="${idx}" title="Click to change the minutes"` : ""}>${time} min</span>`;
  };
  const row = (label, val, time, idx, cls) =>
    `<div class="ag-row${cls ? " " + cls : ""}"><span class="ag-label">${esc(label)}:</span><span class="ag-val">${val}</span>${time ? timeCell(time, idx) : ""}</div>`;
  const head = [
    m.presiding ? row("Presiding", esc(m.presiding)) : "",
    m.conducting ? row("Conducting", esc(m.conducting)) : "",
    row("Music conductor", m.chorister ? esc(m.chorister) : `<span class="row-sub">—</span>`),
    row("Organist", m.organist ? esc(m.organist) : `<span class="row-sub">—</span>`),
    `<div class="ag-head-break"></div>`,
  ].join("");
  const items = (m.items || []).map((it, itemIdx) => {
    const label = it.kind === "custom" ? (it.label || "Item") : (KINDS[it.kind]?.label || it.kind);
    // sacrament administration is the meeting's center of gravity — set it
    // apart (older docs use kind "sacrament", newer defaults "blessing")
    if (it.kind === "sacrament" || it.kind === "blessing") {
      const who = it.kind === "blessing" ? [it.priest1, it.priest2].filter(Boolean).join(" & ") : "";
      return `<div class="ag-row ag-sacrament"><span class="ag-sac-label">${esc(KINDS[it.kind].label)}${who ? ` <span class="ag-sac-who">· ${esc(who)}</span>` : ""}</span>${it.time ? timeCell(it.time, itemIdx) : ""}</div>`;
    }
    // testimonies get their own tall centered band (fast Sundays)
    if (it.kind === "testimonies") {
      return `<div class="ag-row ag-sacrament ag-testimonies"><span class="ag-sac-label">${esc(KINDS.testimonies.label)}</span>${it.time ? timeCell(it.time, itemIdx) : ""}</div>`;
    }
    // primary/youth slots with nobody assigned (or marked none) stay off the agenda
    if ((it.kind === "primarySpeaker" || it.kind === "youthSpeaker") && (it.none || !it.name)) return "";
    let val = "";
    let extraBelow = ""; // full-width content box rendered under the row
    if (HYMN_KINDS.includes(it.kind)) {
      val = esc([it.num ? "#" + it.num : "", it.title].filter(Boolean).join(" "));
    } else if (SPEAKER_KINDS.includes(it.kind)) {
      val = it.none ? `<span class="row-sub">none this week</span>` : esc([it.name, it.topic ? "— " + it.topic : ""].filter(Boolean).join(" "));
    } else if (PRAYER_KINDS.includes(it.kind)) {
      val = esc(it.name || "") + (it.org ? ` <span class="row-sub">(arranged by ${esc(it.org)})</span>` : "");
    } else if (it.kind === "musical") {
      val = esc([it.who, it.hymn ? "— " + it.hymn : ""].filter(Boolean).join(" "))
        + (it.accompanist ? ` <span class="row-sub">(accompanist: ${esc(it.accompanist)})</span>` : "");
    } else if (it.kind === "choir") {
      val = esc(it.hymn || "") + (it.accompanist ? ` <span class="row-sub">(accompanist: ${esc(it.accompanist)})</span>` : "");
    } else if (it.kind === "blessing") {
      val = esc([it.priest1, it.priest2].filter(Boolean).join(" & "));
    } else if (it.kind === "babyBlessing") {
      val = esc(it.name || "");
    } else if (it.kind === "wardBusiness") {
      const parts = [];
      (it.sustainings || []).forEach((s) => parts.push(`Sustain: ${esc(s.name)}${s.calling ? " — " + esc(s.calling) : ""}`));
      (it.releasings || []).forEach((r) => parts.push(`Release: ${esc(r.name)}${r.calling ? " — " + esc(r.calling) : ""}`));
      if (it.other) parts.push(esc(it.other));
      if (parts.length) extraBelow = `<div class="ag-detail-box ag-detail-full">${parts.map((p) => `• ${p}`).join("<br>")}</div>`;
    } else if (it.kind === "announcements") {
      const lines = (it.text || "").split("\n").map((s) => s.trim()).filter(Boolean);
      if (lines.length) extraBelow = `<div class="ag-detail-box ag-detail-full">${lines.map((l) => `• ${esc(l)}`).join("<br>")}</div>`;
    } else {
      val = esc(it.text || "");
    }
    // dividers fence the opening block (opening hymn + prayer) and the
    // closing block (closing hymn + prayer) into their own groups
    const breakBefore = it.kind === "closingHymn" || it.kind === "openingHymn" ? `<div class="ag-head-break"></div>` : "";
    const breakAfter = it.kind === "invocation" ? `<div class="ag-head-break"></div>` : "";
    // sacrament hymn joins the blue administration band as one grouped block
    return breakBefore + row(label, val, it.time || "", itemIdx, it.kind === "sacramentHymn" ? "ag-sac-hymn" : "") + extraBelow + breakAfter;
  }).join("");
  const totalRow = `<div class="ag-row ag-total"><span class="ag-val"></span><span class="ag-clock">ends ~${fmtClock(curClock)}</span><span class="ag-time">${totalMin} min</span></div>`;
  return `<div class="agenda-view" style="margin-top:.6rem">${head}${items}${totalRow}${m.notes ? row("Notes", esc(m.notes)) : ""}</div>`;
}

// ===== Table (spreadsheet) view =====
function renderTable(wrap) {
  const canEdit = hasRole("bishopric");
  const today = todayISO();
  const thisYear = new Date().getFullYear();
  // default: this week onward; "show previous" reveals the whole year (past rows dimmed)
  const dates = (viewYear === thisYear && !showPast)
    ? sundaysOfYear(viewYear, upcomingSunday())
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
        <input class="cell-in cell-num" list="${kind === "sacramentHymn" ? "dl-sac-hymn-nums" : "dl-hymn-nums"}" autocomplete="off" data-date="${date}" data-cell="hymnNum" data-kind="${kind}"
          value="${esc(it?.num || "")}" placeholder="#" inputmode="numeric" ${dis}>
        <input class="cell-in" list="${kind === "sacramentHymn" ? "dl-sac-hymn-titles" : "dl-hymn-titles"}" autocomplete="off" data-date="${date}" data-cell="hymnTitle" data-kind="${kind}"
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
    const choir = first("choir");
    const interHtml = isConf ? "" :
      mus ? `<span class="${canEdit ? "st-click" : ""}"${canEdit ? ` data-date="${date}" data-qe='{"t":"inter"}'` : ""}>♫ ${esc(mus.who || "—")}</span>` :
      choir ? `<span class="${canEdit ? "st-click" : ""}"${canEdit ? ` data-date="${date}" data-qe='{"t":"inter"}'` : ""}>🎵 Choir${choir.hymn ? " — " + esc(choir.hymn) : ""}</span>` : `
      <div class="hymn-cell">
        <input class="cell-in cell-num" list="dl-hymn-nums" autocomplete="off" data-date="${date}" data-cell="hymnNum" data-kind="intermediateHymn" value="${esc(first("intermediateHymn")?.num || "")}" placeholder="#" inputmode="numeric" ${dis}>
        <input class="cell-in" list="dl-hymn-titles" autocomplete="off" data-date="${date}" data-cell="hymnTitle" data-kind="intermediateHymn" value="${esc(first("intermediateHymn")?.title || "")}" placeholder="name" ${dis}>
      </div>`;

    return `
    <tr class="${date < today ? "row-past" : ""} ${planned ? "" : "row-unplanned"} ${isConf ? "row-conf" : ""} ${type === "fast" ? "row-fast" : ""}">
      <td class="cell-date" data-view="${date}">
        <b>${shortDate}</b>
        ${nth === 5 ? `<div><span class="nth-pill nth-5">5th</span></div>` : ""}
      </td>
      <td class="cell-type${type !== "sacrament" ? " has-type" : ""}">
        <select class="cell-sel" data-date="${date}" data-cell="type" ${dis}>
          ${MEETING_TYPES.map(([k]) => `<option value="${k}" ${type === k ? "selected" : ""}>${SHORT_TYPE[k] || k}</option>`).join("")}
        </select>
        ${isConf ? "" : `<input class="cell-in cell-theme" data-date="${date}" data-cell="theme" value="${esc(m?.theme || "")}" placeholder="theme" ${dis}>`}
      </td>
      <td class="cell-conducting">${isConf ? "" : `
        <select class="cell-sel" data-date="${date}" data-cell="conducting" ${dis}>
          <option value="">—</option>
          ${bishopric.map((n) => `<option value="${esc(n)}" ${m?.conducting === n ? "selected" : ""}>${esc(n)}</option>`).join("")}
          ${m?.conducting && !bishopric.includes(m.conducting) ? `<option value="${esc(m.conducting)}" selected>${esc(m.conducting)}</option>` : ""}
        </select>
        ${wbPillHtml(m, date, canEdit)}
        ${annPillHtml(m, date, canEdit)}`}
      </td>
      <td>${isConf ? "" : `
        <label class="cell-label">Cond.<input class="cell-in" list="dl-conductors" data-date="${date}" data-cell="chorister" value="${esc(m?.chorister || "")}" placeholder="—" ${dis}></label>
        <label class="cell-label">Org.<input class="cell-in" list="dl-organists" data-date="${date}" data-cell="organist" value="${esc(m?.organist || "")}" placeholder="—" ${dis}></label>`}
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
      <div style="text-align:center;margin-bottom:.5rem">
        <span class="row-sub">${viewYear} · ${fmtDay(dates[0])} – ${fmtDay(dates[dates.length - 1])}</span>
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
    </div>` + musicDatalists() + hymnDatalists();

  wrap.querySelectorAll("[data-view]").forEach((td) =>
    td.addEventListener("click", () => viewMeeting(td.dataset.view)));
  wrap.querySelectorAll("[data-editspk]").forEach((td) =>
    td.addEventListener("click", () => editMeeting(td.dataset.editspk)));
  wrap.querySelectorAll("[data-qe]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      quickEdit(el.dataset.date, JSON.parse(el.dataset.qe));
    }));

  if (!canEdit) return;
  wrap.querySelectorAll(".cell-in, .cell-sel").forEach((el) =>
    el.addEventListener("change", () => commitCell(el)));
}

// insert a table-created item at its canonical spot in the agenda
function insertCanonical(items, it) {
  // siblings stay together: a new item of a kind that already exists lands
  // right after the last one (default agendas put the intermediate hymn
  // between speakers, so a rank-based insert would split the speaker list)
  let last = -1;
  items.forEach((x, i) => { if (x.kind === it.kind) last = i; });
  if (last >= 0) { items.splice(last + 1, 0, it); return; }
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
      const it = ensure(kind);
      it.num = val.trim();
      const t = hymnTitleForNum(it.num);
      if (t) it.title = t; // catalog match fills the title automatically
      warnIfBlocked(it.num);
    } else if (cell === "hymnTitle") {
      const it = ensure(kind);
      it.title = val.trim();
      const n = hymnNumForTitle(it.title);
      if (n) it.num = n;
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
    <h3>${fmtDay(date, { year: true })}${nthSunday(date) === 5 ? ` <span class="nth-pill nth-5">5th Sunday</span>` : ""}</h3>
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
      <label class="field">Music conductor <input id="mt-chorister" list="dl-conductors" value="${esc(m.chorister || "")}"></label>
      <label class="field">Organist <input id="mt-organist" list="dl-organists" value="${esc(m.organist || "")}"></label>
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
    ${hymnDatalists()}
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

  // hymn number <-> title autofill inside agenda item cards (delegated: items re-render)
  el.addEventListener("change", (e) => {
    const card = e.target.closest?.(".item-card");
    if (!card || !HYMN_KINDS.includes(card.dataset.kind)) return;
    if (e.target.classList.contains("f-num")) {
      const t = hymnTitleForNum(e.target.value);
      if (t) card.querySelector(".f-title").value = t;
      warnIfBlocked(e.target.value);
    } else if (e.target.classList.contains("f-title")) {
      const n = hymnNumForTitle(e.target.value);
      if (n) card.querySelector(".f-num").value = n;
      warnIfBlocked(card.querySelector(".f-num").value);
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
    body = `<input class="f-num" list="${it.kind === "sacramentHymn" ? "dl-sac-hymn-nums" : "dl-hymn-nums"}" placeholder="#" inputmode="numeric" autocomplete="off" style="width:4rem" value="${esc(it.num || "")}">
            <input class="f-title" list="${it.kind === "sacramentHymn" ? "dl-sac-hymn-titles" : "dl-hymn-titles"}" placeholder="Hymn title" autocomplete="off" style="flex:1" value="${esc(it.title || "")}">`;
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
    body = `<input class="f-who" placeholder="Who (person/group)" autocomplete="off" style="flex:1" value="${esc(it.who || "")}">
            <input class="f-hymn" placeholder="Hymn / piece" autocomplete="off" style="flex:1" value="${esc(it.hymn || "")}">
            <input class="f-acc" placeholder="Accompanist" autocomplete="off" style="flex:1" value="${esc(it.accompanist || "")}">`;
  } else if (it.kind === "choir") {
    body = `<input class="f-hymn" placeholder="Hymn / piece" autocomplete="off" style="flex:1" value="${esc(it.hymn || "")}">
            <input class="f-acc" placeholder="Accompanist" autocomplete="off" style="flex:1" value="${esc(it.accompanist || "")}">`;
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
  } else if (it.kind === "announcements") {
    // textarea, one announcement per line — an <input> would silently strip the newlines
    body = `<textarea class="f-text" rows="3" placeholder="One announcement per line" style="flex:1">${esc(it.text || "")}</textarea>`;
  } else { // testimonies, sacrament, etc.
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
    else if (it.kind === "choir") { it.hymn = v("f-hymn"); it.accompanist = v("f-acc"); }
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
