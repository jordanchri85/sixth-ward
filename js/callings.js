// Bishopric tab (bishopric+): manage callings in three buckets —
// callings to fill, members who need callings, and calls in progress.
import { db } from "./firebase-init.js?v=1788148596";
import {
  collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc } from "./ui.js?v=1788148596";

const STAGES = [
  ["considering", "Considering"],
  ["approved", "Approved"],
  ["extended", "Call extended"],
  ["accepted", "Accepted"],
  ["sustained", "Sustained"],
  ["setapart", "Set apart"],
  ["declined", "Declined"],
];
const DONE = ["setapart", "declined"];

// one collection, two kinds of docs (keeps everything under the
// bishopric-only rules): kind "calling" (default) and kind "member"
// for the members-who-need-callings list
let items = [];
let showDone = false;
let started = false;

export function initCallings() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-callings");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Bishopric</h2>
        <p class="panel-sub">Callings to fill, members who need callings, and calls in progress.</p>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn" id="btn-new-member">+ Member needing a calling</button>
        <button class="btn btn-primary" id="btn-new-calling">+ New calling</button>
      </div>
    </div>
    <div id="bishopric-buckets"></div>
    <div class="chips" style="margin-top:.6rem">
      <button class="chip" id="chip-done">Show completed</button>
    </div>
    <div class="card hidden" id="calling-done-card" style="margin-top:.6rem">
      <h3>Completed</h3>
      <div id="calling-done"></div>
    </div>`;

  panel.querySelector("#btn-new-calling").addEventListener("click", () => editCalling(null));
  panel.querySelector("#btn-new-member").addEventListener("click", () => editMember(null));
  panel.querySelector("#chip-done").addEventListener("click", (e) => {
    showDone = !showDone;
    e.target.classList.toggle("active", showDone);
    panel.querySelector("#calling-done-card").classList.toggle("hidden", !showDone);
    render();
  });

  onSnapshot(query(collection(db, "callings"), orderBy("updatedAt", "desc")), (qs) => {
    items = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
}

const callingRow = (c) => `
  <div class="list-row" data-id="${c.id}">
    <div class="row-main">
      <div class="row-title">${esc(c.calling)}${c.organization ? ` <span style="color:var(--ink-soft);font-weight:400">· ${esc(c.organization)}</span>` : ""}</div>
      <div class="row-sub">${c.candidate ? esc(c.candidate) : "No candidate yet"}${c.notes ? " · " + esc(c.notes.slice(0, 70)) : ""}</div>
    </div>
    ${c.candidate ? `<span class="pill pill-${c.status}">${STAGES.find(([k]) => k === c.status)?.[1] || c.status}</span>` : `<span class="pill pill-overdue">Open</span>`}
  </div>`;

const memberRow = (p) => `
  <div class="list-row" data-id="${p.id}">
    <div class="row-main">
      <div class="row-title">${esc(p.name)}</div>
      ${p.notes ? `<div class="row-sub">${esc(p.notes.slice(0, 90))}</div>` : ""}
    </div>
    <span class="pill pill-inprogress">Needs calling</span>
  </div>`;

function render() {
  const wrap = document.getElementById("bishopric-buckets");
  if (!wrap) return;
  const callings = items.filter((i) => (i.kind || "calling") === "calling");
  const members = items.filter((i) => i.kind === "member");
  const toFill = callings.filter((c) => !DONE.includes(c.status) && !c.candidate);
  const inProgress = callings.filter((c) => !DONE.includes(c.status) && c.candidate);
  const done = callings.filter((c) => DONE.includes(c.status));

  const bucket = (title, sub, rows, empty) => `
    <div class="card" style="margin-top:.8rem">
      <h3 style="display:flex;align-items:center;gap:.5rem">${title} <span class="pill pill-role-member">${rows.length}</span></h3>
      <p class="row-sub" style="margin:0 0 .3rem">${sub}</p>
      ${rows.length ? rows.join("") : `<div class="empty-note">${empty}</div>`}
    </div>`;

  wrap.innerHTML =
    bucket("Callings to Fill", "Open positions with no candidate yet.",
      toFill.map(callingRow), "Nothing waiting to be filled.") +
    bucket("Members who need callings", "Keep them in mind as positions open up.",
      members.map(memberRow), "No one on the list.") +
    bucket("In Progress", "Candidates moving through consideration to setting apart.",
      inProgress.map(callingRow), "No calls in progress.");

  const doneList = document.getElementById("calling-done");
  if (doneList) doneList.innerHTML = done.length ? done.map(callingRow).join("") : `<div class="empty-note">None completed yet.</div>`;

  document.querySelectorAll("#panel-callings .list-row").forEach((row) =>
    row.addEventListener("click", () => {
      const it = items.find((x) => x.id === row.dataset.id);
      if (!it) return;
      if (it.kind === "member") editMember(it);
      else editCalling(it);
    }));
}

function editCalling(c) {
  const isNew = !c;
  const needy = items.filter((i) => i.kind === "member");
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
        <input id="cl-candidate" list="dl-needy" autocomplete="off" value="${esc(c?.candidate || "")}">
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
    <datalist id="dl-needy">${needy.map((p) => `<option value="${esc(p.name)}"></option>`).join("")}</datalist>
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
      // a candidate picked from the needs-a-calling list comes off that list
      const matched = data.candidate && needy.find((p) => p.name.toLowerCase() === data.candidate.toLowerCase());
      if (matched && confirm(`Remove ${matched.name} from the "needs a calling" list?`)) {
        await deleteDoc(doc(db, "callings", matched.id));
      }
      closeModal(); toast("Saved");
    } catch (err) {
      toast("Couldn't save: " + (err.code || err.message));
    }
  });
}

function editMember(p) {
  const isNew = !p;
  const el = openModal(`
    <h3>${isNew ? "Member needing a calling" : "Edit member"}</h3>
    <label class="field">Name
      <input id="nm-name" value="${esc(p?.name || "")}">
    </label>
    <label class="field" style="margin-top:.6rem">Notes <span style="font-weight:400">(interests, availability, ideas…)</span>
      <textarea id="nm-notes">${esc(p?.notes || "")}</textarea>
    </label>
    <div class="modal-actions">
      ${!isNew ? `<button class="btn btn-ghost btn-danger" id="nm-delete">Remove from list</button>` : ""}
      <div class="right">
        <button class="btn" id="nm-cancel">Cancel</button>
        <button class="btn btn-primary" id="nm-save">Save</button>
      </div>
    </div>`);
  el.querySelector("#nm-cancel").addEventListener("click", closeModal);
  el.querySelector("#nm-delete")?.addEventListener("click", async () => {
    await deleteDoc(doc(db, "callings", p.id));
    closeModal(); toast("Removed");
  });
  el.querySelector("#nm-save").addEventListener("click", async () => {
    const name = el.querySelector("#nm-name").value.trim();
    if (!name) { toast("Name is required"); return; }
    const data = {
      kind: "member",
      name,
      notes: el.querySelector("#nm-notes").value.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      if (isNew) await addDoc(collection(db, "callings"), { ...data, createdAt: serverTimestamp() });
      else await updateDoc(doc(db, "callings", p.id), data);
      closeModal(); toast("Saved");
    } catch (err) {
      toast("Couldn't save: " + (err.code || err.message));
    }
  });
}
