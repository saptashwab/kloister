# M10: live updates

Planning baseline: 2026-11-02. Status: the owner answered the open questions on 2026-11-02 (section 11);
implemented on 2026-11-02. Choices made while building are in docs/DECISIONS.md (M10). Section 7 avoids any
httpd change if the server streams as expected and names the one-line fallback the owner approved.

## 1. Goals and constraints

- Screens that show shared project data stay current without a reload: when someone changes, adds, moves or
  deletes an item, everyone looking at it sees the change within a second or two.
- Calm, not busy: changes land in place with a short highlight; nothing moves under the pointer, and nothing a
  person is typing or dragging is lost.
- No new disclosure: a live update never reveals an item, link, project or person the viewer could not read
  through the REST API (SPEC §3.3, §3.4). Personal spaces stay owner-only (SPEC §3.6).
- Fits the deployment model (SPEC §9): one Node API behind the instance's httpd on RHEL, PostgreSQL, no
  external services, no new runtime dependency beyond what the API already ships (`pg`).
- No schema change, no breaking API change. When live updates are unavailable (switched off, blocked by a
  proxy, offline), every screen behaves exactly as today.
- Concurrency rules stay as they are: timeline reschedules keep their version and plan checks (SPEC §6.4);
  other fields stay last-save-wins and audited. Live updates make conflicts rarer and visible earlier; they
  are not the safety net.

## 2. What already exists

- Every change goes through `AuditService.record()` inside the change's own transaction, so one place sees
  every write: board, backlog, timeline, drawer, bulk edits, ADO import, sprint closing, settings.
