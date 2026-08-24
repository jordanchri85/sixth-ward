// Sacrament Meeting planner: one agenda per Sunday, keyed by date.
import { db } from "./firebase-init.js";
import { hasRole } from "./app.js";
import {
  collection, onSnapshot, doc, setDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc, fmtDate, todayISO } from "./ui.js";

let meetings = {};   // date -> doc data
let started = false;

const MEETING_TYPES = [
  ["sacrament", "Sacrament Meeting"],
  ["fast", "Fast & Testimony"],
  ["conference", "Stake / General Conference"],
  ["primary", "Primary Program"],
  ["other", "Other"],
];

export function initSacrament() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-sacrament");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Sacrament Meeting</h2>
        <p class="panel-sub">Speakers, hymns, and prayers for each Sunday.</p>
      </div>
    </div>
    <div id="sunday-list"></div>`;

  onSnapshot(collection(db, "meetings"), (qs) => {
    meetings = {};
    qs.docs.forEach((d) => (meetings[d.id] = d.data()));
    render();
  });
}

// The next N Sundays (plus the most recent past one for reference)
function upcomingSundays(n = 8) {
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 7) % 7)); // most recent Sunday (or today)
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    d.setDate(d.getDate() + 7);
  }
  return out;
}

function render() {
  const wrap = document.getElementById("sunday-list");
  if (!wrap) return;
  const canEdit = hasRole("bishopric");
  const today = todayISO();

  wrap.innerHTML = upcomingSundays().map((date) => {
    const m = meetings[date];
    const isPast = date < today;
    const typeLabel = MEETING_TYPES.find(([k]) => k === m?.type)?.[1] || "Sacrament Meeting";
    const speakers = (m?.speakers || []).filter((s) => s.name);
    const planned = !!m;
    return `
    <div class="card" style="${isPast ? "opacity:.65" : ""}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.75rem;flex-wrap:wrap">
        <h3 style="margin:0">${fmtDate(date, { year: true })}${m?.type && m.type !== "sacrament" ? " · " + typeLabel : ""}</h3>
        ${canEdit ? `<button class="btn btn-sm" data-edit="${date}">${planned ? "Edit" : "Plan"}</button>` : ""}
      </div>
      ${planned ? `
      <div class="agenda-view" style="margin-top:.6rem">
        ${line("Presiding", m.presiding)}
        ${line("Conducting", m.conducting)}
        ${line("Opening hymn", hymn(m.openingHymn))}
        ${line("Invocation", m.invocation)}
        ${line("Sacrament hymn", hymn(m.sacramentHymn))}
        ${speakers.map((s, i) =>
          line(`Speaker ${i + 1}`, s.name + (s.topic ? ` — ${s.topic}` : ""))).join("")}
        ${line("Intermediate hymn", hymn(m.intermediateHymn))}
        ${line("Closing hymn", hymn(m.closingHymn))}
        ${line("Benediction", m.benediction)}
        ${m.notes ? line("Notes", m.notes) : ""}
      </div>` : `<div class="row-sub" style="margin-top:.4rem">Not planned yet.</div>`}
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => editMeeting(b.dataset.edit)));
}

function line(label, val) {
  if (!val) return "";
  return `<div><span class="ag-label">${label}:</span> ${esc(val)}</div>`;
}
function hymn(h) {
  if (!h || (!h.num && !h.title)) return "";
  return [h.num ? "#" + h.num : "", h.title || ""].filter(Boolean).join(" ");
}

function hymnFields(id, label, h) {
  return `
    <div class="field full" style="display:grid;grid-template-columns:5.5rem 1fr;gap:.5rem;align-items:end">
      <label class="field">${label} #
        <input id="${id}-num" inputmode="numeric" value="${esc(h?.num || "")}">
      </label>
      <label class="field">Title
        <input id="${id}-title" value="${esc(h?.title || "")}">
      </label>
    </div>`;
}

