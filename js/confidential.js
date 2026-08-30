// Confidential tab — bishop only. Enforced server-side by Firestore rules,
// not just by hiding the tab.
import { db } from "./firebase-init.js?v=1788127184";
import {
  collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc, fmtDate, todayISO } from "./ui.js?v=1788127184";

let items = [];
let showDone = false;
let started = false;

export function initConfidential() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-confidential");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>🔒 Confidential</h2>
        <p class="panel-sub">Visible to the bishop only — enforced by database security rules.</p>
      </div>
      <button class="btn btn-primary" id="btn-new-conf">+ New note</button>
    </div>
    <div class="conf-banner">Keep entries appropriately brief. This is for your working notes and follow-ups, not for records that belong in official Church systems.</div>
    <div class="chips" id="conf-chips">
      <button class="chip active" data-f="open">Open</button>
      <button class="chip" data-f="all">All</button>
    </div>
    <div class="card" style="margin-top:.8rem">
      <div id="conf-list"></div>
    </div>`;

  panel.querySelector("#btn-new-conf").addEventListener("click", () => editItem(null));
  panel.querySelector("#conf-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    showDone = chip.dataset.f === "all";
    panel.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
    render();
  });

  onSnapshot(query(collection(db, "confidential"), orderBy("createdAt", "desc")), (qs) => {
    items = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
}

function render() {
  const list = document.getElementById("conf-list");
  if (!list) return;
  const today = todayISO();
  const vis = items.filter((i) => showDone || i.status !== "done");
  if (!vis.length) {
    list.innerHTML = `<div class="empty-note">Nothing here.</div>`;
    return;
  }
  list.innerHTML = vis.map((i) => `
    <div class="list-row" data-id="${i.id}">
      <div class="row-main">
        <div class="row-title ${i.status === "done" ? "done-title" : ""}">${esc(i.title)}</div>
        <div class="row-sub">${i.dueDate ? "follow up " + fmtDate(i.dueDate) : ""}${i.notes ? (i.dueDate ? " · " : "") + esc(i.notes.slice(0, 80)) : ""}</div>
      </div>
      ${i.status !== "done" && i.dueDate && i.dueDate < today ? `<span class="pill pill-overdue">Follow up</span>` : ""}
      <span class="pill pill-${i.status === "done" ? "done" : "open"}">${i.status === "done" ? "Done" : "Open"}</span>
    </div>`).join("");
  list.querySelectorAll(".list-row").forEach((row) =>
    row.addEventListener("click", () => {
      const i = items.find((x) => x.id === row.dataset.id);
      if (i) editItem(i);
    }));
}

function editItem(i) {
  const isNew = !i;
  const el = openModal(`
    <h3>${isNew ? "New confidential note" : "Edit note"}</h3>
    <div class="form-grid two-col">
      <label class="field full">Title
        <input id="cf-title" value="${esc(i?.title || "")}">
      </label>
      <label class="field">Follow-up date
        <input type="date" id="cf-due" value="${i?.dueDate || ""}">
      </label>
      <label class="field">Status
        <select id="cf-status">
          <option value="open" ${i?.status !== "done" ? "selected" : ""}>Open</option>
          <option value="done" ${i?.status === "done" ? "selected" : ""}>Done</option>
        </select>
      </label>
      <label class="field full">Notes
        <textarea id="cf-notes" rows="5">${esc(i?.notes || "")}</textarea>
      </label>
    </div>
    <div class="modal-actions">
      ${!isNew ? `<button class="btn btn-ghost btn-danger" id="cf-delete">Delete</button>` : ""}
      <div class="right">
        <button class="btn" id="cf-cancel">Cancel</button>
        <button class="btn btn-primary" id="cf-save">Save</button>
      </div>
    </div>`);
  el.querySelector("#cf-cancel").addEventListener("click", closeModal);
  el.querySelector("#cf-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this note permanently?")) return;
    await deleteDoc(doc(db, "confidential", i.id));
    closeModal(); toast("Deleted");
  });
  el.querySelector("#cf-save").addEventListener("click", async () => {
    const title = el.querySelector("#cf-title").value.trim();
    if (!title) { toast("Needs a title"); return; }
    const data = {
      title,
      dueDate: el.querySelector("#cf-due").value || null,
      status: el.querySelector("#cf-status").value,
      notes: el.querySelector("#cf-notes").value.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      if (isNew) await addDoc(collection(db, "confidential"), { ...data, createdAt: serverTimestamp() });
      else await updateDoc(doc(db, "confidential", i.id), data);
      closeModal(); toast("Saved");
    } catch (err) {
      toast("Couldn't save: " + (err.code || err.message));
    }
  });
}
