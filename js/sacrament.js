// Sacrament Meeting planner: one agenda per Sunday, keyed by date.
// The agenda is an ordered list of items (speakers, hymns, prayers, business…)
// that can be added, removed, reordered (drag or ▲▼), each with allotted minutes.
import { db } from "./firebase-init.js";
import { hasRole } from "./app.js";
import {
  collection, onSnapshot, doc, setDoc, deleteDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc, fmtDate, todayISO } from "./ui.js";

const ORGS = ["Relief Society", "Elders Quorum", "Primary", "Young Men", "Young Women"];

const DEFAULT_BISHOPRIC = ["Bishop Christensen", "Brother Bennett", "Brother Beach"];
let bishopric = [...DEFAULT_BISHOPRIC];

const MEETING_TYPES = [
  ["sacrament", "Sacrament Meeting"],
  ["fast", "Fast & Testimony Meeting"],
  ["conference", "General Conference"],
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
const SPEAKER_KINDS = ["primarySpeaker", "youthSpeaker", "speaker"];
const PRAYER_KINDS = ["invocation", "benediction"];

function defaultItems(type) {
  const mk = (kind, time) => blankItem(kind, time);
  if (type === "fast") {
    return [
      mk("announcements", 3), mk("openingHymn", 3), mk("invocation", 2),
      mk("wardBusiness", 3), mk("sacramentHymn", 3), mk("sacrament", 12),
      mk("testimonies", 30), mk("closingHymn", 3), mk("benediction", 2),
    ];
  }
  return [
    mk("announcements", 3), mk("openingHymn", 3), mk("invocation", 2),
    mk("wardBusiness", 3), mk("sacramentHymn", 3), mk("sacrament", 12),
    mk("youthSpeaker", 5), mk("speaker", 12), mk("intermediateHymn", 3),
    mk("speaker", 15), mk("closingHymn", 3), mk("benediction", 2),
  ];
}

function blankItem(kind, time = 5) {
  const it = { kind, time };
  if (HYMN_KINDS.includes(kind)) Object.assign(it, { num: "", title: "" });
  else if (SPEAKER_KINDS.includes(kind)) Object.assign(it, { name: "", topic: "" });
  else if (PRAYER_KINDS.includes(kind)) Object.assign(it, { name: "", org: "" });
  else if (kind === "musical") Object.assign(it, { who: "", hymn: "", accompanist: "" });
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
      ${hasRole("bishopric") ? `<button class="btn" id="btn-edit-bishopric">⚙ Bishopric</button>` : ""}
    </div>
    <div id="sunday-list"></div>`;

  panel.querySelector("#btn-edit-bishopric")?.addEventListener("click", editBishopric);

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
    if (snap.exists() && Array.isArray(snap.data().bishopric) && snap.data().bishopric.length) {
      bishopric = snap.data().bishopric;
    } else if (hasRole("bishopric")) {
      await setDoc(doc(db, "settings", "leadership"), { bishopric: DEFAULT_BISHOPRIC });
    }
  } catch { /* keep defaults */ }
  render();
}

function editBishopric() {
  const el = openModal(`
    <h3>Bishopric</h3>
    <p class="row-sub" style="margin:0 0 .8rem">These names fill the Presiding and Conducting dropdowns.</p>
    <div id="bp-rows">
      ${bishopric.map((n) => `<div class="speaker-row"><input class="bp-name" value="${esc(n)}"><button class="btn btn-sm bp-del" type="button">✕</button></div>`).join("")}
    </div>
    <button class="btn btn-sm" id="bp-add" type="button">+ Add name</button>
    <div class="modal-actions">
      <div class="right">
        <button class="btn" id="bp-cancel">Cancel</button>
        <button class="btn btn-primary" id="bp-save">Save</button>
      </div>
    </div>`);
  el.addEventListener("click", (e) => {
    if (e.target.classList.contains("bp-del")) e.target.closest(".speaker-row").remove();
  });
  el.querySelector("#bp-add").addEventListener("click", () => {
    el.querySelector("#bp-rows").insertAdjacentHTML("beforeend",
      `<div class="speaker-row"><input class="bp-name" value=""><button class="btn btn-sm bp-del" type="button">✕</button></div>`);
  });
  el.querySelector("#bp-cancel").addEventListener("click", closeModal);
  el.querySelector("#bp-save").addEventListener("click", async () => {
    const names = [...el.querySelectorAll(".bp-name")].map((i) => i.value.trim()).filter(Boolean);
    if (!names.length) { toast("Add at least one name"); return; }
    try {
      await setDoc(doc(db, "settings", "leadership"), { bishopric: names });
      bishopric = names;
      closeModal(); toast("Bishopric saved"); render();
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
}

// ---- Sunday list ----
function upcomingSundays(n = 12) {
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 7) % 7));
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    d.setDate(d.getDate() + 7);
  }
  return out;
}

function typeLabel(m, date) {
  const t = m?.type || defaultTypeFor(date);
  if (t === "other" && m?.customType) return m.customType;
  return MEETING_TYPES.find(([k]) => k === t)?.[1] || t;
}

function render() {
  const wrap = document.getElementById("sunday-list");
  if (!wrap) return;
  const canEdit = hasRole("bishopric");
  const today = todayISO();

  wrap.innerHTML = upcomingSundays().map((date) => {
    const m = meetings[date];
    const type = m?.type || defaultTypeFor(date);
    const isPast = date < today;
    const planned = !!m;
    const total = planned ? (m.items || []).reduce((s, i) => s + (Number(i.time) || 0), 0) : 0;
    return `
    <div class="card" style="${isPast ? "opacity:.65" : ""}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.75rem;flex-wrap:wrap">
        <div>
          <h3 style="margin:0">${fmtDate(date, { year: true })}
            <span class="pill ${type === "conference" ? "pill-role-bishop" : type === "fast" ? "pill-inprogress" : type !== "sacrament" ? "pill-approved" : "pill-open"}" style="vertical-align:middle">${esc(typeLabel(m, date))}</span>
          </h3>
          <div class="row-sub">${ordinal(nthSunday(date))} Sunday of the month${planned && total ? ` · ${total} min planned` : ""}${!planned && type !== "conference" ? " · default — not planned yet" : ""}</div>
        </div>
        ${canEdit ? `<button class="btn btn-sm" data-edit="${date}">${planned ? "Edit" : "Plan"}</button>` : ""}
      </div>
      ${type === "conference" && !planned ? `<div class="row-sub" style="margin-top:.4rem">🏛 General Conference — no sacrament meeting.</div>` : ""}
      ${planned ? renderAgendaView(m) : ""}
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => editMeeting(b.dataset.edit)));
}

