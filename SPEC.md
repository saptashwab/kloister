# Kloister — Product & Technical Specification (v1)

Kloister is a self-hosted Kanban project tracker for teams in restricted corporate
environments: no SSO dependency, no outbound email, no external SaaS. Users get
private, shareable boards with per-project roles and an export to Azure DevOps (ADO)
CSV import format.

The app must never contain any employer name, logo, or brand colour. Branding is
applied after installation through admin theme settings.

---

## 1. Scope

### v1 (this spec)
- Local accounts (email + password), created by admins
- System roles: Admin, User
- Per-project roles: Project Manager, Lead, Member, Viewer, plus a per-member visibility scope
- Optional teams inside a project, with team Leads and Members
- Work items: Epic → Feature → User Story → Task, plus Bug; any level optional
- Kanban board with buckets, status, labels, assignees, due dates, checklists, notes, attachments
- Sprints, backlog/hierarchy view
- In-app notifications only
- ADO CSV export
- Theme: admin default + per-user override, admin-set app name and logo
- Admin-controlled Postgres backups and log retention
- Install / upgrade / start / stop scripts for RHEL 8

### v2 (out of scope now; design must not block it)
- Natural-language task parser (llama.cpp on the server), gated by admin per user and per project
- Optional TOTP second factor (no server-sent codes)

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js current Active LTS, app-local in `/app/kloister/runtime/` |
| Backend | NestJS on the Fastify adapter, TypeScript strict |
| ORM / migrations | Prisma |
| Database | PostgreSQL, latest major from PGDG for EL8 (`PG_MAJOR` is an install setting) |
| Frontend | Angular (current major), standalone components, signals, Angular Material, Angular CDK drag-drop |
| Password hashing | argon2id (`argon2` npm package; falls back to `@node-rs/argon2` if the native build fails on RHEL 8) |
| Logging | pino, daily-rotated files |
| Scheduling | `@nestjs/schedule` (backups, due-date notifications, log cleanup) |
| Tests | Backend: Jest (Nest default). Frontend: the Angular CLI default runner |

Repository layout (npm workspaces):

```
kloister/
├── apps/api/          NestJS backend
├── apps/web/          Angular frontend
├── packages/shared/   Shared TS types: DTOs, enums, permission names
├── deploy/            install.sh, upgrade.sh, start/stop/status, enable-service.sh, httpd conf template
├── docs/              INSTALL.md, UPGRADE.md, ADMIN.md, ADO-EXPORT.md
├── .github/workflows/ CI + release packaging
└── SPEC.md
```

---

## 3. Roles and permissions

### 3.1 System roles
- **Admin**: manages users (create, deactivate, reset password, promote to Admin), creates projects
  with one or more PMs, assigns, reassigns or removes PMs in any existing project at any time (a project
  may have several PMs; the last active PM rule in 3.2 still applies), edits app settings, views the audit log. Has a header toggle,
  "All projects" vs "My projects", that only filters the UI. Every time an admin opens or reads a project
  they are not a member of, an audit entry `ADMIN_CROSS_PROJECT_ACCESS` is written.
- **User**: everything else is decided per project.

### 3.2 Project roles

| Action | PM | Lead | Member | Viewer |
|---|---|---|---|---|
| View items (within visibility scope) | ✔ | ✔ | ✔ | ✔ |
| Create items | ✔ | ✔ | ✔ | ✘ |
| Edit any item | ✔ | ✔ | ✘ | ✘ |
| Edit items assigned to or created by self | ✔ | ✔ | ✔ | ✘ |
| Assign items to others | ✔ | ✔ | Project setting (default off) | ✘ |
| Move cards between buckets | ✔ | ✔ | Own/assigned only | ✘ |
| Delete items | ✔ | ✔ | Own created, no children | ✘ |
| Notes and attachments on visible items | ✔ | ✔ | ✔ | ✘ |
| Manage buckets, labels, sprints | ✔ | ✔ | ✘ | ✘ |
| Manage members, roles, visibility | ✔ | ✘ | ✘ | ✘ |
| Project settings, ADO settings, archive project | ✔ | ✘ | ✘ | ✘ |
| ADO export | ✔ | ✔ | ✘ | ✘ |

