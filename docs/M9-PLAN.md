# M9: project Timeline

Planning baseline: 2026-11-02. Status: drafted from the owner's decisions of
2026-11-02 (section 9); waiting for owner approval before any implementation.
SPEC §1, §6, §6.2, §6.4 and §10 carry the agreed behaviour; this plan adds the
detail and the file list.

## 1. Goals and constraints

- A **Timeline** tab in every project, next to Board, Backlog and Sprints: a
  spreadsheet-like grid of the project's items on the left and a bar timeline on
  the right, for setting up a plan quickly and reviewing it at a glance.
- The timeline is a view, not a separate plan. Every row is an ordinary work item;
  rows created or edited here appear on the board, backlog, sprints, My work,
  exports and ADO transfers straight away, and the other way round.
- No breaking change (the instance is in use). Existing routes, deep links and
  responses keep working; API changes are additive; no table changes are needed
  (section 7). Permissions do not widen anywhere.
- Projects only. Personal spaces do not get a timeline in M9 (section 10).
- Reuse the M4.5 foundation: tokens only, `ui/` pieces, Angular Material and the
  CDK first. No third-party Gantt library. The whole timeline is a lazy route,
  outside the initial bundle (498.37 kB under the unchanged 500 kB budget).
- Every new screen gets browser tests with screenshots in the `e2e-report`
  artifact; every new endpoint gets permission tests (SPEC §3.4).

## 2. What already exists

- Hierarchy Epic → Feature → Story → Task/Bug with parent rules (SPEC §4.1): the
  grid's outline and indent levels.
- `WorkItem.startDate` and `dueDate` (calendar dates): the bar's ends. Both
  already go out and come back through ADO transfers via the profile date fields.
- `WorkItemDependency` ("blocked by", same project, no cycles): a finish-to-start
  predecessor link. Cycle checks already run serializable and unscoped.
- Sprints with start and end dates: background bands.
- `ProjectContext` already holds the project's visible items, buckets, sprints,
  members and teams.

## 3. Screen

Route `/p/:key/timeline`, a sibling of board/backlog/sprints. The item drawer
opens over it at `/p/:key/timeline/items/:number`, as it does under `/backlog`.

### 3.1 Grid (left)

- Columns: `#` (item key), Title (indented by outline level, with expand/collapse),
  Type, Assignees, Start, Duration, Due, Predecessors, Status. Bucket, Sprint,
  Team and Priority are optional columns, hidden by default; the column choice is
  remembered per viewer in local storage (a convenience only).
- Rows follow the backlog's order: hierarchy, then `position`. Items without a
  parent are top-level rows. Ancestors shown as read-only titles (SPEC §3.3) keep
  their place as title-only rows with no editable cells and no bar.
- Keyboard follows the ARIA grid pattern. In navigation mode, arrow keys move
  between cells, Home/End go to the row's ends, and Tab and Shift+Tab leave the
  grid. Enter, F2 or typing a character starts editing the cell. In edit mode,
  Escape cancels, Tab and Shift+Tab commit and move to the next or previous
  cell, and Enter commits and moves to the same cell of the next row. On the
  last row, Enter adds a new row. The grid handles its own keys, so the app's
  single-key shortcuts (`c`, and the drawer's `m`/`a`/`l`) do not fire while a
  grid cell has focus. `core/shortcuts.ts` skips grid cells as it already skips
  text fields.
- A row is saved when focus leaves it, never per keystroke. The row shows its
  saving progress and any error; a failed row keeps its values for correction.
- New rows: Enter on the last row, Insert, the row menu's "Add row below" or
  the "Add row" button.
- Indent and outdent: Ctrl+] / Ctrl+[ (matched on the physical key, so layouts
  that need AltGr for brackets still work), the toolbar buttons and the row menu.
  - Indenting makes the row the last child of its previous sibling (the nearest
    row above at the same level). Outdenting makes it the next sibling of its
    parent.
  - A new row's type defaults to the usual child of its new parent (Epic →
    Feature → Story → Task, and Task under a Feature).
  - An existing item keeps its type. If that type is not allowed under the new
    parent (SPEC §4.1), or the new parent is a Task or Bug, the change is
    refused with the reason and nothing changes. Type changes are made only in
    the Type cell.
  - Children move with their parent.
