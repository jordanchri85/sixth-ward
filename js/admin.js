// People tab (bishop only): approve new sign-ins and assign roles.
import { db } from "./firebase-init.js?v=1788121160";
import { ctx } from "./app.js?v=1788121160";
import {
  collection, onSnapshot, updateDoc, doc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, esc } from "./ui.js?v=1788121160";

const ROLES = [
  ["pending", "Pending (no access)"],
  ["member", "Member"],
  ["bishopric", "Bishopric / Clerk"],
  ["bishop", "Bishop"],
];

let users = [];
let started = false;

export function initAdmin() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-admin");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>People</h2>
        <p class="panel-sub">Everyone who has signed in. Assign roles to grant access.</p>
      </div>
    </div>
    <div class="card">
      <table class="simple">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
        <tbody id="user-rows"></tbody>
      </table>
      <div class="row-sub" style="margin-top:.8rem">
        <b>Member</b> — sees tasks, sacrament plans, and the calendar; can update their own tasks.<br>
        <b>Bishopric / Clerk</b> — everything above, plus create/edit anything and see Callings.<br>
        <b>Bishop</b> — everything, including the Confidential tab and this page.
      </div>
    </div>`;

  onSnapshot(collection(db, "users"), (qs) => {
    users = qs.docs.map((d) => ({ uid: d.id, ...d.data() }));
    users.sort((a, b) => {
      const rank = (u) => (u.role === "pending" ? 0 : 1);
      return rank(a) - rank(b) || (a.name || "").localeCompare(b.name || "");
    });
    render();
  });
}

function render() {
  const tbody = document.getElementById("user-rows");
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-note">No one has signed in yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = users.map((u) => `
    <tr>
      <td>${esc(u.name || "—")}${u.uid === ctx.uid ? " <span class='row-sub'>(you)</span>" : ""}</td>
      <td>${esc(u.email || "")}</td>
      <td>
        ${u.uid === ctx.uid
          ? `<span class="pill pill-role-bishop">Bishop</span>`
          : `<select data-uid="${u.uid}">
              ${ROLES.map(([k, l]) => `<option value="${k}" ${u.role === k ? "selected" : ""}>${l}</option>`).join("")}
            </select>`}
      </td>
    </tr>`).join("");

  tbody.querySelectorAll("select").forEach((sel) =>
    sel.addEventListener("change", async () => {
      try {
        await updateDoc(doc(db, "users", sel.dataset.uid), { role: sel.value });
        toast("Role updated");
      } catch (err) {
        toast("Couldn't update: " + (err.code || err.message));
      }
    }));
}