- Notifications are written by `NotificationsService.notify()` (also inside the change's transaction); the
  bell polls the unread count every 60 seconds.
- The web keeps one per-project store (`core/project-context.ts`) that the board, backlog, sprints, timeline
  and drawer read; `upsert()` and `refresh()` already update every view at once.
- The API runs on Fastify without response compression, so a streamed response is not buffered by the app.
- Visibility is decided by `ProjectAccessService` (`canViewItem` and friends) from `ItemFacts`.

## 3. Where updates are live

| Area                          | Live                                                                                       | Notes                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Board, backlog, timeline      | Items created, changed, moved, deleted; dependency links; dependent moves                  | All read the project store, so they stay consistent with each other |
| Item drawer                   | Fields, checklist, notes, attachments, activity of the open item                           | See 4.3 for edits in progress                                       |
| Notifications                 | Bell count and the open Notifications list                                                 | Immediate instead of up to 60 s                                     |
| My work and "all their work"  | Items entering, leaving or changing                                                        | Refetch of the visible page                                         |
| Sprints page and sprint bands | Sprints created, renamed, started, closed, deleted; items joining or leaving               |                                                                     |
| Project settings effects      | Buckets, labels, teams, members and roles, project settings (for example the plan setting) | Controls lock or unlock at once instead of failing with 403         |
| Timeline holidays             | Project and instance holiday changes                                                       | The instance-change notice appears without a reload                 |
| Not live                      | Help, admin users and settings, audit log, ADO transfer pages, exports                     | Unchanged                                                           |

Presence (who else is looking at or editing an item) is part of M10 at the owner's request (section 4.5).

## 4. Behaviour and visual design

### 4.1 Changes from others

- A changed card, row or bar updates in place and gets a soft highlight for about one second (the existing
  `--k-primary-soft` token, the same treatment as "Show on timeline"). Hovering a recently changed card shows
  "Changed by Ann just now" in its tooltip.
- New items fade in where they belong; deleted items fade out. Counts, plan totals, sprint bands and parent
  spans update with them.
- With reduced motion, changes apply without animation.
- Several changes arriving together (a bulk edit, an ADO import, a dependent move) are applied as one update.

### 4.2 Your own changes

- The tab that made a change ignores its echo (it already shows the result). The same person's other tabs
  update like anyone else's.

### 4.3 Never under the pointer, never losing input

- While a person drags a card or bar, types in a grid cell or drawer field, or has a menu or dialog open for
  an item, updates to that item wait and apply when they finish. Updates to other items apply around it.
- If the waiting update changed the very field being edited, a small inline notice appears when they finish:
  "Pat (PM) changed this while you were editing", with **Keep mine** (save as usual) and **Use theirs** (discard
  the draft). Nothing typed is discarded silently. The notice names the other person's project role so the
  choice is made knowingly.
- No role outranks another in a conflict (owner decision): anyone allowed to make a change may make it, and the
  person who knowingly saves last decides, as with any shared document. Ranking would silently drop changes
  that the role rules allow, and the item history shows who changed what, with Undo where it already exists.
  Authority over the plan is set by permissions instead (SPEC §3.2, the plan setting).

### 4.3.1 Two people moving the same card or bar

- Anne moves a card to Review while I am dragging the same card. Anne's move waits on my screen until I drop
  (my card does not jump out from under the pointer).
- When I drop on Done, my move is saved: it is the later deliberate action. Because Anne's move arrived during my
  drag, I get a toast: "Anne had moved this card to Review. It is now in Done." with **Put back in Review**. On
  Anne's screen the card then moves to Done with the usual highlight, naming the person who moved it
  ("Moved by <my name> just now"); a highlight always names whoever made that change.
- If Anne's move reaches the server after my drop instead, the same happens the other way round. Bucket rules
  (status mapping, entry rules) apply to each move as today, and both moves are in the item history.
- Timeline bars already carry version checks (SPEC §6.4). With live updates, a bar dragged while someone else
  changed that item's dates no longer retries silently: when I release it I see "Anne changed the dates of this
  item while you were moving it", with **Keep mine** (apply my dates, dependent moves as usual) and **Use
  theirs**.
- If the open item is deleted, the drawer shows "Ann deleted this item" with a close button instead of failing
  on the next action. If the viewer can no longer see it (moved out of their scope), it shows "This item is no
  longer available to you".
- If the viewer's own access changes (role, visibility, plan setting, removed from the project), the project
  data reloads once; a removed member sees the usual "project not found" page.

### 4.4 Connection status

- Normally nothing is shown (or a quiet "Live" dot in the header tooltip).
- After a few seconds without a connection: a small "Reconnecting…" chip in the header; after a minute:
  "Offline. Changes show when you are back." Screens keep working; saves behave as today.
- On reconnect the open project reloads once, so nothing missed while offline stays missing.
- The status is announced politely to screen readers only when it changes to offline and back.

### 4.5 Who else is here (presence)

- Item details: the drawer header shows the avatars of the other people who have the same item open, with "Ann
  is viewing" on hover. While someone edits a field, it reads "Ann is editing Due date", and that field shows a
  small avatar beside it, so two people notice before they overwrite each other.
- Timeline, board and backlog: a row or card someone else has open shows a small avatar at its edge; a cell or
  bar someone is editing or dragging gets a thin outline in a neutral colour with their initials. The project
  header shows the people currently on the project's pages (at most four avatars, then "+3").
- The text names what the person is doing, in plain words:

  | They are                                          | Text                                                                           |
  | ------------------------------------------------- | ------------------------------------------------------------------------------ |
  | Looking at the item (drawer open, nothing active) | Ann is viewing                                                                 |
  | Editing a field or grid cell                      | Ann is editing the due date (the field's own name: title, start date, status…) |
  | Dragging a card or bar                            | Ann is moving this card / this bar                                             |
  | Writing a note                                    | Ann is writing a note                                                          |

  Only one action shows per person (the most recent); several people are listed together, for example
  "Ann is editing the due date · Bo is viewing".

- Presence is a hint, never a lock: anyone may still edit. The conflict notice in section 4.3 remains the
  safeguard.
- It is quiet: presence appears after someone has stayed about two seconds (so passing clicks do not flicker)
  and disappears about 30 seconds after they leave, close the tab or lose the connection.
- Only people and items the viewer could already see are shown: presence for an item reaches only viewers who
  can see that item, and only project members appear. Personal spaces have no presence. Administrators on a
  cross-project visit neither see nor show presence.
- Presence cannot be hidden per person (owner decision): in a shared work tool, seeing who is changing
  something is the point, as with cursors in a shared document. Only the admin "Live updates" switch turns it
  off, together with everything else.

## 5. Technical design

### 5.1 Transport: Server-Sent Events

- `GET /api/v1/events` returns `text/event-stream`, authenticated by the normal session cookie. The browser uses `EventSource`, which reconnects on its own.
- Why not WebSockets: the traffic is one-way (all writes stay on the REST API), SSE is plain HTTP through the
  existing reverse proxy, and WebSockets would need `mod_proxy_wstunnel`, which may not be loaded on the
  server.
- A comment line every 25 seconds keeps proxies from closing the stream and lets the server notice dead
  connections.
- One stream per tab. The stream carries the user's own events (notifications) and the events of one
  subscribed project: the page sends `PUT /api/v1/events/:streamId/project` with the open project, or null.
  Switching projects does not reopen the stream.
- Limits: at most 10 open streams per user (the oldest is closed); streams close at sign-out, password change,
  deactivation and session expiry.

### 5.2 Publishing: PostgreSQL LISTEN/NOTIFY

- `AuditService.record()` also calls `pg_notify('kloister_events', payload)` on the same transaction client,
  and `NotificationsService.notify()` does the same for each recipient. PostgreSQL delivers a notification only
  when its transaction commits, in commit order, so refused or rolled-back changes are never announced and no
  extra bookkeeping is needed.
- The mapping from audit action to live event lives in one table (`live/live-events.ts`): item, dependency,
  checklist, note, attachment, sprint, bucket, label, team, member, project settings and holiday actions map
  to event kinds; authentication, admin, backup, cross-project visit and export actions map to nothing.
- Payload (JSON, well under PostgreSQL's 8,000-byte limit): event kind, project id, item ids with their
  visibility facts (creator, assignees, bucket, team), actor id and the request's client tab id. No titles,
  descriptions or other field values.
- One transaction that touches many items (bulk edit, ADO import, sprint close) sends one notification per
  audit entry; the API coalesces them per transaction id, and above 200 items in one burst it sends one
  `project-resync` event instead.
- One dedicated `pg` connection per API process runs `LISTEN kloister_events` and reconnects with backoff. While
  it is down, open streams receive `resync` when it comes back. Several API processes all receive every
  notification, so this also works if the service is ever run more than once.

### 5.3 Fan-out and non-disclosure

- Each stream holds its user, session and, for the subscribed project, a `ProjectAccess` resolved when the
  project is subscribed and again whenever a member, team, role or settings event for that project arrives.
- An item event is sent to a stream only when `canViewItem` passes for the item's facts in the payload, with
  the same scope rules as the REST API (team Leads, OWN, BUCKETS, TEAMS). Items the viewer cannot see are
  never mentioned, not even as "something changed" or a count.
- A dependency event is sent only when both ends are visible, matching the timeline's link rule.
- An item that moved out of the viewer's scope produces `item-removed` for them (no reason given).
- Personal-space events go only to the owner's streams; notification events only to the recipient.
- Administrators get events only for projects they are members of. A cross-project visit (SPEC §3.1) stays
  read-only and is not live in M10.

### 5.4 Client

- `core/live.service.ts` opens the stream after sign-in, tracks the connection status signal, and dispatches
  events.
- `ProjectContext` subscribes the open project and handles item events: it batches them for 300 ms, refetches
  the changed items through the normal scoped API (`GET …/items?ids=`), and calls `upsert()` or removes items
  that answered 404. Store-wide events (`project-resync`, access or settings changes, reconnects) call
  `refresh()`.
- Screens register "busy" items (dragging, editing, open menus); updates to those wait (section 4.3).
- `core/notifications.store.ts` updates the count from notification events and keeps the 60-second poll only
  as a fallback while the stream is down.
- Every API request carries an `X-Client-Id` header (a random id per tab), stored with the audit payload so a
  tab can skip its own echoes.

### 5.5 Presence

- The page reports what the tab is doing through the stream's control route:
  `PUT /api/v1/events/:streamId/presence` with `{ itemId, action, field }` (action: viewing, editing, moving or
  noting; field only when editing) when an item is opened, an edit, drag or note starts or ends; at most once a
  second per tab.
- Presence lives only in API memory (a map per project, with expiry); it is never stored, audited or exported.
  The API sends `presence` events (user id, item id, field, viewing or editing) to the project's other streams
  that pass `canViewItem` for that item, after the two-second delay, and a removal on leave or expiry.
- With several API processes, presence travels on the same PostgreSQL notification channel as a separate,
  non-audited message kind.

### 5.6 Sessions

- The stream never extends a session: it does not update `lastSeenAt`. At each heartbeat the server checks the
  session's idle and absolute deadlines and closes the stream when expired; the client then shows the usual
  sign-in prompt.

## 6. API (additive)

| Route                                      | Purpose                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/events`                       | Opens the stream; first event is `hello` with the stream id                                                  |
| `PUT /api/v1/events/:streamId/project`     | Body `{ projectId: string \| null }`; 404 for a project the caller cannot see; 404 for another user's stream |
| `GET /api/v1/projects/:id/items?ids=a,b,…` | Existing list route gains an `ids` filter (at most 100), scoped as usual                                     |

| `PUT /api/v1/events/:streamId/presence` | Body `{ itemId: string \| null, action: 'viewing' \| 'editing' \| 'moving' \| 'noting' \| null, field: string \| null }`; the item must be visible (404 otherwise) |

Event kinds: `hello`, `item-changed`, `item-removed`, `links-changed`, `board-changed` (buckets, labels,
sprints, teams, holidays), `access-changed`, `notification`, `presence`, `project-resync`, `resync`.

## 7. Deployment

- First choice, no httpd change: Apache's `mod_proxy_http` in httpd 2.4 passes a response on as soon as the
  backend pauses, so a stream with small events and a heartbeat normally reaches the browser at once through
  the existing `ProxyPass` for `/api/`. The API sends `X-Accel-Buffering: no` and `Cache-Control: no-cache` and
  never compresses the stream. The deployment test and the RHEL acceptance guide check this.
- Fallback, if the server delays events: one more `ProxyPass` line in the Kloister conf file, before the general
  API line, with buffering off and a longer timeout:
  `ProxyPass /__APP_NAME__/api/v1/events http://127.0.0.1:__BACKEND_PORT__/api/v1/events flushpackets=on timeout=3600`.
  It stays within the one-file rule (SPEC §9.3). New installs would get it from `deploy/httpd.conf.template`.
  Upgrades never change httpd configuration (the upgrade helper promises this), so on an upgraded server the
  operator adds the line by hand following UPGRADE.md and reloads httpd.
- Admin settings › General gains "Live updates" (default per section 11). Off: no streams are accepted and the
  web behaves as today, so a proxy that breaks streaming can be worked around without a release.
- INSTALL, UPGRADE, ADMIN and RHEL-ACCEPTANCE describe the check (`curl -N` against the events path with a
  session cookie shows a heartbeat every 25 seconds), the switch and, if needed, the fallback line.

## 8. Data model

No change. Settings use the existing `AppSetting` store.

## 9. Files (expected)

- API: `src/live/` (module, controller, `LiveHub` stream registry and fan-out, `PgListener`, event mapping),
  `audit.service.ts` and `notifications.service.ts` (publish), an `ids` filter in the items list, a client-id
  middleware, the admin setting.
- Web: `core/live.service.ts`, `core/project-context.ts` (subscribe, batch, refetch), busy-item tracking in the
  board, backlog, timeline and drawer, `core/notifications.store.ts`, a header connection chip, the highlight
  style in the existing lazy stylesheets, Help text.
- Deploy: guides and acceptance steps; `deploy/httpd.conf.template` and its deployment test only if the
  fallback line is needed.

## 10. Out of scope (later)

- Live cursors, collaborative text editing of descriptions.
- Live updates for admin pages, the audit log, ADO transfer pages and exports.
- Live updates during an admin's cross-project visit.

## 11. Owner decisions (2026-11-02)

1. Deployment: start without any httpd change and check streaming on the RHEL server; if it delays events, add
   the one fallback line to the Kloister conf file by hand per UPGRADE.md, and to the template for new
   installs. Upgrades keep their promise never to change httpd configuration.
2. Editing conflicts: the "Keep mine / Use theirs" notice, naming the other person's role; no role outranks
   another (section 4.3); simultaneous card and bar moves as in section 4.3.1.
3. Admin switch "Live updates": one global switch, default on.
4. Highlight: soft highlight with "Changed by Ann just now" on hover.
5. Presence: shows the action (viewing, editing a named field, moving, writing a note); people cannot hide their
   own presence; the admin switch is the only way to turn it off.

## 12. Verification

- Presence: unit tests for the delay, expiry and per-item visibility filter; a browser test where the Member
  sees the PM's avatar in the drawer and "is editing Due date", and a viewer without access to the item sees
  nothing.
- Unit: event mapping (every audited action is either mapped or explicitly not live), fan-out filter per role
  and scope (OWN, BUCKETS, TEAMS, team Lead, Viewer, personal space, admin non-member), coalescing and resync
  threshold, client batching, busy-item deferral, echo skipping, status chip states.
- Database tests (CI): a committed change reaches a listening connection with the right payload; a rolled-back
  or refused change does not; a bulk change coalesces; member removal produces `access-changed`.
- HTTP tests: the stream requires a session, never extends it, closes on expiry and sign-out; project
  subscription is 404 for invisible projects and for other users' streams.
- Browser tests (CI) with two signed-in users in two contexts: a PM moves a card and a bar and the Member's
  board and timeline update; a hidden item never appears; an edit in progress is not overwritten and shows the
  conflict notice; the bell updates without a reload; offline and reconnect.
- Deployment tests: only if the fallback line is adopted, the rendered conf contains it before the general
  API line.
- Manual on the RHEL server (owner): streaming through httpd, with the `curl -N` check from the guides.