- New items needing a bucket get the first bucket, by position, in which the
  caller can create and still see the item: for BUCKETS scope, the first allowed
  bucket. For TEAMS scope, the new item gets the caller's team, chosen in the
  toolbar when they belong to several. No sprint is set. If no valid default
  exists, the row asks for the missing field. Creation uses the ordinary create
  endpoint and permissions.
- Paste: plain text with several lines (for example from a spreadsheet column)
  creates one row per line, as titles. Leading tabs or steps of two spaces
  become indent levels.
  - A preview lists the rows ("Create 12 items") before anything is saved.
  - Rows are created in order, one request each, because later rows may need
    earlier ones as parents. If a request fails, creation stops there: the rows
    already created stay (with Undo, which deletes them under the ordinary
    delete rules), and the rest stay in the dialog with the error and Retry.
  - Tab-separated columns are not mapped in M9.
- Predecessors cell: item numbers separated by commas (`12, 15` or `KLO-12`).
  Saving compares the list with the stored links and uses the existing add and
  remove dependency endpoints, so cycle and permission checks are unchanged.

### 3.2 Dates and duration

- Only start and due are stored. Duration is computed in **working days**
  (Monday to Friday, both ends counted, no holiday calendar).
- Any two of Start, Duration and Due set the third:
  - changing Duration keeps Start and sets Due;
  - changing Due keeps Start and recomputes Duration;
  - changing Start keeps Duration and moves Due.
- With only a due date, the row shows a due marker, not a bar. With only a start
  date, it shows a start marker.
- Duration is the number of Monday-to-Friday days from Start to Due, both
  included. A typed duration must be at least 1. Due becomes the nth working day
  counted from Start, or from the next Monday when Start is a weekend day.
- A start or due date entered on a Saturday or Sunday is kept as entered, since
  dates are free-form elsewhere in the app. Durations count only the working days
  between, so a weekend-only span shows 0.
- Dates the timeline computes (section 4) always land on working days.
- Due time (M8.5) is ignored by the timeline; the bar is day-level. The drawer and
  board keep showing it.
- Dates use the app's one date format and the M8.5 day-first entry.

### 3.3 Bars (right)

- Zoom: week (days as columns), month (weeks), quarter (months). A today line and
  sprint bands with the sprint name; weekends shaded in week zoom.
- Bars use type colours from the tokens, with the status shown by a fill pattern
  and in the accessible name, never by colour alone. Done items are muted.
- Epics and Features with children show a summary bracket over the span of their
  visible children, computed for display and never written back. A parent with
  its own dates shows its own bar as well; children running past it get a warning.
- Arrows link each visible predecessor to its successor. A successor starting
  before its predecessor's due date is drawn as a conflict (warning colour and
  icon, explained on hover and in the accessible name).
- Overdue open items use the existing overdue style.
- Dragging a bar moves both dates; dragging an end changes one date; both snap to
  days. Every drag has a keyboard equivalent: each bar is focusable (reached from
  its row), Left/Right moves it by a working day and Shift+Left/Right changes its
  duration; nothing is saved until Enter, and Escape restores it. Alt+arrows are
  avoided because browsers use them for history. Drags and keyboard moves go
  through the same reschedule flow (section 4).
- Grid and bars scroll together vertically (CDK virtual scroll, one row height).
  Horizontally the bars scroll on their own; "Today" and "Fit plan" buttons
  reposition them.

### 3.4 Toolbar and filters

- The board's filters (assignee, label, sprint, type, team, text) apply; filtering
  keeps the ancestors of matching rows as context, like the backlog.
