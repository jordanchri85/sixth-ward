# 6th Ward

A small web app for ward organization: tasks, sacrament meeting planning, a
calendar, callings tracking, and a bishop-only confidential notes area.

- **Hosting:** GitHub Pages (static site, no build step)
- **Database & auth:** Firebase (project `sixth-ward-app`) — Firestore + Google sign-in
- **Permissions:** roles stored in `users/{uid}.role`, enforced by `firestore.rules`
  - `pending` — signed in but no access until approved
  - `member` — tasks, sacrament plans, calendar; can update own tasks, add events
  - `bishopric` — everything above plus edit rights and the Callings tab
  - `bishop` — everything, including the 🔒 Confidential tab and the People (roles) page

## Structure

```
index.html          app shell (login, tabs)
css/style.css       styles
js/firebase-init.js Firebase config (public identifiers; security is in the rules)
js/app.js           auth flow, role gating, tab routing
js/tasks.js         Tasks tab
js/sacrament.js     Sacrament Meeting planner
js/calendar.js      Calendar tab
js/callings.js      Callings tab (bishopric+)
js/confidential.js  Confidential tab (bishop only)
js/admin.js         People/roles tab (bishop only)
firestore.rules     Firestore security rules  ← the real permission boundary
```

## Deploying changes

- **Site:** push to `main`; GitHub Pages serves it automatically.
- **Security rules:** `firebase deploy --only firestore:rules`

## Notes

- The confidential tab is protected server-side: the `confidential` collection is
  readable/writable only by the bishop role (or the bishop's email), so hiding the
  tab is cosmetic — the data itself is locked down.
- New users sign in with Google, land in a "waiting for approval" state, and the
  bishop assigns their role on the People tab.