function renderAgendaView(m) {
  if (m.type === "conference") {
    return `<div class="row-sub" style="margin-top:.4rem">🏛 General Conference — no sacrament meeting.${m.notes ? " " + esc(m.notes) : ""}</div>`;
  }
  const head = [
    m.presiding ? `<div><span class="ag-label">Presiding:</span> ${esc(m.presiding)}</div>` : "",
    m.conducting ? `<div><span class="ag-label">Conducting:</span> ${esc(m.conducting)}</div>` : "",
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
    <h3>${fmtDate(date, { year: true })} <span class="row-sub">· ${ordinal(nthSunday(date))} Sunday</span></h3>
    <div class="form-grid two-col">
      <label class="field">Meeting type
        <select id="mt-type">
          ${MEETING_TYPES.map(([k, l]) => `<option value="${k}" ${type === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label class="field" id="mt-custom-wrap" style="${type === "other" ? "" : "display:none"}">Custom name
        <input id="mt-custom" value="${esc(m.customType || "")}">
      </label>
      <label class="field">Presiding ${personSelect("mt-presiding", m.presiding || "")}</label>
      <label class="field">Conducting ${personSelect("mt-conducting", m.conducting || "")}</label>
    </div>
    <div id="mt-agenda-wrap" style="${type === "conference" ? "display:none" : ""}">
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
        <button class="btn" id="mt-cancel">Cancel</button>
        <button class="btn btn-primary" id="mt-save">Save</button>
      </div>
    </div>`);

  el.classList.add("modal-wide");
  renderItems(el);

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
    el.querySelector("#mt-agenda-wrap").style.display = t === "conference" ? "none" : "";
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
  });

  el.querySelector("#mt-cancel").addEventListener("click", closeModal);
  el.querySelector("#mt-clear")?.addEventListener("click", async () => {
    if (!confirm("Clear this Sunday's plan?")) return;
    await deleteDoc(doc(db, "meetings", date));
    closeModal(); toast("Plan cleared");
  });
  el.querySelector("#mt-save").addEventListener("click", async () => {
    syncDraft(el);
    const t = el.querySelector("#mt-type").value;
    const data = {
      date,
      type: t,
      customType: t === "other" ? el.querySelector("#mt-custom").value.trim() : "",
      presiding: readPersonSelect(el, "mt-presiding"),
      conducting: readPersonSelect(el, "mt-conducting"),
      items: t === "conference" ? [] : draft.items,
      notes: el.querySelector("#mt-notes").value.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      await setDoc(doc(db, "meetings", date), data);
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