- Expand all / Collapse all, zoom, Today, Fit plan, Show Done, column chooser and
  the page header's Export… (section 6).

### 3.5 Widths and roles

- Desktop and tablet: grid and bars side by side, with a draggable splitter
  (keyboard-adjustable). Phone width: grid only, as stacked cards with key, title,
  dates and duration (the M8.5 card pattern); no bars and no bar dragging.
- Viewers get the timeline read-only. Members edit only the rows they may edit
  (SPEC §3.2); other rows are read-only with the reason in the tooltip. Creating,
  indenting and dependency edits follow the existing rules.

## 4. Moving dependent items (rescheduling)

### 4.1 Rule

- A dependency is finish-to-start with no lag. After a change, an open
  successor that starts on or before the due date of its latest constraining
  predecessor moves to start on the next working day after that due date. It
  keeps its duration in working days.
- Only predecessors with a due date constrain their successors; a start-only
  predecessor does not.
- A successor with only a due date keeps only a due date: its due date moves to
  the next working day after the predecessor's due date.
- Moves only push successors later. Moving a predecessor earlier never pulls its
  successors earlier automatically. "Reschedule from predecessors" (row menu and
  bulk selection) sets each chosen item's start to the earliest allowed working
  day and keeps its duration, with the same preview.
- The push continues along the chain (successors of successors). It stops at any
  item that is not moved: items with no dates, Done items, title-only ancestors,
  and items the caller cannot see or cannot edit (4.2).
- Moving a parent's own dates never moves its children.

### 4.2 Who sees what, and permissions

- The plan of moves is computed only over items the caller can see **and** may
  edit. Items the caller can see but not edit stay in place and are listed in the
  preview as "not changed: you can't edit these". Items the caller cannot see are
  never moved, listed, counted or hinted at (SPEC §3.4; hidden children are
  already never revealed, not even as a count).
- The planner reads items and dependency edges only through
  `ItemsService.scoped()`. Only the existing cycle check when a dependency is
  added stays unscoped, and it reads ids only.
- "Latest predecessor" is computed over the caller's visible predecessors, so a
  hidden predecessor's dates never affect what the caller sees. As a result, the
  same edit can move items differently for callers with different visibility.
  Any conflict that remains shows as a warning to whoever can see both ends.
- Nothing about the plan or its conflicts widens anyone's reach.

### 4.3 Confirm (default)

- When a date change would move other items, a dialog lists every proposed move
  (key, title, old and new dates) and offers **Move N items**, **Change only this
  item** and Cancel. Applying is one transaction. The toast then offers Undo.
- Undo is all or nothing: it restores the previous dates of every item the
  change touched, but only if none of them has changed since. Any later change,
  even an unrelated one such as a status change, refuses the whole Undo with
  "Can't undo: KLO-15 has changed since", and nothing changes.
- For PMs only, the dialog also offers **Always move dependent items in this
  project**: ticking it applies the moves and switches the project to automatic
  mode (4.4). The same switch is in Project settings › General (PM only).

### 4.4 Automatic (opt-in per project)

- With automatic mode on, date changes in that project move dependent items
  without the dialog, under the same rule and the same permission limits (4.2), for
  every editor. A toast says "Moved N dependent items" with Undo and a link that
  shows the list. Edits that would leave conflicts the caller cannot fix still
  apply and show the warning.
- Stored as a flat key, `Project.settings.autoMoveDependents` (boolean, default
  false), in the existing settings JSON, so there is no migration. The settings
  merge is shallow and unknown keys are dropped, so the key is added to
  `parseProjectSettings`, the shared `ProjectSettings` type and
  `ProjectSettingsChangeDto`. Changing it is a PM project setting, audited as
  `PROJECT_UPDATED` like the others.
