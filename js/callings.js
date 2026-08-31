// Bishopric tab (bishopric+): the callings flow.
//   1. Callings to Fill — names under consideration; mark the settled name
//   2. Call issued & accepted — awaiting sustaining and setting apart
//   3. Sustained & set apart — waiting on the membership clerk to record it
//   4. Complete
// Releases run a parallel flow: decided → notified → released → recorded.
// Plus a standing pool of members who need callings.
import { db } from "./firebase-init.js?v=1788151704";
import {
  collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { openModal, closeModal, toast, esc } from "./ui.js?v=1788151704";

const CALL_STAGES = [
  ["fill", "Calling to Fill"],
  ["issue", "Calls to Issue"],
  ["sustain", "Calls to Sustain"],
  ["apart", "Set Apart"],
  ["done", "Complete"],
];
const REL_STAGES = [
  ["decided", "Decided"],
  ["notified", "Notified"],
  ["released", "Released"],
  ["done", "Recorded"],
];

let items = [];
let showDone = false;
let started = false;

// legacy docs from the earlier pipeline get mapped into the new flow
function norm(d) {
  if (d.kind === "member" || d.kind === "release") return d;
  if (d.stage) {
    // older stage names fold into the current flow
    let stage = d.stage;
    let setApart = !!d.setApart;
    if (stage === "accepted" || stage === "called") stage = "sustain";
    else if (stage === "sustained") stage = "apart";
    else if (stage === "clerk" || stage === "setapart") { stage = "apart"; setApart = true; }
    if (stage === "fill" && d.decided) stage = "issue"; // a decided name moves forward
    return { kind: "calling", candidates: [], decided: "", ...d, stage, setApart };
  }
  const s = d.status || "considering";
  const stage = s === "considering" ? "fill"
    : s === "approved" ? "issue"
    : ["extended", "accepted"].includes(s) ? "sustain"
    : s === "sustained" ? "apart"
    : s === "setapart" ? "apart" : "done";
  return {
    ...d, kind: "calling", stage,
    candidates: d.candidate ? [d.candidate] : [],
    decided: (s !== "considering" && d.candidate) ? d.candidate : "",
    setApart: s === "setapart",
  };
}

export function initCallings() {
  if (started) return;
  started = true;
  const panel = document.getElementById("panel-callings");
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2>Bishopric</h2>
        <p class="panel-sub">Callings and releases, from consideration to the clerk's records.</p>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn" id="btn-new-member">+ Needs a calling</button>
        <button class="btn" id="btn-new-release">+ New release</button>
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
  panel.querySelector("#btn-new-release").addEventListener("click", () => editRelease(null));
  panel.querySelector("#btn-new-member").addEventListener("click", () => editMember(null));
  panel.querySelector("#chip-done").addEventListener("click", (e) => {
    showDone = !showDone;
    e.target.classList.toggle("active", showDone);
    panel.querySelector("#calling-done-card").classList.toggle("hidden", !showDone);
    render();
  });

  onSnapshot(query(collection(db, "callings"), orderBy("updatedAt", "desc")), (qs) => {
    items = qs.docs.map((d) => norm({ id: d.id, ...d.data() }));
    render();
  });
}

// every stage move gets stamped so you can see when it happened
const save = (id, data) => {
  const upd = { ...data, updatedAt: serverTimestamp() };
  if (upd.stage) upd["stamps." + upd.stage] = serverTimestamp();
  if (upd.setApart === true) upd["stamps.setApartDone"] = serverTimestamp();
  return updateDoc(doc(db, "callings", id), upd);
};
const fmtStamp = (ts) => {
  const d = ts?.toDate?.() || (ts ? new Date(ts) : null);
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
};
const stampLine = (label, ts) => {
  const f = fmtStamp(ts);
  return f ? `<div class="row-sub">${label} ${f}</div>` : "";
};

// ---- rows ----
// each calling gets a consistently colored pill so it's easy to single out;
// known organizations keep fixed colors, everything else hashes to one
const ORG_COLORS = {
  "relief society": "#cf6d96", "elders quorum": "#6b96c9", "primary": "#dd9257",
  "young men": "#74a67f", "young women": "#a37fc0", "sunday school": "#b98a2f",
  "bishopric": "#5b8fa8", "ward": "#5b8fa8",
};
const PILL_COLORS = ["#cf6d96", "#6b96c9", "#dd9257", "#74a67f", "#a37fc0", "#b98a2f", "#5b8fa8", "#c96b6b"];
const callColor = (label, orgKey) => {
  const key = (orgKey || label || "").toLowerCase().trim();
  let bg = ORG_COLORS[key];
  if (!bg) {
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    bg = PILL_COLORS[h % PILL_COLORS.length];
  }
  return bg;
};
// the whole card is one big tinted pill in the calling's color
const cardStyle = (label, orgKey) => {
  const col = callColor(label, orgKey);
  return `style="background:${col}22;border:1px solid ${col}55;border-left:5px solid ${col}" data-col="${col}"`;
};

const fillRow = (c) => {
  const cands = c.candidates || [];
  const sub = cands.length
    ? cands.map((n, i) => `<div class="cand-line">${esc(n)} <span class="cand-x" data-rm="${i}" title="Remove ${esc(n)} from consideration">✕</span></div>`).join("")
    : "No names yet";
  return `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}${c.organization ? ` <span class="call-card-org">· ${esc(c.organization)}</span>` : ""}</div>
    <div class="row-sub">${sub}</div>
  </div>`;
};

const issueRow = (c) => `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}</div>
    <div class="row-title">${esc(c.decided || "—")}</div>
    ${stampLine("Decided", c.stamps?.issue)}
    <div class="call-card-actions"><button class="btn btn-sm" data-adv="sustain" type="button" title="${esc(c.decided || "")} accepted the call">Accepted</button></div>
  </div>`;

const sustainRow = (c) => `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}</div>
    <div class="row-title">${esc(c.decided || "—")}</div>
    ${stampLine("Accepted", c.stamps?.sustain)}
    <div class="call-card-actions"><button class="btn btn-sm" data-adv="apart" type="button">Sustained →</button></div>
  </div>`;

const apartRow = (c) => `
  <div class="list-row call-card call-card-v" data-id="${c.id}" ${cardStyle(c.calling, c.organization)}>
    <div class="call-card-title" style="color:${callColor(c.calling, c.organization)}">${esc(c.calling)}</div>
    <div class="row-title">${esc(c.decided || "—")}</div>
    ${c.setApart
      ? `${stampLine("Set apart", c.stamps?.setApartDone)}<div class="row-sub">Waiting for the clerk to record it</div>`
      : stampLine("Sustained", c.stamps?.apart)}
    <div class="call-card-actions">${c.setApart
      ? `<button class="btn btn-sm" data-adv="done" type="button">Clerk updated ✓</button>`
      : `<button class="btn btn-sm" data-setapart="1" type="button">Set apart ✓</button>`}</div>
  </div>`;

const releaseRow = (r) => {
  const next = { decided: ["notified", "Notified →"], notified: ["released", "Released →"], released: ["done", "Clerk updated ✓"] }[r.stage];
  const back = { notified: "decided", released: "notified" }[r.stage];
  return `
  <div class="list-row call-card" data-id="${r.id}" ${cardStyle(r.calling || r.name)}>
    <div class="row-main">
      ${r.calling ? `<div class="call-card-title" style="color:${callColor(r.calling)}">${esc(r.calling)}</div>` : ""}
      <div class="row-title">${esc(r.name)}</div>
      <div class="row-sub">${r.notes ? esc(r.notes.slice(0, 70)) : "Release"}</div>
      ${stampLine(REL_STAGES.find(([k]) => k === r.stage)?.[1] || "", r.stamps?.[r.stage])}
    </div>
    <span class="pill ${r.stage === "released" ? "pill-accepted" : "pill-inprogress"}"${back ? ` data-adv="${back}" style="cursor:pointer" title="Click to go back a step"` : ""}>${REL_STAGES.find(([k]) => k === r.stage)?.[1] || r.stage}</span>
    ${next ? `<button class="btn btn-sm" data-adv="${next[0]}" type="button">${next[1]}</button>` : ""}
  </div>`;
};

const memberRow = (p) => `
  <div class="list-row" data-id="${p.id}">
    <div class="row-main">
      <div class="row-title">${esc(p.name)}</div>
      ${p.notes ? `<div class="row-sub">${esc(p.notes.slice(0, 90))}</div>` : ""}
    </div>
    <span class="pill pill-inprogress">Needs calling</span>
  </div>`;

const doneRow = (it) => `
  <div class="list-row" data-id="${it.id}">
    <div class="row-main">
      <div class="row-title">${it.kind === "release" ? `${esc(it.name)} — released` : `${esc(it.decided || "")} — ${esc(it.calling)}`}</div>
      ${stampLine("Completed", it.stamps?.done)}
    </div>
    <span class="pill pill-done">Complete</span>
  </div>`;

function render() {
  const wrap = document.getElementById("bishopric-buckets");
  if (!wrap) return;
  const callings = items.filter((i) => (i.kind || "calling") === "calling");
  const releases = items.filter((i) => i.kind === "release");
  const members = items.filter((i) => i.kind === "member");
  const by = (st) => callings.filter((c) => c.stage === st);

  const bucket = (title, sub, rows, empty, dropStage, addKind) => `
    <div class="card${dropStage ? " bb-col" : ""}" style="margin-top:.8rem">
      <h3 style="display:flex;align-items:center;gap:.5rem">${title} <span class="pill pill-role-member">${rows.length}</span>${addKind ? `<button class="btn btn-sm" data-add="${addKind}" type="button" style="margin-left:auto" title="Add">+</button>` : ""}</h3>
      <p class="row-sub" style="margin:0 0 .3rem">${sub}</p>
      <div${dropStage ? ` class="bb-drop" data-stage="${dropStage}"` : ""}>${rows.length ? rows.join("") : `<div class="empty-note">${empty}</div>`}</div>
    </div>`;

  // the calling flow reads left → right on desktop; drag a row to the next
  // column or use its arrow button
  wrap.innerHTML =
    `<div class="bishopric-board">` +
    bucket("Calling to Fill", "Names under consideration — star one to decide.",
      by("fill").map(fillRow), "Nothing waiting to be filled.", "fill", "calling") +
    bucket("Calls to Issue", "Name decided — extend the call.",
      by("issue").map(issueRow), "No calls waiting to be issued.", "issue") +
    bucket("Calls to Sustain", "Accepted — present for sustaining.",
      by("sustain").map(sustainRow), "No one waiting to be sustained.", "sustain") +
    bucket("Set Apart", "Set apart, then the clerk records it.",
      by("apart").map(apartRow), "No one waiting to be set apart.", "apart") +
    `</div>` +
    bucket("Releases", "Decided → notified → released → recorded by the clerk.",
      releases.filter((r) => r.stage !== "done").map(releaseRow), "No releases in progress.", null, "release") +
    bucket("Members who need callings", "The pool to draw from as positions open up.",
      members.map(memberRow), "No one on the list.", null, "member");

  const doneItems = [...callings.filter((c) => c.stage === "done"), ...releases.filter((r) => r.stage === "done")];
  const doneList = document.getElementById("calling-done");
  if (doneList) doneList.innerHTML = doneItems.length ? doneItems.map(doneRow).join("") : `<div class="empty-note">None completed yet.</div>`;

  document.querySelectorAll("#panel-callings .list-row").forEach((row) => {
    const it = () => items.find((x) => x.id === row.dataset.id);
    row.addEventListener("click", (e) => {
      const t = e.target;
      const item = it();
      if (!item) return;
      if (t.dataset.rm != null && t.classList.contains("cand-x")) { // ✕ a considered name
        e.stopPropagation();
        const cands = [...(item.candidates || [])];
        cands.splice(Number(t.dataset.rm), 1);
        save(item.id, { candidates: cands });
        return;
      }
      if (t.dataset.undecide) { // "Decided" pill → back to considering
        e.stopPropagation();
        save(item.id, { decided: "", stage: "fill" });
        return;
      }
      if (t.dataset.setapart) { // set apart done; still waiting on the clerk
        e.stopPropagation();
        save(item.id, { setApart: true });
        return;
      }
      if (t.dataset.adv) { // quick advance / step back to the named stage
        e.stopPropagation();
        save(item.id, { stage: t.dataset.adv });
        return;
      }

      if (item.kind === "member") editMember(item);
      else if (item.kind === "release") editRelease(item);
      else editCalling(item);
    });
  });

  // "+" on a bucket header opens the matching creator
  document.querySelectorAll("#panel-callings [data-add]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.dataset.add === "calling") editCalling(null);
      else if (b.dataset.add === "release") editRelease(null);
      else editMember(null);
    }));

  // drag a calling row between the three flow columns
  let dragId = null;
  document.querySelectorAll("#panel-callings .bb-drop .list-row").forEach((row) => {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      dragId = row.dataset.id;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", ""); } catch { /* older browsers */ }
    });
    row.addEventListener("dragend", () => {
      dragId = null;
      document.querySelectorAll(".bb-drop").forEach((z) => z.classList.remove("bb-over"));
    });
  });
  document.querySelectorAll("#panel-callings .bb-drop").forEach((zone) => {
    zone.addEventListener("dragover", (e) => {
      if (!dragId) return;
      e.preventDefault();
      zone.classList.add("bb-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("bb-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("bb-over");
      const it = items.find((x) => x.id === dragId);
      dragId = null;
      if (!it || it.kind !== "calling") return;
      const st = zone.dataset.stage;
      if (!st || st === it.stage) return;
      if (st !== "fill" && !it.decided && !(it.candidates || [])[0]) {
        toast("Add a name (and star it) before moving this forward");
        return;
      }
      const upd = { stage: st };
      if (st === "fill") upd.decided = ""; // dragged back = reconsidering
      else if (!it.decided) upd.decided = (it.candidates || [])[0];
      save(it.id, upd);
    });
  });
}

