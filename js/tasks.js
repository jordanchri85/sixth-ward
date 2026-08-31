// Tasks tab: assignable tasks with status tracking.
import { db } from "./firebase-init.js?v=1788148798";
import { ctx, hasRole } from "./app.js?v=1788148798";
import {
  collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp, getDocs,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc, fmtDate, todayISO } from "./ui.js?v=1788148798";

const STATUSES = [
  ["open", "Open"],
  ["inprogress", "In progress"],
  ["done", "Done"],
];

let unsub = null;
let tasks = [];
let people = [];       // approved users, for the assignee picker
let filter = "active"; // active | mine | done | all
let started = false;

export function initTasks() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-tasks");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Tasks</h2>
        <p class="panel-sub">Who's doing what, and where it stands.</p>
      </div>
      <button class="btn btn-primary" id="btn-new-task">+ New task</button>
    </div>
    <div class="chips" id="task-chips">
      <button class="chip active" data-f="active">Active</button>
      <button class="chip" data-f="mine">Mine</button>
      <button class="chip" data-f="done">Done</button>
      <button class="chip" data-f="all">All</button>
    </div>
    <div class="card" style="margin-top:.8rem">
      <div id="task-list"></div>
    </div>`;

  panel.querySelector("#btn-new-task").addEventListener("click", () => editTask(null));
  panel.querySelector("#task-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    filter = chip.dataset.f;
    panel.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
    render();
  });

  loadPeople();
  unsub = onSnapshot(query(collection(db, "tasks"), orderBy("createdAt", "desc")), (qs) => {
    tasks = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
}

async function loadPeople() {
  try {
    const qs = await getDocs(collection(db, "users"));
    people = qs.docs
      .map((d) => ({ uid: d.id, ...d.data() }))
      .filter((p) => p.role && p.role !== "pending")
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  } catch {
    people = [];
  }
}

function visibleTasks() {
  const today = todayISO();
  return tasks.filter((t) => {
    if (filter === "mine") return t.assigneeUid === ctx.uid && t.status !== "done";
    if (filter === "done") return t.status === "done";
    if (filter === "active") return t.status !== "done";
    return true;
  }).map((t) => ({ ...t, overdue: t.status !== "done" && t.dueDate && t.dueDate < today }));
}

function render() {
  const list = document.getElementById("task-list");
  if (!list) return;
  const vis = visibleTasks();
  if (!vis.length) {
    list.innerHTML = `<div class="empty-note">No tasks here. Enjoy the quiet. 🙌</div>`;
    return;
  }
  list.innerHTML = vis.map((t) => `
    <div class="list-row" data-id="${t.id}">
      <div class="row-main">
        <div class="row-title ${t.status === "done" ? "done-title" : ""}">${esc(t.title)}</div>
        <div class="row-sub">
          ${t.assigneeName ? esc(t.assigneeName) : "Unassigned"}
          ${t.dueDate ? " · due " + fmtDate(t.dueDate) : ""}
          ${t.notes ? " · " + esc(t.notes.slice(0, 60)) + (t.notes.length > 60 ? "…" : "") : ""}
        </div>
      </div>
      ${t.overdue ? `<span class="pill pill-overdue">Overdue</span>` : ""}
      <span class="pill pill-${t.status}">${STATUSES.find(([k]) => k === t.status)?.[1] || t.status}</span>
    </div>`).join("");

  list.querySelectorAll(".list-row").forEach((row) =>
    row.addEventListener("click", () => {
      const t = tasks.find((x) => x.id === row.dataset.id);
      if (t) editTask(t);
    }));
}

function editTask(t) {
  const isNew = !t;
  const canManage = hasRole("bishopric");
  const canEdit = canManage || (t && t.assigneeUid === ctx.uid);
  const peopleOpts = people.map((p) =>
    `<option value="${p.uid}" ${t?.assigneeUid === p.uid ? "selected" : ""}>${esc(p.name)}</option>`).join("");

  const m = openModal(`
    <h3>${isNew ? "New task" : "Edit task"}</h3>
    <div class="form-grid two-col">
      <label class="field full">Task
        <input id="tk-title" value="${esc(t?.title || "")}" ${canEdit || isNew ? "" : "disabled"}>
      </label>
      <label class="field">Assigned to
        <select id="tk-assignee" ${canManage || isNew ? "" : "disabled"}>
          <option value="">— Unassigned —</option>${peopleOpts}
        </select>
      </label>
      <label class="field">Due date
        <input type="date" id="tk-due" value="${t?.dueDate || ""}" ${canEdit || isNew ? "" : "disabled"}>
      </label>
      <label class="field">Status
        <select id="tk-status">
          ${STATUSES.map(([k, l]) => `<option value="${k}" ${t?.status === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label class="field full">Notes
        <textarea id="tk-notes" ${canEdit || isNew ? "" : "disabled"}>${esc(t?.notes || "")}</textarea>
      </label>
    </div>
    <div class="modal-actions">
      ${!isNew && canManage ? `<button class="btn btn-ghost btn-danger" id="tk-delete">Delete</button>` : ""}
      <div class="right">
        <button class="btn" id="tk-cancel">Cancel</button>
        <button class="btn btn-primary" id="tk-save">Save</button>
      </div>
    </div>`);

  m.querySelector("#tk-cancel").addEventListener("click", closeModal);
  m.querySelector("#tk-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this task?")) return;
    await deleteDoc(doc(db, "tasks", t.id));
    closeModal(); toast("Task deleted");
  });
  m.querySelector("#tk-save").addEventListener("click", async () => {
    const title = m.querySelector("#tk-title").value.trim();
    if (!title) { toast("Task needs a title"); return; }
    const assigneeUid = m.querySelector("#tk-assignee").value || null;
    const data = {
      title,
      assigneeUid,
      assigneeName: assigneeUid ? (people.find((p) => p.uid === assigneeUid)?.name || "") : "",
      dueDate: m.querySelector("#tk-due").value || null,
      status: m.querySelector("#tk-status").value,
      notes: m.querySelector("#tk-notes").value.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      if (isNew) {
        await addDoc(collection(db, "tasks"), {
          ...data, createdBy: ctx.uid, createdAt: serverTimestamp(),
        });
      } else {
        await updateDoc(doc(db, "tasks", t.id), data);
      }
      closeModal(); toast("Saved");
    } catch (err) {
      toast("Couldn't save: " + (err.code || err.message));
    }
  });
}