- Which edits move dependent items (confirmed, or automatically when the switch
  is on): date edits on the timeline and in the project item drawer, the only
  screens with date fields. Nothing else moves them: backlog bulk edits, My work,
  duplication, ADO imports (incoming dates are applied as reviewed, SPEC §7),
  personal spaces and direct item PATCH calls all change only the item they
  name. PATCH keeps its current behaviour.

### 4.5 Audit and notifications

- Each changed item gets its ordinary date-change audit entry. Entries of one
  reschedule share a `rescheduleId` and the triggering item's id in `meta`.
- The activity history says "moved with KLO-12" only when the viewer can see
  KLO-12. Otherwise it says "moved with a dependency change", the same way hidden
  blocking items are already blanked in item responses.
- No new notification types: due-date checks stay daily.

## 5. API (additive)

Routes follow the existing `projects/:id` form, where `:id` is a uuid or a
project key. For a personal space, both endpoints return 404.

- `GET /projects/:id/timeline` returns:
  - the caller's visible items, with the fields the grid needs;
  - dependency edges where **both** ends are visible to the caller;
  - title-only ancestors as title-only rows.

  It follows the item list's rules for visibility, archived projects and
  auditing admins who are not members.

- `POST /projects/:id/timeline/reschedule` takes
  `{ changes: [{ item, startDate?, dueDate? }], mode, expect? }`, where `mode` is
  `preview`, `apply` or `only`.
  - Every `item` (uuid or number) is first resolved through the caller's scope.
    An item the caller cannot see returns 404 before any version or plan check,
    so a 409 never confirms that a hidden item exists. The caller must be able
    to edit every requested item; otherwise the request returns 403.
  - `preview` returns the proposed moves, the "not changed" list and each listed
    item's version (`updatedAt`). It changes nothing, but it is refused like a
    write: admins who are not members can only read, and archived projects
    refuse it. A refused attempt is audited as usual.
  - `apply` takes `expect`, the versions of the requested items and of every
    previewed move, plus the previewed moves themselves. In one serializable
    transaction, it re-checks permissions, recomputes the plan and applies it
    only if every version still matches and the recomputed moves are exactly
    the previewed ones. Otherwise it returns 409 with a fresh preview, and the
    dialog shows it again.
  - In automatic mode there is no preview: the client sends `apply` with the
    versions of the requested items only, and the server applies the plan it
    computes. If a version is stale, it returns 409 and the client retries
    once with fresh rows before reporting the error.
  - `only` applies the requested changes without moving anything else, under
    the same version checks. Undo is an `only` call with the previous dates and
    the versions `apply` returned (all or nothing, 4.3).
  - The response lists every changed item.
- Archived projects refuse `apply`, `only` and the automatic-mode switch, like
  any other write.
- The existing item PATCH is unchanged.
- Working-day arithmetic lives once in `@kloister/shared` and is used by the API
  (moves) and the web (duration, preview display).

## 6. Export

- The project Excel snapshot (SPEC §6.2), from the board, backlog, sprints and
  timeline alike, gains a **Timeline** sheet. Rows follow the timeline order with
  Excel outline levels (collapsible groups, summary rows above) and an indented
  title; columns Key, Title, Type, Assignees, Status, Start, Duration (working
  days, a value, not a formula), Due, Predecessors (keys of readable predecessors
  only), Sprint; then one column per week from the earliest start to the latest
  due, with a header row of week-start dates and a sprint row. A row's weeks are
  filled in its type colour, with a status character in the first cell so status is
  not colour-only; a today column is outlined. Frozen panes keep the headers and
  the Key/Title columns in view; landscape page setup fits one page wide per week
  range.
- The week range is capped at 156 weeks (3 years). If the plan is longer, the cap
  and the omitted range are stated on the Summary sheet and the sheet's first row,
  never silently. Rows without dates are listed without bars.
- The same readable-only rules apply: hidden items never appear, title-only
  ancestors stay titles, and user text is never a formula.
- The timeline's Export… defaults to the timeline's current filters, like other
  screens. My work and personal-space exports do not get the Timeline sheet.