A project must always have at least one PM; removing or demoting the last PM is rejected.

### 3.3 Visibility scope (Member and Viewer only; PM and Lead always see everything)
- `ALL`: every item in the project
- `BUCKETS`: items in the buckets the PM selected
- `OWN`: items assigned to or created by the user
- `TEAMS`: items of the teams the user belongs to (3.5)

With `BUCKETS`, `OWN` and `TEAMS`, the ancestors (Story/Feature/Epic) of visible items are shown
**as read-only titles only**, so users keep context.

### 3.4 Enforcement rules
- All authorization is enforced in the API, through Nest guards plus a single
  `ProjectAccessService` that builds the visibility filter into every query.
  The frontend only hides controls.
- Items outside a user's scope return **404**, not 403, so their existence is not revealed.
- Every permission row in 3.2, every scope in 3.3 and every team rule in 3.5 must have a backend test.

### 3.5 Teams (optional)
Teams let a PM plan a project in more detail; a project works fully without any.
- PMs create, rename and delete teams and manage their members. Nobody else does, including team Leads.
- Every team member must be a member of the project; leaving the project removes the user from its teams.
  A user may belong to several teams in a project, with a role per team: `LEAD` or `MEMBER`.
  A team may have several Leads, and a user may lead one team and be a member of another.
- A project Viewer may be a team Member but not a team Lead.
- A work item belongs to at most one team (optional). Parent/child links and dependencies may cross teams.
- The project role is the baseline. A team Lead additionally has the Lead rights of 3.2 (view, edit, move,
  assign, delete) on the items of the teams they lead, whatever their visibility scope. Cascading deletes
  stay with project PMs and Leads.

---

## 4. Data model (Prisma)

All tables have `id` (uuid), `createdAt`, `updatedAt` unless noted.

- **User**: email (unique, lowercased), displayName, passwordHash, systemRole (`ADMIN|USER`),
  mustChangePassword, isActive, failedLoginCount, lockedUntil, themePrefs (json), lastLoginAt
- **Session**: userId, tokenHash, expiresAt, lastSeenAt, userAgent, ip
- **Project**: key (2–6 uppercase chars, unique, used in item numbers like `KLO-42`), name, description,
  archivedAt, settings (json: membersCanAssignOthers, statusToBucket rules, labelStyle (`SOLID|TINTED|COVER`, default `SOLID`, set by PMs), ado settings)
- **ProjectMember**: projectId, userId, role (`PM|LEAD|MEMBER|VIEWER`), visibility (`ALL|BUCKETS|OWN|TEAMS`),
  allowedBucketIds (uuid[]); unique (projectId, userId)
- **Bucket**: projectId, name, position, onEnterMode (`NONE|SET|SET_IF_NOT_STARTED`), onEnterStatus (nullable)
- **Sprint**: projectId, name, startDate, endDate, state (`PLANNED|ACTIVE|CLOSED`), adoIterationPath (nullable)
- **WorkItem**: projectId, number (per-project sequence), type (`EPIC|FEATURE|STORY|TASK|BUG`), parentId,
  title, description (sanitized HTML), status (`NOT_STARTED|IN_PROGRESS|BLOCKED|DONE`), priority (1–4),
  bucketId (required for STORY/TASK/BUG; optional for EPIC/FEATURE), sprintId, teamId (nullable), startDate,
  dueDate, position (fractional index for ordering), createdById, completedAt
- **WorkItemAssignee**: workItemId, userId (many-to-many)
- **WorkItemDependency**: blockedItemId, blockingItemId (same project, may cross teams; no cycles)
- **Team**: projectId, name (unique per project), description
- **TeamMember**: teamId, userId, role (`LEAD|MEMBER`); unique (teamId, userId); the user must be a project member
- **Label**: projectId, name, colour; **WorkItemLabel**: join table
- **ChecklistItem**: workItemId, text, done, position
- **Note**: workItemId, authorId, body (sanitized HTML), editedAt
- **Attachment**: workItemId, uploaderId, originalName, storedName, sizeBytes, mimeType, sha256, inline (true for images pasted or dropped into a description or note; these are not listed as attachments)
- **Notification**: userId, type, workItemId, actorId, readAt
- **AuditLog**: actorId, action, entityType, entityId, projectId, meta (json), createdAt only
- **AppSetting**: key (unique), value (json)

