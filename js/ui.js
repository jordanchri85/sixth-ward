// Small shared UI helpers: modal, toast, date formatting.

const backdrop = document.getElementById("modal-backdrop");
let modalEl = document.getElementById("modal");

export function openModal(html) {
  // Replace the modal element with a fresh one on every open. Callers attach
  // delegated listeners directly to the modal element; reusing it would let
  // those listeners pile up across opens (e.g. one "+ Add" click inserting
  // several rows). A fresh element also resets any modal-wide class.
  const fresh = document.createElement("div");
  fresh.id = "modal";
  fresh.className = "modal";
  fresh.innerHTML = html;
  modalEl.replaceWith(fresh);
  modalEl = fresh;
  backdrop.classList.remove("hidden");
  backdrop.scrollTop = 0; // always open at the top, not where the last modal left off
  return modalEl;
}

export function closeModal() {
  backdrop.classList.add("hidden");
  modalEl.innerHTML = "";
}

backdrop.addEventListener("click", (e) => {
  if (e.target === backdrop) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

let toastTimer;
export function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// "2026-08-23" -> "Sun, Aug 23"
export function fmtDate(iso, opts = {}) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    ...(opts.year ? { year: "numeric" } : {}),
  });
}

export function fmtTime(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