## 7. Data model

- No new tables or columns. Dates and dependencies exist; the automatic-mode
  switch is a key in `Project.settings`; the reschedule batch id is audit `meta`.
- Dependency types (start-to-start and so on), lag, milestones, baselines and a
  holiday calendar are out of scope (section 10) and would be additive later.

## 8. Files (expected)

API (`apps/api/src/`):

- `timeline/timeline.module.ts`, `timeline.controller.ts`, `timeline.service.ts`,
  `timeline.dto.ts`, `reschedule.ts` (pure move planner) with `*.spec.ts`.
- `items/snapshot-format.ts`, `snapshots.service.ts`: the Timeline sheet.
- `projects/project-settings.ts`, `projects.dto.ts` and the shared
  `ProjectSettings` type: `autoMoveDependents`.
- Activity history: "moved with" wording that blanks hidden triggering items.
- `test/db/timeline.db-spec.ts`: permission matrix (roles, every visibility scope,
  teams, admin non-member audit, archived project), hidden-item non-disclosure in
  timeline, preview, apply and export, concurrency (409), automatic mode.

Shared: `packages/shared/src/working-days.ts` with tests; timeline DTO types.

Web (`apps/web/src/app/`):

- `pages/timeline/` (lazy route): `timeline-page.ts`, `timeline-grid.ts`,
  `timeline-bars.ts`, `reschedule-dialog.ts`, styles loaded with the route.
- `core/timeline-logic.ts` (outline building, row order, summary spans,
  conflicts, indent/outdent rules, paste parsing) with unit tests.
- Project shell tab and route; Project settings › General switch; drawer date
  fields use the reschedule flow.
- `e2e/timeline.e2e-spec.ts`: create by typing and pasting, indent/outdent, two
  of three date fields, predecessors, confirm dialog, PM-only automatic switch,
  Undo, Member/Viewer limits, hidden-item non-disclosure, keyboard-only use,
  phone/tablet, light/dark screenshots, export download.

Docs: SPEC (done in planning), Help & FAQ article "Plan with the timeline",
README feature list, DESIGN (timeline bars, conflict style), DECISIONS.

## 9. Owner decisions (2026-11-02)

- Build the timeline as a project tab over existing items; no Gantt library; no
  silent cascading by default.
- Dependent items move after a confirmation by default, with an opt-in automatic
  mode per project; PMs can switch it on from the confirmation dialog itself.
- Durations are working days (Monday to Friday).
- It is a new milestone, M9.
- The Excel export from the board (and other project screens) must include this
  timeline format.
- Recommended and accepted: finish-to-start only, no lag; projects only; grid-only
  at phone width; visibility rules unchanged.

## 10. Out of scope (later, additive)

- Start-to-start, finish-to-finish and start-to-finish links; lag and lead.
- Critical path, resource levelling, workload views, baselines (plan vs actual).
- Holiday and per-person calendars; zero-day milestones.
- Moving a parent's bar together with its children.
- A timeline for personal spaces (cheap later, since personal spaces reuse the
  project screens).
- Exporting to or importing from Microsoft Project files.
- Transferring dependency links through ADO CSV files (ADO's CSV import cannot
  create them; dates do transfer).

## 11. Open questions for approval

1. Date edits in the item drawer also move dependent items (confirmed, or
   automatically), not only edits on the timeline (4.4). Recommended, so the two
   screens with date fields follow one rule. The board has no date fields.
2. Moves only push later; pulling earlier is an explicit action (4.1).
3. The Timeline sheet is added to every project workbook, not offered as a
   separate export option (6).

## 12. Verification

The usual gate: `npm ci && npm run format:check && npm run lint && npm run build
&& npm test`; API/db and browser test type checks and listing; database and
browser tests run in CI. Mock visual checks at phone, tablet and desktop widths in
light and dark themes, including a 500-item plan for scrolling and drag
performance. Independent review against SPEC and this plan before the commit.
