# Security and permissions

How Kloister authenticates people and decides what each of them may see and change. The rules
come from [SPEC.md](../../SPEC.md) §3 and §5; this document describes how the code applies them.
The per-route requirements are listed in the [API reference](API.md).

## Principles

- **Authorization lives in the API.** The web app hides controls a person cannot use, but every
  request is checked again on the server. The web app's capability helpers (`permissionsFor` from
  `packages/shared`, the `can` flags on items) are for display only.
- **Hidden means 404.** Projects a person is not a member of, and items outside their visibility
  scope, answer 404 `NOT_FOUND`, never 403, so their existence is not disclosed. 403 is used only
  when the person can already see the thing but may not do what they asked.
- **Everything is audited.** Every change writes an `AuditLog` entry in the same transaction as
  the change, so one never exists without the other. Security events without a change to save
  (failed sign-ins, lockouts) are recorded on their own. The one unaudited change is reordering a
  card inside its bucket.
- **No outbound calls.** The backend never contacts another host at runtime: no email, no
  webhooks, no single sign-on, no update checks, no remote images. Prisma's update check is turned
  off with `CHECKPOINT_DISABLE=1`.

## Accounts and passwords

- Accounts are created by system administrators only; there is no self sign-up. The first
  administrator is created on the server with the `create-admin` command
  (`apps/api/src/cli/create-admin.ts`).
- Passwords are hashed with argon2id using the library's recommended parameters
  (`apps/api/src/auth/password.service.ts`); hashes needing an upgrade are rehashed at the next
  sign-in. The minimum length is 12 characters with no other composition rules
  (`PASSWORD_MIN_LENGTH`).
- A new account or a reset password gets a random temporary password, shown once to the
  administrator. `mustChangePassword` then limits the account to the routes marked "Also allowed
  while the temporary password still has to be changed" until it is replaced; everything else
  answers 403 `PASSWORD_CHANGE_REQUIRED`.
- Changing or resetting a password ends the user's other sessions.
- Lockout: each wrong password counts; reaching the threshold (default 5) locks the account for the
  configured period (default 15 minutes). Unknown, deactivated and locked accounts fail with the
  same error (`INVALID_CREDENTIALS`) and similar timing. Sign-in is also rate limited per client
  address (`LOGIN_RATE_LIMIT` attempts per `LOGIN_RATE_WINDOW_SECONDS`, default 10 per 60 seconds),
  answering 429 with `Retry-After`. The client address comes from `X-Forwarded-For` only when the
  proxy is trusted (`TRUST_PROXY`, default loopback, since httpd runs on the same host).

## Sessions and CSRF

- Sessions are stored in PostgreSQL (`Session`). The cookie `sid` holds a random token; the
  database stores only its SHA-256 hash.