// ---- editors ----
function editCalling(c) {
  const isNew = !c;
  const needy = items.filter((i) => i.kind === "member");
  const cands = (c?.candidates || []).length ? [...c.candidates] : [""];
  const candRow = (n) => `
    <div class="speaker-row cand-row">
      <button class="btn btn-sm cand-star${n && n === c?.decided ? " cand-decided" : ""}" type="button" title="Mark as the name the bishopric settled on">★</button>
      <input class="cand-name" list="dl-needy" autocomplete="off" placeholder="Name" value="${esc(n)}">
      <button class="btn btn-sm cand-del" type="button" title="Remove this name">✕</button>
    </div>`;
  const el = openModal(`
    <h3>${isNew ? "New calling" : "Edit calling"}</h3>
    <div class="form-grid two-col">
      <label class="field">Calling
        <input id="cl-calling" placeholder="e.g. Primary teacher" value="${esc(c?.calling || "")}">
      </label>
      <label class="field">Organization
        <input id="cl-org" placeholder="e.g. Primary" value="${esc(c?.organization || "")}">
      </label>
    </div>
    <div class="row-sub" style="margin:.8rem 0 .3rem;font-weight:700">Names being considered <span style="font-weight:400">· ★ = settled on</span></div>
    <div id="cand-rows">${cands.map(candRow).join("")}</div>
    <button class="btn btn-sm" id="cand-add" type="button">+ Add a name</button>
    <label class="field" style="margin-top:.8rem">Stage
      <select id="cl-stage">${CALL_STAGES.map(([k, l]) => `<option value="${k}" ${(c?.stage || "fill") === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    </label>
    <label class="field" style="margin-top:.6rem">Notes
      <textarea id="cl-notes">${esc(c?.notes || "")}</textarea>
    </label>
    <datalist id="dl-needy">${needy.map((p) => `<option value="${esc(p.name)}"></option>`).join("")}</datalist>
    <div class="modal-actions">
      ${!isNew ? `<button class="btn btn-ghost btn-danger" id="cl-delete">Delete</button>` : ""}
      <div class="right">
        <button class="btn" id="cl-cancel">Cancel</button>
        <button class="btn btn-primary" id="cl-save">Save</button>
      </div>
    </div>`);
  el.addEventListener("click", (e) => {
    if (e.target.id === "cand-add") {
      el.querySelector("#cand-rows").insertAdjacentHTML("beforeend", candRow(""));
      el.querySelector("#cand-rows .cand-row:last-child .cand-name")?.focus();
    }
    if (e.target.classList.contains("cand-del")) e.target.closest(".cand-row").remove();
    if (e.target.classList.contains("cand-star")) {
      const was = e.target.classList.contains("cand-decided");
      el.querySelectorAll(".cand-star").forEach((s) => s.classList.remove("cand-decided"));
      if (!was) e.target.classList.add("cand-decided"); // click again to un-decide
    }
  });
  el.querySelector("#cl-cancel").addEventListener("click", closeModal);
  el.querySelector("#cl-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this calling?")) return;
    await deleteDoc(doc(db, "callings", c.id));
    closeModal(); toast("Deleted");
  });
  el.querySelector("#cl-save").addEventListener("click", async () => {
    const calling = el.querySelector("#cl-calling").value.trim();
    if (!calling) { toast("Calling needs a name"); return; }
    const rows = [...el.querySelectorAll(".cand-row")];
    const candidates = rows.map((r) => r.querySelector(".cand-name").value.trim()).filter(Boolean);
    const starRow = rows.find((r) => r.querySelector(".cand-star").classList.contains("cand-decided"));
    const decided = starRow ? starRow.querySelector(".cand-name").value.trim() : "";
    let stage = el.querySelector("#cl-stage").value;
    if (stage === "fill" && decided) stage = "issue";   // decided moves it forward
    if (stage === "issue" && !decided) stage = "fill";  // un-starred moves it back
    const data = {
      kind: "calling",
      calling,
      organization: el.querySelector("#cl-org").value.trim(),
      candidates,
      decided,
      stage,
      setApart: c?.setApart || false,
      notes: el.querySelector("#cl-notes").value.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      if (isNew) await addDoc(collection(db, "callings"), { ...data, stamps: { [data.stage]: new Date().toISOString() }, createdAt: serverTimestamp() });
      else {
        if (data.stage !== c.stage) data["stamps." + data.stage] = serverTimestamp();
        await updateDoc(doc(db, "callings", c.id), data);
      }
      const matched = decided && needy.find((p) => p.name.toLowerCase() === decided.toLowerCase());
      if (matched && data.stage !== "fill" && confirm(`Remove ${matched.name} from the "needs a calling" pool?`)) {
        await deleteDoc(doc(db, "callings", matched.id));
      }
      closeModal(); toast("Saved");
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
}

function editRelease(r) {
  const isNew = !r;
  const el = openModal(`
    <h3>${isNew ? "New release" : "Edit release"}</h3>
    <div class="form-grid two-col">
      <label class="field">Member
        <input id="rl-name" value="${esc(r?.name || "")}">
      </label>
      <label class="field">Current calling
        <input id="rl-calling" placeholder="What they're being released from" value="${esc(r?.calling || "")}">
      </label>
      <label class="field">Stage
        <select id="rl-stage">${REL_STAGES.map(([k, l]) => `<option value="${k}" ${(r?.stage || "decided") === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      </label>
      <label class="field full">Notes
        <textarea id="rl-notes">${esc(r?.notes || "")}</textarea>
      </label>
    </div>
    <div class="modal-actions">
      ${!isNew ? `<button class="btn btn-ghost btn-danger" id="rl-delete">Delete</button>` : ""}
      <div class="right">
        <button class="btn" id="rl-cancel">Cancel</button>
        <button class="btn btn-primary" id="rl-save">Save</button>
      </div>
    </div>`);
  el.querySelector("#rl-cancel").addEventListener("click", closeModal);
  el.querySelector("#rl-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this release?")) return;
    await deleteDoc(doc(db, "callings", r.id));
    closeModal(); toast("Deleted");
  });
  el.querySelector("#rl-save").addEventListener("click", async () => {
    const name = el.querySelector("#rl-name").value.trim();
    if (!name) { toast("Member name is required"); return; }
    const data = {
      kind: "release",
      name,
      calling: el.querySelector("#rl-calling").value.trim(),
      stage: el.querySelector("#rl-stage").value,
      notes: el.querySelector("#rl-notes").value.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      if (isNew) await addDoc(collection(db, "callings"), { ...data, stamps: { [data.stage]: new Date().toISOString() }, createdAt: serverTimestamp() });
      else {
        if (data.stage !== r.stage) data["stamps." + data.stage] = serverTimestamp();
        await updateDoc(doc(db, "callings", r.id), data);
      }
      closeModal(); toast("Saved");
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
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
    } catch (err) { toast("Couldn't save: " + (err.code || err.message)); }
  });
}
