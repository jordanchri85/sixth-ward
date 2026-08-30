// App shell: auth flow, role gating, tab routing.
import { auth, db, googleProvider, BISHOP_EMAIL } from "./firebase-init.js?v=1788120890";
import {
  signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { initTasks } from "./tasks.js?v=1788120890";
import { initSacrament } from "./sacrament.js?v=1788120890";
import { initCalendar } from "./calendar.js?v=1788120890";
import { initCallings } from "./callings.js?v=1788120890";
import { initConfidential } from "./confidential.js?v=1788120890";
import { initAdmin } from "./admin.js?v=1788120890";

const ROLE_RANK = { pending: 0, member: 1, bishopric: 2, bishop: 3 };

// current signed-in user's context, shared with all tab modules
export const ctx = { uid: null, name: null, email: null, role: null };

export function hasRole(minRole) {
  return (ROLE_RANK[ctx.role] ?? 0) >= (ROLE_RANK[minRole] ?? 0);
}

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

// ---- Sign in / out ----
$("btn-google-signin").addEventListener("click", async () => {
  hide("login-error");
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    const el = $("login-error");
    el.textContent = "Sign-in failed: " + (err.code || err.message);
    el.classList.remove("hidden");
  }
});
$("btn-signout").addEventListener("click", () => signOut(auth));
$("btn-signout-pending").addEventListener("click", () => signOut(auth));

// ---- Auth state ----
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    hide("app"); hide("pending-screen"); show("login-screen");
    return;
  }
  ctx.uid = user.uid;
  ctx.name = user.displayName || user.email;
  ctx.email = user.email;

  // Ensure a users/{uid} profile doc exists; new accounts start as "pending".
  const uref = doc(db, "users", user.uid);
  let snap;
  try {
    snap = await getDoc(uref);
  } catch {
    snap = null;
  }
  if (!snap || !snap.exists()) {
    const initialRole = user.email === BISHOP_EMAIL ? "bishop" : "pending";
    try {
      await setDoc(uref, {
        name: ctx.name,
        email: user.email,
        photo: user.photoURL || "",
        role: initialRole,
        createdAt: serverTimestamp(),
      });
      ctx.role = initialRole;
    } catch {
      ctx.role = "pending";
    }
  } else {
    ctx.role = snap.data().role || "pending";
    // the bishop's email is always bishop, even if the doc says otherwise
    if (user.email === BISHOP_EMAIL) ctx.role = "bishop";
  }

  if (ctx.role === "pending") {
    hide("login-screen"); hide("app"); show("pending-screen");
    return;
  }

  // ---- Enter the app ----
  hide("login-screen"); hide("pending-screen"); show("app");
  $("user-name").textContent = ctx.name;
  const photo = $("user-photo");
  if (user.photoURL) { photo.src = user.photoURL; photo.classList.remove("hidden"); }
  else photo.classList.add("hidden");

  // hide tabs above the user's role
  document.querySelectorAll("#main-tabs .tab").forEach((t) => {
    const min = t.dataset.minrole;
    t.classList.toggle("hidden", !!min && !hasRole(min));
  });

  initTasks();
  initSacrament();
  initCalendar();
  if (hasRole("bishopric")) initCallings();
  if (hasRole("bishop")) { initConfidential(); initAdmin(); }

  selectTab(localStorage.getItem("sw-tab") || "tasks");
});

// ---- Tabs ----
function selectTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!tab || tab.classList.contains("hidden")) name = "tasks";
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) =>
    p.classList.toggle("hidden", p.id !== "panel-" + name));
  localStorage.setItem("sw-tab", name);
}
document.getElementById("main-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) selectTab(tab.dataset.tab);
});