function editMeeting(date) {
  const m = meetings[date] || {};
  const speakers = (m.speakers && m.speakers.length ? m.speakers : [{}, {}, {}]);

  const el = openModal(`
    <h3>${fmtDate(date, { year: true })}</h3>
    <div class="form-grid two-col">
      <label class="field full">Meeting type
        <select id="mt-type">
          ${MEETING_TYPES.map(([k, l]) => `<option value="${k}" ${(m.type || "sacrament") === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label class="field">Presiding <input id="mt-presiding" value="${esc(m.presiding || "")}"></label>
      <label class="field">Conducting <input id="mt-conducting" value="${esc(m.conducting || "")}"></label>
      <label class="field">Invocation (opening prayer) <input id="mt-invocation" value="${esc(m.invocation || "")}"></label>
      <label class="field">Benediction (closing prayer) <input id="mt-benediction" value="${esc(m.benediction || "")}"></label>
      ${hymnFields("mt-oh", "Opening hymn", m.openingHymn)}
      ${hymnFields("mt-sh", "Sacrament hymn", m.sacramentHymn)}
      <div class="full">
        <div class="mtg-sec-title" style="margin-top:.3rem">Speakers</div>
        <div id="mt-speakers">
          ${speakers.map((s) => speakerRow(s)).join("")}
        </div>
        <button class="btn btn-sm" id="mt-add-speaker" type="button">+ Add speaker</button>
      </div>
      ${hymnFields("mt-ih", "Intermediate hymn / musical number", m.intermediateHymn)}
      ${hymnFields("mt-ch", "Closing hymn", m.closingHymn)}
      <label class="field full">Notes / announcements
        <textarea id="mt-notes">${esc(m.notes || "")}</textarea>
      </label>
    </div>
    <div class="modal-actions">
      ${meetings[date] ? `<button class="btn btn-ghost btn-danger" id="mt-clear">Clear plan</button>` : ""}
      <div class="right">
        <button class="btn" id="mt-cancel">Cancel</button>
        <button class="btn btn-primary" id="mt-save">Save</button>
      </div>
    </div>`);

  el.querySelector("#mt-add-speaker").addEventListener("click", () => {
    el.querySelector("#mt-speakers").insertAdjacentHTML("beforeend", speakerRow({}));
  });
  el.querySelector("#mt-cancel").addEventListener("click", closeModal);
  el.querySelector("#mt-clear")?.addEventListener("click", async () => {
    if (!confirm("Clear this Sunday's plan?")) return;
    await deleteDoc(doc(db, "meetings", date));
    closeModal(); toast("Plan cleared");
  });
  el.querySelector("#mt-save").addEventListener("click", async () => {
    const hymnVal = (id) => {
      const num = el.querySelector(`#${id}-num`).value.trim();
      const title = el.querySelector(`#${id}-title`).value.trim();
      return num || title ? { num, title } : null;
    };
    const speakerEls = [...el.querySelectorAll("#mt-speakers .speaker-row")];
    const data = {
      date,
      type: el.querySelector("#mt-type").value,
      presiding: el.querySelector("#mt-presiding").value.trim(),
      conducting: el.querySelector("#mt-conducting").value.trim(),
      invocation: el.querySelector("#mt-invocation").value.trim(),
      benediction: el.querySelector("#mt-benediction").value.trim(),
      openingHymn: hymnVal("mt-oh"),
      sacramentHymn: hymnVal("mt-sh"),
      intermediateHymn: hymnVal("mt-ih"),
      closingHymn: hymnVal("mt-ch"),
      speakers: speakerEls.map((r) => ({
        name: r.querySelector(".sp-name").value.trim(),
        topic: r.querySelector(".sp-topic").value.trim(),
      })).filter((s) => s.name || s.topic),
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

function speakerRow(s) {
  return `
    <div class="speaker-row">
      <input class="sp-name" placeholder="Name" value="${esc(s.name || "")}">
      <input class="sp-topic" placeholder="Topic (optional)" value="${esc(s.topic || "")}">
    </div>`;
}