### 4.1 Hierarchy rules
- Allowed parents: FEATURE→EPIC; STORY→FEATURE; TASK→STORY|FEATURE; BUG→STORY|FEATURE. Any item may have no parent.
- No cycles. A parent must be in the same project.
- Deleting an item that has children is rejected unless `?cascade=true` (PM/Lead only).

### 4.2 Bucket ↔ status rules
- Status and bucket are independent fields.
- Moving a card into a bucket applies that bucket's rule:
  - `NONE`: no change
  - `SET`: set status to `onEnterStatus`
  - `SET_IF_NOT_STARTED`: set it only if the current status is `NOT_STARTED`
- Project setting `statusToBucket` (optional map of status → bucketId): when status changes
  (from the detail view), the card moves to the mapped bucket.
- Rules are applied server-side in one transaction; the response returns the final bucket and status.
- Checklists show progress (`3/7`) and never change status.
- A new project gets default buckets: Backlog (NONE), To Do (NONE), In Progress
  (SET_IF_NOT_STARTED → IN_PROGRESS), Done (SET → DONE). The PM can edit or remove them.

---

## 5. Authentication and security

- Login with email and password. Password hashing uses argon2id with library-recommended parameters.
- Server-side sessions stored in Postgres. The session cookie is `httpOnly`, `Secure`, `SameSite=Strict`,
  `Path=/<app_name>/`. Idle timeout 8h and absolute timeout 7d, both admin-configurable.
- CSRF protection: SameSite=Strict plus a required `X-Requested-With: kloister` header on state-changing requests.
- Lockout after 5 failed logins for 15 minutes (configurable), plus per-IP rate limiting on `/auth/login`.
- Password policy: minimum 12 characters; no other composition rules.
- When an admin creates a user or resets a password, a random temporary password is shown **once** in the UI;
  `mustChangePassword=true` forces a change on next login.
