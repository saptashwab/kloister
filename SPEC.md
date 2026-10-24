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
- My work: everything assigned to the user across their projects, plus their personal tasks, as a list or a status board
- A private personal space per user for personal tasks (boards, buckets, labels, checklists), visible to its owner only
- Selective ADO CSV export and import with reviewed updates and durable item mappings
- Duplicate work items, including one fresh copy per selected person
- Excel snapshots and optional offline file archives of visible work
- A short first-login tour and searchable Help & FAQ
- Theme: admin default + per-user override, admin-set app name and logo
- Admin-controlled Postgres backups and log retention
- Install / upgrade / start / stop scripts for RHEL 8

### v2 (out of scope now; design must not block it)
- Natural-language task parser (llama.cpp on the server), gated by admin per user and per project
- Optional TOTP second factor (no server-sent codes)

### v3 (later; design must not block it)
- Move or copy a personal task into a project (and back)
- When an admin changes the session timeouts, an option to sign everyone out so the new values apply to all sessions at once

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
  "All projects" vs "My projects", that only filters the UI. When an admin opens or reads a project
  they are not a member of, an audit entry `ADMIN_CROSS_PROJECT_ACCESS` is written. From M8.5 reads are
  recorded once per visit: one entry per admin, project and session, and a new one when the last entry for
  that visit is 30 minutes old. Every state-changing request (including refused attempts) and every export
  download is always recorded as its own entry. Entries are never updated.
- **User**: everything else is decided per project.

### 3.2 Project roles

| Action | PM | Lead | Member | Viewer |
|---|---|---|---|---|
| View items (within visibility scope) | ✔ | ✔ | ✔ | ✔ |
| Create items | ✔ | ✔ | ✔ | ✘ |
| Duplicate fully visible items within the same space | ✔ | ✔ | ✔ | ✘ |
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
| ADO import, ID reconciliation and transfer settings | ✔ | ✘ | ✘ | ✘ |
| Excel / offline export of visible data | ✔ | ✔ | ✔ | ✔ |

A project must always have at least one PM; removing or demoting the last PM is rejected.

Duplication requires the ordinary create permission, full visibility of the source and the normal creation,
assignment and destination-scope checks. A title-only ancestor is not a readable source. Excel/offline export
adds no visibility: every included item, related detail and file must be readable by the caller (6.2).

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

### 3.6 Personal spaces
Every user has exactly one personal space: a private project for tasks that belong to no project (finish a training,
submit a reimbursement). It is created on first use.
- Only its owner can see or change anything in it. Nobody else can, system admins included: there is no admin
  cross-project access, no PM assignment, no members, no teams, no assignees other than the owner and no `@mention`.
  Requests from anyone else get 404, as for any project they cannot see (3.4).
- Inside it the owner has the PM rights of 3.2 (buckets, labels, sprints, label style, items, checklists, notes,
  attachments), so it works like any board.
