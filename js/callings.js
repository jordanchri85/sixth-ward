// Callings tab (bishopric+): track open callings through the pipeline.
import { db } from "./firebase-init.js?v=1788120008";
import {
  collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc } from "./ui.js?v=1788120008";

const STAGES = [
  ["considering", "Considering"],
  ["approved", "Approved"],
  ["extended", "Call extended"],
  ["accepted", "Accepted"],
  ["sustained", "Sustained"],
  ["setapart", "Set apart"],
  ["declined", "Declined"],
];

let callings = [];
let showDone = false;
let started = false;

export function initCallings() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-callings");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Callings</h2>
        <p class="panel-sub">Openings and candidates, from consideration to setting apart.</p>
      </div>
      <button class="btn btn-primary" id="btn-new-calling">+ New calling</button>
    </div>
    <div class="chips" id="calling-chips">
      <button class="chip active" data-f="open">In progress</button>
      <button class="chip" data-f="all">All</button>
    </div>
    <div class="card" style="margin-top:.8rem">
      <div id="calling-list"></div>
    </div>`;

  panel.querySelector("#btn-new-calling").addEventListener("click", () => editCalling(null));
  panel.querySelector("#calling-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    showDone = chip.dataset.f === "all";
    panel.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
    render();
  });

  onSnapshot(query(collection(db, "callings"), orderBy("updatedAt", "desc")), (qs) => {
    callings = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
}

function render() {
  const list = document.getElementById("calling-list");
  if (!list) return;
  const vis = callings.filter((c) => showDone || (c.status !== "setapart" && c.status !== "declined"));
  if (!vis.length) {
    list.innerHTML = `<div class="empty-note">No callings in progress.</div>`;
    return;
  }
  list.innerHTML = vis.map((c) => `
    <div class="list-row" data-id="${c.id}">
      <div class="row-main">
        <div class="row-title">${esc(c.calling)}${c.organization ? ` <span style="color:var(--ink-soft);font-weight:400">· ${esc(c.organization)}</span>` : ""}</div>
        <div class="row-sub">${c.candidate ? esc(c.candidate) : "No candidate yet"}${c.notes ? " · " + esc(c.notes.slice(0, 70)) : ""}</div>
      </div>
      <span class="pill pill-${c.status}">${STAGES.find(([k]) => k === c.status)?.[1] || c.status}</span>
    </div>`).join("");
  list.querySelectorAll(".list-row").forEach((row) =>
    row.addEventListener("click", () => {
      const c = callings.find((x) => x.id === row.dataset.id);
      if (c) editCalling(c);
    }));
}

function editCalling(c) {
  const isNew = !c;
  const el = openModal(`
    <h3>${isNew ? "New calling" : "Edit calling"}</h3>
    <div class="form-grid two-col">
      <label class="field">Calling
        <input id="cl-calling" placeholder="e.g. Primary teacher" value="${esc(c?.calling || "")}">
      </label>
      <label class="field">Organization
        <input id="cl-org" placeholder="e.g. Primary" value="${esc(c?.organization || "")}">
      </label>
      <label class="field">Candidate
        <input id="cl-candidate" value="${esc(c?.candidate || "")}">
      </label>
      <label class="field">Stage
        <select id="cl-status">
          ${STAGES.map(([k, l]) => `<option value="${k}" ${(c?.status || "considering") === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label class="field full">Notes
        <textarea id="cl-notes">${esc(c?.notes || "")}</textarea>
      </label>
    </div>
    <div class="modal-actions">
      ${!isNew ? `<button class="btn btn-ghost btn-danger" id="cl-delete">Delete</button>` : ""}
      <div class="right">
        <button class="btn" id="cl-cancel">Cancel</button>
        <button class="btn btn-primary" id="cl-save">Save</button>
      </div>
    </div>`);
  el.querySelector("#cl-cancel").addEventListener("click", closeModal);
  el.querySelector("#cl-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this calling?")) return;
    await deleteDoc(doc(db, "callings", c.id));
    closeModal(); toast("Deleted");
  });
  el.querySelector("#cl-save").addEventListener("click", async () => {
    const calling = el.querySelector("#cl-calling").value.trim();
    if (!calling) { toast("Calling needs a name"); return; }
    const data = {
      calling,
      organization: el.querySelector("#cl-org").value.trim(),
      candidate: el.querySelector("#cl-candidate").value.trim(),
      status: el.querySelector("#cl-status").value,
      notes: el.querySelector("#cl-notes").value.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      if (isNew) await addDoc(collection(db, "callings"), { ...data, createdAt: serverTimestamp() });
      else await updateDoc(doc(db, "callings", c.id), data);
      closeModal(); toast("Saved");
    } catch (err) {
      toast("Couldn't save: " + (err.code || err.message));
    }
  });
}