- Password changes and resets invalidate the user's other sessions.
- Rich text is sanitized server-side against an allow-list. Images are allowed only when their source is the app's own inline-image endpoint for the same item; only PNG, JPEG, GIF and WebP are accepted (never SVG).
- Attachment rules:
  - stored as `/app/kloister/data/attachments/<projectId>/<uuid>`, never under the web root
  - served via an authenticated endpoint with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`
  - max file size 25 MB and per-project quota 2 GB by default, both admin-configurable; inline images use the same size limit and count toward the quota
  - inline images are served only to users who can see the item, with `X-Content-Type-Options: nosniff`
- No outbound network calls from the backend at runtime.

---

## 6. Features (frontend)

- **Login / forced password change**
- **Projects list**: the user's projects. Admins also get the All/My toggle.
- **Board** (main view):
  - columns are buckets, with a Group-by switch: Bucket (default), Status, Assignee, Sprint
  - drag-drop between and within columns
  - filters: assignee, label, sprint, type, due (overdue / this week), text search
  - cards show type icon, key-number, title, labels, assignee avatars (initials), due date (red if overdue), checklist progress
  - labels use the project's label style (solid by default; tinted or cover bar), with text contrast chosen automatically
  - hovering an assignee avatar shows their name and email; clicking it filters the board to that person, and
    "View all their work" lists their items across the viewer's own unarchived projects, limited by the viewer's access in
    each. Projects a system admin is not a member of are never included (no cross-project reads, so no
    `ADMIN_CROSS_PROJECT_ACCESS` entries); admins open such projects directly, audited as in 3.1. Non-admins can look up
    only people who share a project with them (404 otherwise)
  - quick-add card at the top of each column
- **Item detail** (side drawer, deep-linkable `/<app>/p/:key/items/:number`):
  title, type, parent picker, status, bucket, sprint, assignees, labels, priority, start and due dates,
  description editor (images can be pasted or dropped in; notes too), checklist (add, reorder, tick), notes thread with `@mention`, attachments,
  children list, activity history (from AuditLog)
- **Backlog / hierarchy view**: tree of Epic → Feature → Story → Task with expand/collapse,
  multi-select (also used to choose what to export), bulk set sprint/bucket/assignee
- **Sprints**: create and edit, set active, sprint board (the board filtered to one sprint), close sprint with an option to move unfinished items
- **Project settings** (PM): general, members (role and visibility per member), teams (optional), buckets (with rules),
  labels, label style, statusToBucket map, ADO export settings
- **Notifications**: bell with unread count, polled every 60s. Notification types:
  assigned to you, mentioned, due tomorrow, overdue, status change on items you created.
  Due-date checks run daily at 09:00 server time.
- **User settings**: display name, password change, theme (mode, primary and accent colour) or "use default"
- **Admin**:
  - users
  - projects
  - branding (app name, logo upload, default theme, UI font: a preset (Figtree (default), Atkinson Hyperlegible, IBM Plex Sans,
    Georgia, Arial) or an uploaded font file; one font for everyone, no per-user override)
  - security (session timeouts, lockout)
  - storage (attachment limits, disk usage of `/app/kloister`)
  - backups (enable, time, retention days, last results, "run now")
  - logs (retention days)
  - audit log viewer with filters

Theming uses CSS custom properties only. Default palette is neutral (slate/indigo). Light and dark mode are both supported.

---

## 7. ADO CSV export

### 7.1 Selection modes
- Entire project
- One sprint
- One subtree (an Epic, Feature or Story and everything under it)
- Manual multi-select from the backlog view

Options:
- **Include ancestors** (default on): adds the parents of selected items so the hierarchy survives
- **Exclude Done items** (default off)
- **Notes in description** (default off)

### 7.2 Process presets (type mapping)

| Kloister | Agile | Scrum | CMMI | Basic |
|---|---|---|---|---|
| EPIC | Epic | Epic | Epic | Epic |
| FEATURE | Feature | Feature | Feature | Epic* |
| STORY | User Story | Product Backlog Item | Requirement | Issue |
| TASK | Task | Task | Task | Task |
| BUG | Bug | Bug | Bug | Issue |

\* Basic has only three levels. Under Basic, EPIC items are flattened (omitted, with their children promoted),
and the export preview lists this as a warning.

### 7.3 File format
- UTF-8 with BOM, comma-separated, RFC 4180 quoting, CRLF line endings
- Columns, in order:
  1. `ID`: always empty, so ADO creates new items
  2. `Work Item Type`
  3. `Title 1` … `Title N`: hierarchy expressed by which Title column holds the title (N = deepest level used)
  4. `Assigned To`: email of the first assignee
  5. `Priority`
  6. `Tags`: label names joined with `; `
  7. `Description`: HTML; description + checklist rendered as `<ul>` with ☐/☑ + other assignees' names + optional notes
  8. `Iteration Path`: `sprint.adoIterationPath` if set, else `<project ado iteration root>\<sprint name>`; empty if no sprint
  9. `Area Path`: from project ADO settings; empty if unset
  10. Due date column: header configurable per project. Default `Target Date`, alternative `Due Date`, or omitted.
      This mapping is unverified against a live ADO import. docs/ADO-EXPORT.md must say so and ask users to report field mismatches.
  11. Extra constant columns: project setting, list of (header, value), for org-mandated custom fields
- Rows ordered depth-first so each child follows its parent
- Maximum 1,000 rows per file. Larger exports are split only at top-level boundaries (a tree is never split across files)
  and delivered as a zip `kloister-<key>-<yyyymmdd-hhmm>-partN.csv`.
- **Preview step** before download: row count, files, type mapping, and warnings:
  multiple assignees, checklists flattened, attachments not exported, Basic flattening, missing iteration path, rows that would be split
- ADO imports everything with State = New. This is documented in `docs/ADO-EXPORT.md`.
- Automated tests validate exports against Microsoft's documented import rules:
  `Work Item Type` and a Title column present, `ID` empty, at most 1,000 rows per file,
  each child's title one Title column deeper than its parent's, depth-first order, valid UTF-8 with BOM.
  
---

## 8. API

- REST under `/api/v1`, JSON only. DTO validation with class-validator; types shared via `packages/shared`.
- Pagination is cursor-based on list endpoints.
- Errors use a consistent shape: `{ code, message, details? }`.
- `GET /api/v1/health` returns 200 with no auth required, for scripts.
- An OpenAPI doc is generated at build time into `docs/` (not served in production).

Main groups: `auth`, `me`, `users/:id/work`, `admin/users`, `admin/settings`, `admin/audit`, `admin/backups`,
`projects`, `projects/:id/members`, `projects/:id/teams`, `buckets`, `labels`, `sprints`, `items` (+ `/move`, `/checklist`,
`/notes`, `/attachments`, `/children`), `notifications`, `projects/:id/export/ado` (+ `/preview`).

---

## 9. Deployment (RHEL 8.10)

### 9.1 Layout

```
/var/www/html/<app_name>/            Angular build only
/app/<app_name>/
├── backend/                          compiled backend + package.json + lockfile + prisma; npm ci runs here
├── backend.previous/                 previous version, kept by upgrade.sh for rollback
├── runtime/node-v<ver>-linux-x64/    app-local Node
├── config/kloister.env               chmod 600, owner <app_name>
├── config/.pgpass                    chmod 600
├── data/attachments/
├── backups/postgres/                 <app_name>-<yyyymmdd-hhmmss>.dump (pg_dump -Fc)
├── logs/backend/backend-<yyyy-mm-dd>.log
├── logs/backups/backup-<yyyy-mm-dd>.log
├── logs/install/<install|upgrade>-<yyyymmdd-hhmmss>.log
├── run/backend.pid
└── scripts/                          start.sh, stop.sh, status.sh, enable-service.sh
```

Postgres binaries and data stay in standard PGDG locations (`/usr/pgsql-<ver>`, `/var/lib/pgsql/<ver>/data`).

### 9.2 Release package
- GitHub Actions on tag `v*` builds `kloister-<ver>.zip` containing `backend/` (compiled, no node_modules),
  `frontend/` (Angular dist), `deploy/`, `docs/`.
- The Angular build uses base href `/__KLOISTER_BASE__/`; the install script replaces it in `index.html`.
- The frontend calls the API with relative URLs only.

### 9.3 Script rules (apply to every script)
- Bash, `set -euo pipefail`, every step commented (what, why, how to check if it fails)
- Every action logged to `logs/install/…`
- Idempotent: re-running is safe
- Settings come from `deploy/install.conf` (APP_NAME, PG_MAJOR, PG_PORT, NODE_VERSION, BACKEND_PORT=3000); no interactive questions except confirmations
- **Never** modify firewalld, SELinux booleans, or httpd config other than the one conf file below.
  When a needed SELinux boolean is off, print a warning with the exact command and continue.
- **Never** touch existing Postgres clusters (`/var/lib/pgsql/13`, `/var/lib/pgsql/14`) or existing Node installations
- **Never** auto-enable Kloister systemd services
- The backend never runs as root

### 9.4 `install.sh` (run as root)
1. Check OS is EL8, check free disk space (warn below 5 GB)
2. Create a non-login system user `<app_name>` and the `/app/<app_name>` tree
3. Node: use `node-*.tar.xz` from the release folder if present (for VMs that cannot reach nodejs.org),
   else download it; verify its SHA256 and unpack into `runtime/`
4. Postgres, only if `/usr/pgsql-<PG_MAJOR>/bin/postgres` is missing:
   - add the PGDG repo
   - `dnf -qy module disable postgresql`
   - install the server package
   - `initdb`
   - set the port
   - enable and start `postgresql-<PG_MAJOR>` (the standard PGDG service, which runs as `postgres`)
5. Create the database role and database with a random password, then write `kloister.env` and `.pgpass`
6. Copy `backend/`, run `npm ci --omit=dev` as `<app_name>`, run `prisma migrate deploy`
7. Copy the frontend to `/var/www/html/<app_name>/` and replace the base href
8. Write `/etc/httpd/conf.d/<app_name>.conf` from the template, then run `apachectl configtest`.
   If it passes, run `systemctl reload httpd`. If it fails, remove the new conf file, leave httpd untouched,
   and print the configtest error. The template contains only:
   - `ProxyPass` / `ProxyPassReverse` for `/<app_name>/api/` → `http://127.0.0.1:<BACKEND_PORT>/api/`
   - `<Directory "/var/www/html/<app_name>">` with `FallbackResource /<app_name>/index.html`
   - no VirtualHost and no TLS settings (it inherits the existing httpd setup)