- Cookie attributes: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/<app_name>/` (from
  `APP_NAME`; `/` in local development only, and production refuses to start without `APP_NAME`).
- Timeouts: idle (default 8 hours) and absolute (default 7 days), both admin settings. A changed
  absolute timeout applies to new sign-ins. The live-update routes (`/api/v1/events`, marked
  `@KeepSessionIdle()` in the code) need a live session but do not extend it.
- The global guards (registered in `apps/api/src/auth/auth.module.ts`) run on every route: the
  CSRF guard first, then the session guard. Routes are private unless marked `@Public()`; only health, sign-in
  and the public branding routes are.
- CSRF: besides `SameSite=Strict`, every request that is not GET, HEAD or OPTIONS must carry
  `X-Requested-With: kloister` (403 `CSRF_HEADER_MISSING` otherwise). Browsers cannot add a custom
  header to a cross-site form post, and a cross-origin `fetch` with it needs a CORS preflight, which
  the API does not answer (CORS is not enabled).

## System roles

| Role    | What it adds                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------- |
| `ADMIN` | User administration, project creation, PM assignment in every project, app settings, holidays, backups, the audit log |
| `USER`  | Nothing beyond what project memberships grant                                                                         |

Routes under `/api/v1/admin` carry `@AdminOnly()` and answer 403 to everyone else.

An administrator who is **not** a member of a project gets read-only access to it plus the right
to assign PMs, so a project left without a PM can be recovered. Every such access is recorded as
`ADMIN_CROSS_PROJECT_ACCESS`: reads once per visit (one entry per administrator, project and
session, renewed when the last one is 30 minutes old), and every write, refused write and export
download as its own entry. Administrators who are members are bound by their membership like
anyone else, except that every administrator also holds `ASSIGN_PMS`. Personal spaces are outside all of this (see below).

## Project roles and permissions

Project routes are guarded by `ProjectAccessGuard`
(`apps/api/src/projects/project-access.guard.ts`):

1. The project is resolved by uuid or key. Non-members get 404 (administrators: see above).
2. The route's `@RequireProjectPermission(...)` names the permission it needs; a route without one
   fails closed. A caller without it gets 403.
3. Writes to an archived project answer 409 `PROJECT_ARCHIVED`, except the routes that unarchive
   or let an administrator recover PMs.

Roles grant these permissions (`packages/shared/src/projects.ts`, the table in SPEC §3.2):

| Permission         | PM  | Lead | Member                        | Viewer |
| ------------------ | --- | ---- | ----------------------------- | ------ |
| `VIEW_ITEMS`       | yes | yes  | yes                           | yes    |
| `CREATE_ITEMS`     | yes | yes  | yes                           |        |
| `EDIT_ANY_ITEM`    | yes | yes  |                               |        |
| `EDIT_OWN_ITEMS`   | yes | yes  | yes                           |        |
| `ASSIGN_OTHERS`    | yes | yes  | when `membersCanAssignOthers` |        |
| `MOVE_ANY_ITEM`    | yes | yes  |                               |        |
| `MOVE_OWN_ITEMS`   | yes | yes  | yes                           |        |
| `DELETE_ANY_ITEM`  | yes | yes  |                               |        |
| `DELETE_OWN_ITEMS` | yes | yes  | yes                           |        |
| `ANNOTATE_ITEMS`   | yes | yes  | yes                           |        |
| `MANAGE_BOARD`     | yes | yes  |                               |        |
| `MANAGE_MEMBERS`   | yes |      |                               |        |
| `ASSIGN_PMS`       | yes |      |                               |        |
| `MANAGE_PROJECT`   | yes |      |                               |        |
| `EXPORT_ADO`       | yes | yes  |                               |        |
| `IMPORT_ADO`       | yes |      |                               |        |

System administrators also hold `VIEW_ITEMS` and `ASSIGN_PMS` in every ordinary project.

The route permission is only the first check. `ProjectAccessService`
(`apps/api/src/projects/project-access.service.ts`) then decides per item:

- **View**: inside the caller's visibility scope, or an item of a team the caller leads.
- **Edit**: view, plus `EDIT_ANY_ITEM`, or `EDIT_OWN_ITEMS` on an item the caller created or is
  assigned to, or leading the item's team.
- **Plan** (title, type, parent, sprint, dates, half days, pin, dependencies of an existing item):
  edit, plus, while the project setting `planLeadsOnly` is on (the default), `EDIT_ANY_ITEM`,
  leading the item's team, or having created the item while it is not yet scheduled (no dates, no
  sprint, no link or child the caller can see). Members set these fields freely when creating.
  A Member who may not plan an item can post a "suggest a change" note that mentions the PMs and
  Leads.
- **Move** between buckets: view, plus `MOVE_ANY_ITEM`, or `MOVE_OWN_ITEMS` on own items, or
  leading the item's team.
- **Delete**: `DELETE_ANY_ITEM` (with or without cascade); team Leads their team's items without
  cascade; Members only items they created that have no children and, while `planLeadsOnly` is on,
  are not yet scheduled. Deleting an item with children without `?cascade=true` answers 409
  `HAS_CHILDREN`. A delete moves the item (and its subtree) to the project's trash (M12).
- **Trash** (M12): listing and restoring need `DELETE_ANY_ITEM` or `DELETE_OWN_ITEMS`; the list
  holds only items the caller could see if they were active, and a batch whose deleted item is
  hidden is 404. PMs and Leads restore any batch; others a single item they deleted or whose team
  they lead (`canRestoreBatch`). Permanent deletion needs `MANAGE_PROJECT` (PMs). Personal spaces
  have their own trash, reachable only by their owner like the rest of the space.
- **Ad hoc and sprints** (M12): making an item ad hoc or planning it again, and changing a sprint,
  are plan changes. Ad-hoc items take no parent and no dependency links; only links the caller can
  see block the change, so nothing hidden is hinted at.
- **Annotate** (notes, attachments): view plus `ANNOTATE_ITEMS`. Authors edit their own notes;
  authors, PMs, Leads and the item's team Leads may delete notes and attachments.
- **Assign**: assigning only yourself needs nothing extra; assigning others needs `ASSIGN_OTHERS`
  or leading the item's team.
- **Shares** (M13): changing an assignee's share, or adding someone at a share other than 100%, is
  a plan change (the plan rule above). Adding or removing people at 100% follows the assign rule.
- **Reports** (M13): every member, Viewers included, reads the Overview, Sprint, Workload and Plan
  health reports (`VIEW_ITEMS`). Each is computed from the caller's scoped item query, links count
  only when both ends are visible, and sprint history is read only for visible items, so hidden
  items are never counted, listed or hinted at; a sprint of another project is 404. Personal spaces
  have Overview and Workload only (the others 404), for their owner.
- **My work calendar** (M13): `GET /me/calendar` lists the caller's own items across their member
  projects and personal space through the same cross-project scoping as My work; administrators
  get no cross-project reads and no audit entries from it. Moves go through the ordinary
  reschedule and item routes.
- **Team of an item**: PMs and Leads set any team; others only move items between no team and the
  teams they lead, and a team Member may create an item in their own team.

Every item response carries `can` flags computed by these same functions, so the web app shows
exactly the controls the API will accept.

## Visibility scopes

PMs and Leads always see every item. Members and Viewers have a scope on their membership:

| Scope     | Sees                                                      |
| --------- | --------------------------------------------------------- |
| `ALL`     | Every item                                                |
| `BUCKETS` | Items in the buckets the PM selected (`allowedBucketIds`) |
| `OWN`     | Items the person created or is assigned to                |
| `TEAMS`   | Items of the teams the person belongs to                  |

Under a restricted scope, the ancestors (Story, Feature, Epic) of visible items are returned as
read-only titles only (`ancestors`: id, number, key, type, title), so people keep context without
seeing the content.

### Scoped queries

`ProjectAccessService.itemScopeFilter()` turns the caller's scope into a Prisma `where` condition
and adds `deletedAt: null`, so trashed items count as invisible to everyone (M12).
`ItemsService.scoped()` adds it to every query that returns items: lists, children, the item
itself, the timeline, snapshots, My work, notifications, references and the live-update refetch.
An item outside the scope is therefore never loaded, counted or used as a constraint. Only the
trash uses `itemVisibilityFilter()`, the scope without the trash condition. The only deliberately
unscoped queries return no item content: ancestor titles, card positions when reordering, child
types for the hierarchy rules, cycle checks for dependencies (trashed items' links included, so a
restore can never close a cycle), the descendants of a cascade delete (allowed to PMs and Leads
only), the children that follow their Story's sprint (M12) and a restored item's parent state.
Each of the others also ignores trashed rows where it counts them. The list of exceptions is kept
in `docs/DECISIONS.md` (M3, M12).

Further non-disclosure rules:

- Links ("blocked by") are returned only when both ends are visible; the timeline planner sees only
  visible items and links, so a hidden item never moves, blocks or counts.
- A hidden requested item answers 404 before any version or permission check that could hint it
  exists.
- Notifications are shown only while their recipient can still see the item.
- Validation runs after the guards, so a non-member learns nothing from validation errors.

## Teams

Teams are optional. PMs create teams and manage their members; team Leads cannot. Each team member
must be a project member (enforced by a composite foreign key), with a team role `LEAD` or `MEMBER`;
a Viewer may be a team Member but not a team Lead. A team Lead has Lead rights (view, edit, plan,
move, assign, delete without cascade) on their team's items, whatever their own scope.

## Personal spaces

Every user has one private project (`Project.ownerId`), created on first use. Its owner has PM
rights inside it without any membership row. Nobody else can resolve it, administrators included:
the access check looks at ownership before memberships and the administrator exception, and answers
404 to everyone else. Routes that make no sense there (members, teams, timeline, holidays, ADO,
archive) answer 404 even to the owner. Personal spaces never appear in the administrators' project
list, in another person's "all their work", in ADO export or in the audit log viewer. Attachments
count against a per-user quota. Privacy is enforced by the app; people with database, file or
backup access can still read the data, which docs/ADMIN.md states.

## Rich text, mentions and files

- Descriptions and notes are sanitized on the server with an allow-list
  (`apps/api/src/common/sanitize-html.ts`): formatting, lists, quotes, code and links (`http`,
  `https`, `mailto`; every link gets `rel="noopener noreferrer nofollow"`). No scripts, styles,
  classes, media or forms survive.
- An `<img>` survives only when its source is the same item's own inline-image route and names an
  image stored for that item. Nothing is loaded from another host.
- A mention (`<span data-mention="<userId>">`) survives only for active members of the project,
  and its text is rewritten to `@<display name>`, so a mention always shows whom it notifies.
- An item reference (`<span data-ref="KLO-12">`, M12) is marked on save only when the writer can
  see the item (in another project only as a member there), and its text is the canonical key.
  On every read the API turns marks of items the reader cannot see back into the plain text, so
  a reference never hints that a hidden item exists. `GET /references` previews only visible items
  of projects the caller is a member of; "Referenced in" lists only visible referring items.
- Uploads are raw request bodies (`application/octet-stream` with an `x-file-name` header). The
  guards run before the body is read; the file is streamed to a temporary name and checked against
  the size limit and the quota, then renamed into place once its database row is written.
- File types come from the content's first bytes (`apps/api/src/storage/file-types.ts`), never from
  the name or the client. Inline images and logos must be PNG, JPEG, GIF or WebP (never SVG); fonts
  must be WOFF2, WOFF, TTF or OTF.
- Files are stored under the configured attachments folder as `<projectId>/<random name>`, never
  under the web root. Attachments and inline images are served only through authenticated routes
  that check the item's visibility, with `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox` and `Content-Disposition: attachment`
  (inline images: `inline`, `Cache-Control: private, no-cache`). Branding files (logo, fonts) live
  in their own folder and are served by public routes, since the sign-in page needs them, with
  `nosniff`, the sandboxing policy and `Cross-Origin-Resource-Policy: same-origin`.
- A nightly job removes inline images no description or note uses any more, and abandoned uploads.

## Exports

Excel snapshots and offline archives contain only what the caller can read; they add no
visibility. The Reports sheet of a project workbook (M13) is computed like the dashboards, from
the reader's visible items. ADO export is limited to PMs and Leads, ADO import and settings to PMs; system
administration adds no transfer rights, and personal spaces are excluded.

## Live updates

The live-update stream carries ids, never content. Each event is filtered per stream with the same
`canViewItem` check as the API, using the stream owner's current access; a link event needs both
ends visible. Streams follow only projects their owner is a member of (or their own personal
space), so an administrator's cross-project visit receives nothing. Streams close when their
session ends. See [LIVE-UPDATES.md](LIVE-UPDATES.md).

## Audit log

`AuditService.record()` writes the entry in the transaction of the change it describes. Entries
are never updated. The admin viewer (`GET /api/v1/admin/audit`) reads them with filters; entries
from personal spaces are excluded from it and appear only in the owner's own item history.

## Not supported on purpose

Single sign-on, email, webhooks and any other outbound integration are left out because the
server makes no outbound calls. The ADO transfer works with files the operator carries.