- It never appears in the admin "All projects" list, in another user's "all their work", in ADO export or in the admin
  audit log viewer (its entries are kept for the owner's activity history only).
- Attachments in it count against a per-user quota (5), not a project quota.
- When the owner is deactivated it is kept unchanged and stays hidden; reactivation restores access.
- Privacy is enforced by the app. Server operators with database or file access (including backups) can still read
  it; docs/ADMIN.md says so.

## 4. Data model (Prisma)

All tables have `id` (uuid), `createdAt`, `updatedAt` unless noted.

- **User**: email (unique, lowercased), displayName, passwordHash, systemRole (`ADMIN|USER`),
  mustChangePassword, introductionState (`AWAITING_INITIAL_PASSWORD|READY|DISMISSED|EXEMPT`),
  isActive, failedLoginCount, lockedUntil, themePrefs (json), lastLoginAt
- **Session**: userId, tokenHash, expiresAt, lastSeenAt, userAgent, ip
- **Project**: key (2–6 uppercase chars, unique, used in item numbers like `KLO-42`; null for personal spaces, whose
  items are shown as `#42`), ownerId (nullable, unique; set only for a personal space, its owner), name, description,
  archivedAt, settings (json: membersCanAssignOthers, statusToBucket rules, labelStyle (`SOLID|TINTED|COVER`, default `SOLID`, set by PMs), ado settings)
- **ProjectMember**: projectId, userId, role (`PM|LEAD|MEMBER|VIEWER`), visibility (`ALL|BUCKETS|OWN|TEAMS`),
  allowedBucketIds (uuid[]); unique (projectId, userId)
- **Bucket**: projectId, name, position, onEnterMode (`NONE|SET|SET_IF_NOT_STARTED`), onEnterStatus (nullable)
- **Sprint**: projectId, name, startDate, endDate, state (`PLANNED|ACTIVE|CLOSED`), adoIterationPath (nullable)
- **WorkItem**: projectId, number (per-project sequence), type (`EPIC|FEATURE|STORY|TASK|BUG`), parentId,
  title, description (sanitized HTML), status (`NOT_STARTED|IN_PROGRESS|BLOCKED|DONE`), priority (1–4),
  bucketId (required for STORY/TASK/BUG; optional for EPIC/FEATURE), sprintId, teamId (nullable), startDate,
  dueDate, dueTime (optional minutes after midnight, wall-clock with no time zone; needs a dueDate; M8.5),
  position (fractional index for ordering), createdById, completedAt
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
- PMs and project Leads can add and reorder buckets directly in the board's Bucket
  grouping, with equivalent keyboard controls. Board and Settings share the same
  order and configuration. Newly added board buckets use NONE; rules stay editable
  in Settings. Personal-space owners have the equivalent controls.

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
  - personal spaces have a per-user quota instead, 1 GB by default, admin-configurable next to the project quota
  - inline images are served only to users who can see the item, with `X-Content-Type-Options: nosniff`
- No outbound network calls from the backend at runtime.

---

## 6. Features (frontend)

- **Login / forced password change**
- **Projects list**: the user's projects. Admins also get the All/My toggle. Personal spaces are never listed here.
  From M8.5 each row shows open items, overdue items and last activity counted within the caller's visibility; rows an
  admin sees only through All projects show no counts and are not read.
- **My work** (sidebar): everything assigned to the signed-in user across their unarchived projects, limited by their
  access in each, plus all open items of their personal space.
  - List view (default) grouped by due date: Overdue, Today, This week, Later, No date.
  - Board view with the four statuses as columns (Not started, In progress, Blocked, Done). Buckets are per project and
    are never merged or mapped across projects; each card shows its project (or "Personal") and its bucket as a tag.
    Dragging a card to another column changes its status, which applies that project's `statusToBucket` rule (4.2).
  - Filters: source (All, Projects, Personal), project, type, label and due; an "Also items I created" switch; Done
    items on request; group by project as an option. Clicking a card opens it in its own project or personal space.
  - "View all their work" for another person (below) uses the same list and board views, never includes personal
    items, and is limited by the viewer's access in each project.
- **Personal space** (3.6): its own entry at the top of the sidebar's project list, with the board, backlog, sprints
  and settings of a project (buckets, labels, label style), without members, teams, assignees or ADO export.
- **Board** (main view):
  - columns are buckets, with a Group-by switch: Bucket (default), Status, Assignee, Sprint
  - drag-drop between and within columns
  - filters: assignee, label, sprint, type, due (overdue / this week), text search
  - cards show type icon, key-number, title, labels, assignee avatars (initials), due date and optional due time (red if overdue), checklist progress
  - an item with a due time is overdue once that time has passed; one without a time, from the day after its due date.
    Within one due day, timed items sort first, earliest first, then untimed items, then by priority (M8.5)
  - labels use the project's label style (solid by default; tinted or cover bar), with text contrast chosen automatically
  - hovering an assignee avatar shows their name and email; clicking it filters the board to that person, and
    "View all their work" lists their items across the viewer's own unarchived projects, limited by the viewer's access in
    each. Projects a system admin is not a member of are never included (no cross-project reads, so no
    `ADMIN_CROSS_PROJECT_ACCESS` entries); admins open such projects directly, audited per visit as in 3.1. Non-admins can look up
    only people who share a project with them (404 otherwise)
  - quick-add card at the top of each column
- **Item detail** (side drawer, deep-linkable `/<app>/p/:key/items/:number`):
  title, type, parent picker, status, bucket, sprint, assignees, labels, priority, start and due dates, optional due time,
  description editor (images can be pasted or dropped in; notes too), checklist (add, reorder, tick), notes thread with `@mention`, attachments,
  children list, activity history (from AuditLog)
- **Backlog / hierarchy view**: tree of Epic → Feature → Story → Task with expand/collapse,
  multi-select (also used to choose what to export), bulk set sprint/bucket/assignee
- **Sprints**: create and edit, set active, sprint board (the board filtered to one sprint), close sprint with an option to move unfinished items
- **Project settings** (PM), one tab each from M8.5 (General, Members, Teams, Buckets, Labels): general, members (role and visibility per member), teams (optional), buckets (with rules),
  labels, label style, statusToBucket map, ADO export settings
- **Notifications**: bell with unread count, polled every 60s. Notification types:
  assigned to you, mentioned, due tomorrow, overdue, status change on items you created. Due tomorrow and overdue also
  cover the owner's personal tasks.
  Due-date checks run daily at 09:00 server time.
- **User settings**: display name, password change, theme (mode, primary and accent colour) or "use default"
- **Admin**:
  - users
  - projects
  - branding (app name, logo upload, default theme, UI font: a preset (Figtree (default), Atkinson Hyperlegible, IBM Plex Sans,
    Georgia, Arial) or an uploaded font file; one font for everyone, no per-user override)
  - security (session timeouts, lockout)
  - storage (attachment limits: file size, project quota, personal space quota per user; disk usage of `/app/kloister`)
  - backups (enable, time, retention days, last results, "run now")
  - logs (retention days)
  - audit log viewer with filters

Theming uses CSS custom properties only. Default palette is neutral (slate/indigo). Light and dark mode are both supported.

---

### 6.1 Duplicate work items (M6.8)

- "Duplicate item…" is available in the card actions and drawer actions when the caller may create items and
  fully read the source. Copies stay in the same project or personal space; copying between spaces stays v3.
- The dialog offers one copy per selected person (the selection determines the count), or a number of copies
  with optional assignments. Assignment controls obey the existing assignment permission; users without
  permission to assign others can choose only themselves or unassigned. Personal copies stay owner-only.
- Show a preview of each new title and assignee and an explicit "Create N copies" action before submission.
  Each copy is independent and gets a new item number; the caller is its creator.
- Copy title, description and checklist text, type, priority and labels; reset status to Not started,
  completion and checked checklist lines. Dates and sprint are explicit keep options. An optional parent must
  satisfy the ordinary readable-reference and hierarchy rules. Do not copy notes, activity history,
  dependencies or children. Attachments are opt-in; description images must be usable from the new item,
  independently authorized and included in the existing quota and content checks.
- Multiple assignees continue to share one item's status and checklist. Independent progress needs separate
  tasks, optionally grouped under a Story or Feature; duplication does not add per-assignee progress fields.

### 6.2 Excel snapshots and offline archives (M6.8)

- My work and project screens offer "Export…" in the page header (M8.5): current filtered view or all eligible items in that source
  view, with a preview of scope, filters, item count and included details. "All my work" keeps My work's
  assigned/created-item rules, chosen All/Projects/Personal source, Done option and unarchived-project limits;
  it never becomes a search of every visible project item. "All visible project items" stays inside the
  selected project. The all option removes narrowing project/type/label/due/text filters where applicable,
  while the filtered option keeps them. Export includes every matching page, not just
  the currently loaded page. Personal-space export is owner-only; another person's personal work is never
  included. Archived projects can be read/exported but not duplicated.
- Every project role, including Viewers, may export readable data. ADO export remains PM/Lead only (3.2, 7).
  My work uses the same project-membership and visibility limits as its list, including for admins. Direct
  project exports retain the admin cross-project access auditing, one entry per download (3.1); they never expose personal spaces.
- The .xlsx workbook is a readable snapshot with a Summary sheet (scope, filters, export time), Items sheet
  (hierarchy, all assignees, status, bucket, sprint, team, labels, priority, dates, description and progress),
  and linked sheets for Checklists, Notes, Dependencies, Files and readable activity history. Include related
  details only to the extent the caller may read them. Hidden ancestors remain titles only; hidden item
  references and private audit metadata must not leak through related sheets.
- Use filters, frozen headers, wrapped text, suitable column widths and clear date formatting. Preserve all
  selected readable content without silent truncation, loss of assignees or unreported omissions. Rich-text
  content is readable in Excel; its original formatting/content is retained in the offline archive. User text
  is data, never a spreadsheet formula or macro. Record the snapshot's scope and any limits in its summary.
- "Include files for offline use" downloads a ZIP containing the workbook, readable descriptions/notes with
  their inline images, permitted attachments and an index linking items to files. Access does not depend on
  the running app, and original filenames must not become unsafe archive paths. Generate exports locally on
  the server, without external services; keep libraries out of the initial frontend bundle. These are readable
  snapshots, not a database restore format; existing database and file backups remain necessary.

### 6.3 First-login tour and Help & FAQ (M6.8)

- A skippable, untimed introduction follows the user's first successful required password change. It must
  never run before that change, weaken the password-change restriction, or repeat automatically for later
  sign-ins/password resets. Completing or skipping it dismisses the automatic first-login introduction.
  Existing accounts get manual replay without a forced tour on upgrade. First-login state must be durable
  across browsers. Owner-approved M6.8 representation: one `User.introductionState` enum, default `EXEMPT`
  for all existing accounts on upgrade, including accounts still awaiting password change. Admin creation and
  initial-admin bootstrap explicitly set `AWAITING_INITIAL_PASSWORD`; the first successful required change
  atomically advances it to `READY`. Completion or Skip changes `READY` to `DISMISSED`. Password resets,
  sign-ins and role changes preserve this state. Replay cannot re-enroll an account. An interrupted `READY`
  introduction remains pending; the normal required-password gate always applies.
- The normal path takes no more than 2–3 minutes, with a few brief steps, Back, Next, Skip and a step count.
  Navigate to applicable pages and explain capabilities without creating demo work, changing settings or
  making the user perform real edits. Handle empty projects and missing memberships without dead ends.
- Compose common features (My work, Personal, navigation, board/detail, notifications, export and help) with
  the caller's effective project/team capabilities and independent system Admin capabilities. Members learn
  permitted creation/editing; Viewers get the read-only variant; Leads add their planning/assignment tools;
  PMs add project/member management. Admin status alone never implies PM or Lead rights in projects.
- A person can have different roles in different projects. Use the current project or let them choose one
  they can access; identify the project/team scope of each capability. Include team Lead rights only in their
  relevant team. Replay builds the tour from current permissions, so role changes are reflected without a
  forced replay. Skip inaccessible routes/steps and re-check if permissions change during a tour.
- A sidebar "Help & FAQ" entry opens a searchable, linked how-to page with "Take the tour" for replay. Topics
  include roles/visibility, personal privacy, shared versus separate tasks, duplication, assignment, boards,
  checklist/notes/files, sprints, notifications, themes, keyboard shortcuts, exports and backups. Mark role
  requirements clearly, explain common permission restrictions, and link to actions only when permitted.
  Articles are bundled and available without external services; help explains implemented features only.
- Tour and help are lazy-loaded and follow DESIGN's tokens, keyboard/focus rules and reduced motion. The tour
  has no timeout, covers phone/tablet layouts and never obscures the focused control. Detailed procedures live
  in FAQ articles, not in an expanded first-login tour. ADO instructions are added when M8 implements export.

## 7. ADO CSV transfers (M8; simplified in M8.1)

These transfers are distinct from the existing Excel/offline reading snapshots.
They use operator-carried CSV files, with no ADO API connection or credentials.
M8 implemented both directions. The detailed behavior, file plan, verification and
persistence are in [the M8 plan](docs/M8-PLAN.md); M8.1 adds a quick default review,
fidelity fixes and setup from a sample export, described in [the M8.1 plan](docs/M8.1-PLAN.md).
The concrete storage proposal was approved on 2026-10-16; ask before materially changing it.

### 7.1 Selection modes
- Entire project
- One sprint
- One subtree (an Epic, Feature or Story and everything under it)
- Manual multi-select from the backlog view
- Label filters with match-any or match-all, combined with the selected scope
- Explicit item selection or all eligible items across every matching page

Options:
- **Include ancestors** (default on): adds the parents of selected items so the hierarchy survives
- **Exclude Done items** (default off)
- **Notes in description** (default off)

Preview explicitly lists extra parents and losses. Ordinary selections do not add
children or dependencies; subtree mode explicitly includes descendants. Excluded
items remain untouched and need not exist in ADO. Import also offers all rows or
an explicit subset, with reviewed parent handling and existing-bucket mappings.

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

### 7.3 Profiles and file format

Each ordinary Kloister project has one ADO organization/collection and project
destination. Process and forward/reverse type, state, field and identity mappings
are per project, with Basic/Agile/Scrum/CMMI presets and Custom configuration.
The destination is not exclusive to that Kloister project: avoid a global unique
constraint on the ADO organization/project tuple so a later many-Kloister-to-one-
ADO extension is possible. Cross-project item routing and shared-item editing are
not introduced by M8; every transfer remains scoped to its selected local project.
Do not assume the ADO product/version or process is known, all optional fields are
available, or that board column names equal work-item states. Basic's lossy
flattening is an explicit previewed export transformation; reverse import must
resolve ambiguous types and validate the ordinary hierarchy rules.

- UTF-8 with BOM, comma-separated, RFC 4180 quoting, CRLF line endings
- Generate separate creation and update workflows; profile and mode determine columns:
  1. `ID`: omitted for purely new trees; actual confirmed ADO IDs for updates.
     New children of existing parents use a mixed hierarchy-create file with
     ID-bearing ancestor context rows and empty IDs for new children. Context
     rows preserve freshly reviewed ADO values for every emitted field.
  2. `Work Item Type`
  3. `Title 1` … `Title N`: hierarchy expressed by which Title column holds the title (N = deepest level used)
  4. `Assigned To`: explicit single-assignee mapping using an ADO-recognized identity,
     only in update mode; stage initial assignments for the post-creation pass
  5. `Priority`
  6. `Tags`: label names joined with `; `
  7. `Description`: sanitized HTML, readable checklist/additional-assignee text and
     optional notes, plus a visible issued Kloister reference for ID reconciliation
  8. `Iteration Path`: `sprint.adoIterationPath` if set, else `<project ado iteration root>\<sprint name>`; empty if no sprint
  9. `Area Path`: from project ADO settings; empty if unset
  10. Date columns: configurable per profile/type and omitted until confirmed;
      offer headers such as `Target Date` or `Due Date` without assuming support.
      docs/ADO-EXPORT.md must identify live field compatibility as unverified.
  11. Extra constant columns: project setting, list of (header, value), for org-mandated custom fields
  12. `State`: mapped value in update mode; omitted for initial creation
- Rows ordered depth-first so each child follows its parent
- Maximum 1,000 rows per file. Create exports split only at complete top-level
  boundaries; a single tree over that limit blocks with guidance rather than
  truncating or breaking hierarchy. Flat updates can split by row count. Multiple
  files are delivered in a ZIP, with names identifying create/update mode and batch.
- **Preview step** before download: row count, files, type mapping, and warnings:
  multiple assignees, checklists flattened, attachments not exported, Basic flattening, missing iteration path, rows that would be split
- ADO initially uses its process/type default state; initial state and assignment
  transfer can need a second ID-based update pass. Document this workflow honestly.
- Update files never overwrite remote values Kloister cannot represent (M8.1). A field is
  emitted only when its local value changed since the last confirmed sync; otherwise the
  column is left out, or carries the observed remote cell unchanged where the file needs it.
  Lossy mappings (an assignee or tag mapped to "none", several remote states mapped to one
  status, the profile Area Path, removed embedded images) never write back over remote data.
- Automated tests validate exports against Microsoft's documented import rules:
  `Work Item Type` and a Title column present, IDs appropriate to the mode, at most 1,000 rows per file,
  each child's title one Title column deeper than its parent's, depth-first order, valid UTF-8 with BOM.

### 7.4 Identity, repeated updates and conflicts

- Persist destination-scoped item mappings and pending export intent. A PM brings
  a return ADO CSV containing assigned IDs and Description to confirm initial links.
  A small visible issued reference in Description avoids mandatory custom fields
  or tag creation permissions. If absent, require explicit PM ID matching; never
  match by title or silently create a copy during reconciliation.
- ADO-origin rows map by destination plus ADO ID. Importing the same file again or
  retrying apply must not create duplicates. Do not issue new create files for
  items awaiting returned IDs. Generating/downloading is not confirmation of import.
- Review follows the selected mode (7.6): Quick applies one-sided changes after one summary
  confirmation and asks only about fields changed on both sides; Detailed shows local,
  incoming and confirmed values and requires explicit choices for every difference.
  Revalidate local data/config/permissions before applying a preview. Update files
  use a fresh operator-supplied ADO observation with an explicit freshness warning;
  no live lock or detection of subsequent external edits can be promised.
- A PM supplies/reviews remote CSV observations; Leads can consume them for export
  but cannot perform incoming preview/reconciliation through an export endpoint.
  Validate project provenance when supplied; if the CSV lacks it, require explicit
  destination acknowledgement because IDs alone do not prove file origin.
- CSV cannot stop someone manually reimporting a create file in ADO. Explain that
  limitation and the reconcile-before-update workflow; do not promise automatic sync.
- Missing rows never delete either system's items. Never create user accounts or
  memberships. Unknown assignees require existing-member mapping or an explicit
  unassigned choice. Missing columns preserve values; clearing supplied empty
  values requires review. Preserve fields outside the selected transfer scope.

### 7.5 Incoming data and permissions

- Export is PM/project Lead only; incoming preview/apply, ID linking and settings
  are project PM only. System administrators receive no extra transfer reach.
  Personal spaces are excluded and archived projects accept no transfer writes.
- Support the approved core fields in both directions where configured. Map states
  to Kloister statuses and existing buckets; do not create buckets automatically.
  Validate hierarchy, assignments and every reference using ordinary project rules.
  Labels may be created only through an explicit PM-reviewed mapping choice.
- One ADO assignee must not silently erase additional Kloister assignees. Readable
  checklist/note text is not parsed back into structured entities. Files, embedded
  images, native comments and non-parent dependency links have explicit limitations.
  Imported rich text is sanitized; remote resources are never fetched.
- Verify with synthetic fixtures and documented Microsoft contracts; automated tests
  never contact ADO. From M8.1, fixtures also come from real exports of a disposable
  Azure DevOps Services organization (Agile, Scrum and Basic projects), and generated
  files are imported there by hand through the web UI. The app itself still makes no
  ADO connection. Both directions keep an operator acceptance checklist; compatibility
  with other processes, customized processes and Azure DevOps Server stays unverified
  until an operator runs it.

### 7.6 Review modes (M8.1)

- **Quick** (default for every transfer):
  - Returned rows link automatically when their Description carries a valid issued
    reference for this project and destination. Unknown, duplicate or conflicting
    references still block, and rows without a reference still need a manual match
    or explicit confirmation as new.
  - Fields changed on only one side since the last confirmed sync take that side's
    value. Fields changed on both sides are listed for an explicit keep/take/skip choice.
  - One summary (counts per field and per kind: create, link, update, unchanged) is
    confirmed before apply. Link-only returns never block on unmapped State, Assigned
    To, Tags or Iteration values; they are reported as warnings.
  - After linking, the follow-up update file (State, Assigned To) is offered at once.
- **Detailed** (per-transfer toggle): the M8 review, with explicit choices for every
  difference, manual link confirmation, row selection, three-way values, parent
  omission, label creation and per-item assignee choice. A row that becomes a new item
  has nothing to compare: each value is shown as new from ADO, to take or leave out.
- A project PM may require Detailed review for every transfer in the project.
- Both modes keep the same permissions, idempotency, staleness checks, tombstones and
  "missing rows never delete" rules. Applying incoming changes stays PM-only.
  
---

## 8. API

- REST under `/api/v1`, JSON only. DTO validation with class-validator; types shared via `packages/shared`.
- Pagination is cursor-based on list endpoints.
- Errors use a consistent shape: `{ code, message, details? }`.
- `GET /api/v1/health` returns 200 with no auth required, for scripts.
- An OpenAPI doc is generated at build time into `docs/` (not served in production).

Main groups: `auth`, `me`, `me/work`, `me/personal` (the caller's personal space), `users/:id/work`, `admin/users`, `admin/settings`, `admin/audit`, `admin/backups`,
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
├── data/branding/                     admin-uploaded logo and font files (served by the app, never under the web root)
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

### 9.6 Public getting-started documentation
- M7 adds a root `README.md` describing Kloister, implemented features, release status and license,
  with a couple of representative screenshots using disposable example data and the current UI.
- Include generic download/source installation and run instructions for ordinary users, separate from
  the RHEL automation: supported systems and prerequisites, Node/Postgres setup, dependency install,
  required configuration, migrations, initial administrator creation, build/start, browser access,
  stopping the app and persistent-data locations. Commands must match the delivered code and state
  which shell/platform they apply to; explain any supported-platform limitations honestly.
- Link to detailed INSTALL/UPGRADE/ADMIN guides for RHEL deployment, security, backup and recovery.
  Generic instructions do not change the RHEL release layout or authorize additional deployment
  automation. Do not present future ADO export as shipped before M8.

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
| M6.7 | My work as list and status board across projects (filters, "also items I created", group by project), the same views for "all their work", and the private personal space per user (3.6) with its per-user quota setting, plus the permission tests proving nobody else, admins included, can reach it |
| M6.8 | Same-space item duplication (including one copy per selected person), permission-scoped Excel snapshots and optional offline file archives, a skippable 2–3 minute first-login tour composed from current capabilities, manual replay and searchable sidebar Help & FAQ (6.1–6.3); endpoint permission tests, export-content/file safety tests and browser coverage for roles, first-login/replay, accessibility and responsive screens |
| M7 | Deploy scripts, release workflow, public root README with product overview/screenshots and generic installation/run steps (9.6), INSTALL/UPGRADE/ADMIN docs, end-to-end install test on a RHEL 8 VM (first usable release, v1.0) |
| M7.5 | Reported empty-state/select layout fixes, easier bottom card drops, board bucket creation/reorder, unified searchable user pickers; preserve permissions and add browser regression coverage |
| M8 | Selective ADO CSV export and import, per-project process mappings, durable IDs, reconciliation and reviewed conflicts; documentation-based tests and operator acceptance (v1.1) |
| M8.1 | ADO transfer fidelity fixes, Quick/Detailed review modes (7.6), profile setup from a sample ADO export, readable review screens, preview expiry; fixtures and manual import checks from a disposable Azure DevOps Services organization |
| M8.5 | App-wide UI/UX fixes from the 2026-10-23 review ([plan](docs/M8.5-PLAN.md)): stacked-card phone layouts for wide tables, a readable Audit log, one date picker and date format, Project settings in section tabs, Projects list counts and last activity, a page-actions area for Export…, a lighter My work status control, the drawer's board order, branded sign-in pages, an optional due time; no breaking change, additive API only |

---

## 11. Code conventions
- Every exported class, function, service, guard, controller method and component has a doc comment
  explaining purpose, parameters and any permission implications. Non-obvious logic gets inline comments explaining *why*.
- No hard-coded brand names, colours, hostnames or paths; everything comes from config or settings.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`).
- License: MIT.