9. Check `getsebool httpd_can_network_connect`; if it is off, print a warning and the exact command
10. Create the first admin, print the temporary password once, and never write it to a file
11. Start the backend via `scripts/start.sh` and check `/api/v1/health`

### 9.5 Other scripts
- `upgrade.sh`:
  1. pre-upgrade `pg_dump`
  2. stop the backend
  3. move `backend/` to `backend.previous/`
  4. copy the new backend, `npm ci`, run migrations
  5. replace the frontend
  6. start, then health check
  7. on failure, print rollback steps
- `start.sh`, `stop.sh`, `status.sh`: run as `<app_name>`, use the PID file, log to `logs/backend/`
- `enable-service.sh` (opt-in, manual): installs `<app_name>-backend.service` with `User=<app_name>` and `Restart=on-failure`
- `logs/backend` rotation and cleanup are done by the app itself according to the admin's retention setting

---

## 10. Build milestones (each ends with tests passing and a commit)

| # | Milestone |
|---|---|
| M0 | Repo scaffold, workspaces, lint/format, CI |
| M1 | Auth, users, sessions, admin bootstrap command, audit log |
| M2 | Projects, members, roles, optional teams, visibility enforcement plus the full permission test matrix |
| M3 | Work items, hierarchy, dependencies, team assignment, buckets and rules, labels, checklists, sprints (API) |
| M4 | Board, item drawer, backlog tree, sprint views (UI) |
| M4.5 | Design foundation: the owner-approved design direction recorded in `docs/DESIGN.md`; design tokens (colour, type, spacing, radius, elevation) as CSS custom properties that M6 theming builds on; a bundled UI font and SVG icon set (nothing loaded from external hosts); app shell (sidebar with project switcher, header, user menu); shared feedback components (toasts with undo, styled confirm dialogs, empty states, loading skeletons); prominent coloured labels (curated palette plus custom colour, automatic text contrast, per-project label style); inline editing in the item drawer; assignee avatars with hover card, board filter and the cross-project "all their work" list (with its API endpoint and permission tests); the M1–M4 screens rebuilt on the foundation, with browser-test screenshots for review |
| M5 | Notes, mentions, attachments, images pasted or dropped into descriptions and notes, notifications |
| M6 | Theming and branding (including the UI font), admin settings, backups, log retention, disk usage |
| M6.5 | Polish pass over every screen, reviewed from the browser-test screenshots: consistency, accessibility (WCAG 2.2 AA: keyboard, focus, contrast, screen readers, reduced motion), layouts at phone and tablet width, motion, keyboard shortcuts and a command palette, large-board performance |
| M7 | Deploy scripts, release workflow, INSTALL/UPGRADE/ADMIN docs, end-to-end install test on a RHEL 8 VM (first usable release, v1.0) |
| M8 | ADO export plus preview, validated by tests against the documented import rules (v1.1) |

---

## 11. Code conventions
- Every exported class, function, service, guard, controller method and component has a doc comment
  explaining purpose, parameters and any permission implications. Non-obvious logic gets inline comments explaining *why*.
- No hard-coded brand names, colours, hostnames or paths; everything comes from config or settings.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`).
- License: MIT.