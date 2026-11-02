# M9: project Timeline

Planning baseline: 2026-11-02. Status: the owner settled every open question on
2026-11-02 (section 9), including the additive migration in section 7.
Implementation starts when the owner says go.
SPEC §1, §6, §6.2, §6.4 and §10 carry the agreed behaviour; this plan adds the
detail and the file list.

## 1. Goals and constraints

- A **Timeline** tab in every project, next to Board, Backlog and Sprints: a
  spreadsheet-like grid of the project's items on the left and a bar timeline on
  the right, for setting up a plan quickly and reviewing it at a glance.
- The timeline is a view, not a separate plan. Every row is an ordinary work item;
  rows created or edited here appear on the board, backlog, sprints, My work,
  exports and ADO transfers straight away, and the other way round.
- It should feel like filling in a spreadsheet, with scheduling built in the way
  Microsoft Project does it: dependent items follow their predecessors
  automatically, earlier or later, unless someone deliberately pinned a later
  start.
- No breaking change (the instance is in use). Existing routes, deep links and
  responses keep working; API changes are additive; the one migration is
  additive (section 7). Permissions do not widen anywhere.
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
  Start, Duration, Due, Predecessors, Assignees and Status (icon and word,
  editable). Type, Bucket, Sprint, Team, Priority, Work and **Progress**
  (checklist ticks such as `3/5` for leaves; done and total children for
  parents) are optional columns, hidden by default; the column choice is
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

- Durations are in **working days** (Monday to Friday, no holiday calendar), in
  steps of **half a day**. Each working day has a **1st half** and a **2nd half**.
  The app defines no clock times for them: no working hours and no noon. Grid
  cells and exports say "1st half" and "2nd half"; the details panel says
  Morning and Afternoon, which mean the same halves.
- Stored per item:
  - `startDate`, plus the new `startSecondHalf` flag (default false: the item
    starts in the 1st half);
  - `dueDate`, plus the new `dueFirstHalf` flag (default false: the item
    finishes at the end of the 2nd half).
  - The M8.5 due time is separate and unchanged: an optional deadline time for
    overdue checks and sorting, never used for scheduling.
  - Duration itself is not stored; it is computed from those.
- Duration is the number of working half days from the start half to the finish
  half, both included, divided by two. Examples: Monday 1st half to Monday 1st
  half is 0.5; Monday 2nd half to Tuesday 1st half is 1; Monday 1st half to Friday
  2nd half is 5.
- Any two of Start, Duration and Due set the third:
  - changing Duration keeps Start and sets Due and its half;
  - changing Due keeps Start and recomputes Duration;
  - changing Start keeps Duration and moves Due.
- A typed duration must be at least 0.5 and a multiple of 0.5. Start and Due cells
  accept a date, optionally followed by the half ("4 Nov 2nd", "4 Nov 2nd half");
  a cell shows the half only when it is not the default ("5 Nov, 2nd half" for a
  start, "11 Nov, 1st half" for a due date).
- With only a due date, the row shows a due marker, not a bar. With only a start
  date, it shows a start marker.
- A start or due date entered on a Saturday or Sunday is kept as entered, since
  dates are free-form elsewhere in the app. Durations count only the working half
  days between, so a weekend-only span shows 0. When a duration is counted from a
  weekend start, counting begins on the next Monday's 1st half.
- Dates the timeline computes (section 4) always land on working half days.
- A due time someone set in the drawer is kept when the item moves; it does not
  affect scheduling, and the timeline does not show it.
- Dates use the app's one date format and the M8.5 day-first entry.

### 3.2.1 Totals for parents and the whole plan

- Summary rows: an Epic, Feature or Story with visible dated descendants shows,
  read-only and marked as a summary, the span of those descendants:
  - Start is the earliest start, and Due the latest finish;
  - Duration is the working days between them (the time the work takes from
    first start to last finish, not the sum of the parts).
- An optional **Work** column, hidden by default, shows the sum of the durations
  of a row's leaf descendants (its own duration for a leaf), for comparing effort
  with elapsed time.
- A summary row's own stored dates, if it has any, show as a thin outline bar
  behind its summary bracket and stay editable in the drawer. If the descendants
  run past them, the row gets a warning. Summary values are computed for display
  and never written back.
- Plan total: the toolbar shows the plan's span, for example "4 Nov 2026 – 19 Mar
  2027 · 98.5 working days", computed over every dated row the caller can see.
  When filters are active it says so ("filtered") and covers the matching rows
  only.
- All totals are computed in the browser from the rows the caller can see, so
  hidden items never affect them.

### 3.3 Bars (right)

- Zoom: week (days as columns), month (weeks), quarter (months). A today line and
  sprint bands with the sprint name; weekends shaded in week zoom.
- Bars use type colours from the tokens, with the status shown by a fill pattern
  and in the accessible name, never by colour alone. Done items are muted.
- Summary rows (3.2.1) show a bracket over their descendants' span, labelled
  with its duration.
- Arrows link each visible predecessor to its successor. A successor starting
  before its predecessor finishes is drawn as a conflict (warning colour and
  icon, explained on hover and in the accessible name). With automatic
  scheduling, conflicts remain only where an item could not move (4.2).
- A pinned start (4.1) shows a pin icon at the bar's start.
- Overdue open items use the existing overdue style.
- Dragging a bar moves both dates; dragging an end changes one date; both snap to
  half days. Every drag has a keyboard equivalent: each bar is focusable (reached
  from its row), Left/Right moves it by half a working day and Shift+Left/Right
  changes its duration by half a day; nothing is saved until Enter, and Escape
  restores it. Alt+arrows are
  avoided because browsers use them for history. Drags and keyboard moves go
  through the same reschedule flow (section 4).
- Grid and bars scroll together vertically (CDK virtual scroll, one row height).
  Horizontally the bars scroll on their own; "Today" and "Fit plan" buttons
  reposition them.

### 3.3.1 Links between the timeline, the board and the drawer

- Spreadsheet editing in the grid stays the main and fastest way to enter and
  update the plan. Clicking a title, date or other cell selects it for editing,
  exactly as in 3.1. The drawer is an extra way in, for what the grid does not
  show, such as the description, checklist, notes and files.
- The row's key (a link) and an "Open details" icon at the row's end open the
  item's drawer at `/p/:key/timeline/items/:number`, as do a double click on a
  bar and Enter on a focused key cell or bar. Single clicks on bars select them
  for dragging.
- Everything editable in the drawer is editable there, under the usual
  permissions, and changes show in the row straight away. That includes Epics
  and Features, which may have no card on the board. The grid keeps its place
  while the drawer is open. Title-only ancestors do not open, as elsewhere.
- The drawer opened from the timeline offers **Show on board**: it opens the
  board with the item's drawer (`/p/:key/items/:number`), scrolls to the card and
  highlights it. This is offered only when the item has a bucket and the board's
  filters would show it; otherwise it explains why (for example "No bucket").
- From the board, the backlog and any drawer, **Show on timeline** (card menu
  and drawer actions) opens `/p/:key/timeline?item=<number>`. The timeline
  expands the item's ancestors, clears filters that would hide it (and says so),
  scrolls the row and its bar into view, and highlights it.
- These links are plain routes with the existing guards: an item outside the
  caller's visibility answers "not found", as deep links already do.

### 3.3.2 Sprints for selected rows (owner request, 2026-11-02)

- Rows can be selected together: a checkbox per row, Shift+click for a range,
  Ctrl+click to add or remove one, and Space on a focused row. A selection bar
  shows the count with **Set sprint…**, **New sprint from selection** and
  Clear.
- **Set sprint…** assigns every selected row to an open sprint, or to none.
- **New sprint from selection** (PMs and Leads, who manage sprints) proposes a
  sprint covering the selected rows' span (earliest start to latest finish,
  widened to whole days) with an editable name, creates it, then assigns the
  rows.
- With rows selected, clicking a sprint band assigns them to that sprint.
- These use the existing sprint and item endpoints, one item update per row, as
  the backlog's bulk edits do. Rows the caller may not edit, and title-only
  ancestors, are skipped and listed afterwards; failures are reported per row.
  No API change.

### 3.3.3 Other actions on selected rows (owner request, 2026-11-02)

- The selection bar also offers **Assign…** (add people to, or replace the
  assignees of, every selected row, under the existing assignment rule),
  **Set status…**, **Shift dates…** (move the selected rows by a number of
  working days, earlier or later, with dependent items following as in §4) and
  **Delete…**.
- Status changes follow the project's status-to-bucket rule and notify as
  usual. Items set to In progress, Blocked or Done stop moving with their
  predecessors (§4.1).
- Delete asks first, listing the rows, and cannot be undone. Each row follows
  the ordinary delete rules; items with children need cascade rights (PMs and
  Leads) and an explicit "and their children" choice. Rows the caller may not
  change are skipped and listed.
- **Indent** and **Outdent** move every selected row one level, in display
  order; a row whose parent is also selected moves with it, so subtrees stay
  whole. Rows that cannot move are skipped with the reason.
- **Link in order** makes each selected row a predecessor of the next one in
  display order (like Microsoft Project's link tasks); **Unlink** removes the
  links among the selected rows. Dependent items then follow as in §4.
- **Set priority**, **Add label** / **Remove label** and **Move to bucket**
  complete the bar. Bulk duplicate and setting a team are left out (the
  duplicate dialog already handles copies; teams have narrow permission rules).
- Selections can be contiguous (Shift+click) or scattered (Ctrl+click).
- Like the sprint actions these use the existing endpoints, one request per
  row; there is no new API.

### 3.4 Toolbar and filters

- The board's filters (assignee, label, sprint, type, team, text) apply; filtering
  keeps the ancestors of matching rows as context, like the backlog.
- Expand all / Collapse all, zoom, Today, Fit plan, Show Done, column chooser and
  the page header's Export… (section 6).

### 3.4.1 Keyboard shortcuts

- The timeline's keys are listed in the app's keyboard-shortcuts dialog (`?`)
  under a Timeline heading, and in the Help article. Toolbar and selection-bar
  buttons show their shortcut in the tooltip, for example "Indent (Ctrl+])".

### 3.5 Widths and roles

- Desktop and tablet: grid and bars side by side, with a draggable splitter
  (keyboard-adjustable). Phone width: grid only, as stacked cards with key, title,
  dates and duration (the M8.5 card pattern); no bars and no bar dragging.
- Viewers get the timeline read-only. Members edit only the rows they may edit
  (SPEC §3.2); other rows are read-only with the reason in the tooltip. Creating,
  indenting and dependency edits follow the existing rules.

## 4. Moving dependent items (rescheduling)

### 4.1 Rule (as soon as possible, with pins)

- A dependency is finish-to-start with no lag. An item's **earliest start** is the
  next working half day after the latest finish among its constraining
  predecessors: a predecessor finishing in the 1st half lets its successor start
  in the 2nd half of the same day; one finishing in the 2nd half lets it start in
  the 1st half of the next working day.
- Only predecessors with a due date constrain their successors; a start-only
  predecessor does not. Predecessors constrain whatever their status, including
  Done.
- A successor is scheduled to start at the later of its earliest start and its
  pin (below). This moves it **later or earlier**, like Microsoft Project, and it
  keeps its duration. A successor with only a due date keeps only a due date,
  placed at the first working half day it can finish.
- **Pins.** When someone types or drags a start date for an item that has
  constraining predecessors, and that start is later than its earliest start,
  the start is recorded as the item's pin, "start no earlier than". Example: A
  precedes B and C. B was dragged to start later than A's finish allows. When A
  moves earlier, C follows it, but B stays at its pinned start. If A later grows
  past B's pin, B is pushed later, and it returns to the pin if A shrinks again.
  - Typing or dragging a start earlier than the earliest start is not kept: the
    item starts at its earliest start, and the toast or dialog says why ("Starts
    after KLO-12 finishes").
  - Pins show as a pin icon in the Start cell and on the bar. "Remove pin" (row
    menu and drawer) lets the item move to its earliest start.
  - A pin on an item with no constraining predecessors has no effect, and it is
    kept.
- The planner moves only Not started items. In progress, Blocked and Done items
  have already started, so they keep their dates; a resulting overlap shows as a
  conflict.
- The planner continues along the chain (successors of successors). It stops at
  any item it does not move: items with no dates, items already started, title-only
  ancestors, and items the caller cannot see or cannot edit (4.2).
- Items with no predecessors are never moved by the planner; their dates are as
  entered.
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

### 4.3 Automatic or confirmed

- Each project has one switch, **Move dependent items automatically**:
  - **On** (the default for new projects): changes move dependent items straight
    away, with no dialog. A toast says "Moved N dependent items", with Undo and a
    link that shows the list.
  - **Off** (existing projects, until a PM switches it on): a dialog lists every
    proposed move (key, title, old and new dates) and offers **Move N items**,
    **Change only this item** and Cancel. For PMs only, it also offers **Always
    move dependent items in this project**, which applies the moves and switches
    the project on.
- Either way, applying is one transaction, with Undo in the toast.
- Undo is all or nothing: it restores the previous dates of every item the
  change touched, but only if none of them has changed since. Any later change,
  even an unrelated one such as a status change, refuses the whole Undo with
  "Can't undo: KLO-15 has changed since", and nothing changes. Undo also restores
  the pins the change set or removed.

### 4.4 The switch, and what triggers the planner

- The switch is stored as a flat key, `Project.settings.autoMoveDependents`
  (boolean), in the existing settings JSON. The settings merge is shallow and
  unknown keys are dropped, so the key is added to `parseProjectSettings`, the
  shared `ProjectSettings` type and `ProjectSettingsChangeDto`.
  - A missing key means off, so existing projects keep their current behaviour.
  - Project creation writes `true`.
  - It is a PM setting in Project settings › General, audited as
    `PROJECT_UPDATED` like the others.
- The planner runs after:
  - date or duration edits on the timeline and in the project item drawer, the
    only screens with date fields;
  - adding or removing a predecessor;
  - removing a pin.
- Nothing else moves dependent items: backlog bulk edits, My work, duplication,
  status changes, ADO imports (incoming dates are applied as reviewed, SPEC §7),
  personal spaces and direct item PATCH calls all change only the item they name.
  PATCH keeps its current behaviour.
- The resulting conflicts show on the timeline. "Reschedule" in the row menu or
  on a bulk selection runs the planner for the chosen items.

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
  `{ changes: [{ item, startDate?, startSecondHalf?, dueDate?, dueFirstHalf?, pin? }],
mode, expect? }`, where `mode` is `preview`, `apply` or `only`, and `pin` is
  `keep`, `set` or `remove`. With no `pin` given, the server applies the pin rule
  in 4.1.
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
- The existing item PATCH is unchanged. Item responses gain the additive
  `startSecondHalf`, `dueFirstHalf`, `startNoEarlierThan` and
  `startNoEarlierThanSecondHalf` fields; the drawer shows a pin
  under the start date.
- Working-half-day arithmetic and the planner's rules live once in
  `@kloister/shared` and are used by the API (moves) and the web (durations,
  totals, preview display).

## 6. Export

- The project Excel snapshot (SPEC §6.2), from the board, backlog, sprints and
  timeline alike, gains a **Timeline** sheet. Rows follow the timeline order with
  Excel outline levels (collapsible groups, summary rows above) and an indented
  title; columns Key, Title, Type, Assignees, Status, Start, Duration (working
  days, in halves, as a value, not a formula), Due, Work, Half days ("starts
  2nd half", "ends 1st half" where they apply), Start no earlier than,
  Predecessors (keys of readable predecessors only), Sprint. Summary rows carry
  their span as in 3.2.1, and a first "Plan" row and the Summary sheet give the
  plan's total span and working days.
- After those columns comes one column per week, from the earliest start to the latest
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

- One additive migration on `WorkItem`, approved by the owner on 2026-11-02:
  - `startSecondHalf Boolean @default(false)`: the item starts in the 2nd half;
  - `dueFirstHalf Boolean @default(false)`: the item finishes after the 1st half;
  - `startNoEarlierThan DateTime? @db.Date` and
    `startNoEarlierThanSecondHalf Boolean @default(false)`: the pin (4.1).
- Existing rows start in the 1st half, finish at the end of the day and have no
  pins, so nothing changes for them. Overdue still follows the due date and the
  optional M8.5 due time only; `dueFirstHalf` never makes an item overdue earlier.
- The automatic switch is a key in `Project.settings`, and the reschedule batch
  id is audit `meta`.
- ADO transfers stay date-only: the start half and pins are not exported, an
  import that changes a start date keeps any pin, and the half-day fields are
  left alone.
- Dependency types (start-to-start and so on), lag, milestones, baselines and a
  holiday calendar are out of scope (section 10) and would be additive later.

## 8. Files (expected)

API (`apps/api/src/`):

- `timeline/timeline.module.ts`, `timeline.controller.ts`, `timeline.service.ts`,
  `timeline.dto.ts`, `reschedule.ts` (pure move planner) with `*.spec.ts`.
- `prisma/schema.prisma` and one additive migration (section 7); item DTOs,
  mapper and PATCH validation accept the new fields.
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
  fields (with Morning/Afternoon for the halves, and the pin) use the reschedule flow; "Show on board" and
  "Show on timeline" in the drawer, card menu and backlog row menu.
- `e2e/timeline.e2e-spec.ts` covers:
  - creating items by typing and by pasting, indent and outdent;
  - the two-of-three date fields, half days, predecessors, pins, and moves both
    earlier and later;
  - summary and plan totals;
  - the confirm dialog on an existing project, automatic moving on a new one,
    the PM-only switch and Undo;
  - board/timeline/drawer links;
  - Member and Viewer limits and hidden-item non-disclosure;
  - keyboard-only use;
  - phone, tablet and light/dark screenshots;
  - the export download.

Docs: SPEC (done in planning), Help & FAQ article "Plan with the timeline",
README feature list, DESIGN (timeline bars, conflict style), DECISIONS.

## 9. Owner decisions (2026-11-02)

- Build the timeline as a project tab over existing items, with no Gantt
  library.
- Scheduling works like Microsoft Project, with as little friction as filling in
  a spreadsheet:
  - dependent items move earlier as well as later;
  - a deliberately later start is kept as a pin;
  - automatic moving is on for new projects;
  - existing projects keep the confirmation until a PM switches it on, which
    PMs can do from the dialog itself.
- Durations are working days (Monday to Friday) in half-day steps, named "1st
  half" and "2nd half" (Morning and Afternoon in the details panel), with no
  clock time defined for either.
- From the design mockups, layout A was chosen: a spreadsheet-first grid
  (key, title, start, days, due, predecessors, assignee) beside the bars, a
  plan totals strip above, and the week zoom by default.
- Parent rows show their total span, and the toolbar shows the plan's total
  working days.
- Rows can be selected together to set a sprint, create a sprint from their
  span, or assign them by clicking a sprint band (3.3.2).
- Timeline rows and bars open the item's drawer, for viewing and editing.
  Timeline, board and drawer link to each other ("Show on board", "Show on
  timeline").
- It is a new milestone, M9.
- The Excel export from the board (and other project screens) must include this
  timeline format, and every project workbook gets the Timeline sheet.
- Date edits in the item drawer follow the same rule as the timeline.
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

## 11. Open questions

None. The owner settled all three earlier questions on 2026-11-02 (section 9).
Implementation starts when the owner says go.

## 12. Verification

The usual gate: `npm ci && npm run format:check && npm run lint && npm run build
&& npm test`; API/db and browser test type checks and listing; database and
browser tests run in CI. Mock visual checks at phone, tablet and desktop widths in
light and dark themes, including a 500-item plan for scrolling and drag
performance. Independent review against SPEC and this plan before the commit.

## 13. Implementation notes

Where the implementation differs from the sections above, these notes and
DECISIONS apply.

- `GET /projects/:id/timeline` returns the visible links only. The rows come from
  the project's item list, which the project screens already load, so items are
  not fetched twice.
- Grid cells save when the edit is committed (Enter, Tab or leaving the cell), not
  when the row loses focus; a new row is created when its title is committed.
  Neither saves per keystroke.
- There is no draggable splitter or virtual scrolling: the column chooser
  narrows the grid, and rows render in one scroll area with the grid kept in
  view while the bars scroll sideways.
- Board cards and backlog rows have no menus of their own, so "Show on timeline"
  is in the item drawer's actions, one click from either. "Show on board" opens
  the item over the board.
- Bulk Assign replaces the assignees from the selection bar; adding one is under
  More…. A pasted list is previewed in a confirmation dialog.
- The Excel Timeline sheet uses ISO dates like the Items sheet and marks the
  current week in its header as "(today)" instead of outlining it.
- The Timeline sheet lists readable items only: a child whose parent the caller
  cannot see becomes a top-level row there, rather than sitting under a
  title-only parent row. The Summary sheet always names the plan's span.
- Typing Days for an item with only a due date starts it on that date and moves
  the due date out. Moves of dependent items name the first requested item as
  their trigger, also when several items were changed together (Shift dates,
  Link in order).
- `apply` after a preview compares the dependent moves' dates with the preview;
  a changed pin or kept list alone does not refuse it.
- A date edit that names no halves (an ADO import, a bulk edit) never fails on
  them: an impossible same-day order finishes the item at the end of the day.
- Owner refinements after the first CI run (2026-11-02): the Type cell is a
  menu of the types the hierarchy allows (it was read-only); columns resize with
  a drag handle on each header edge or the arrow keys on that handle (Home
  resets, "Reset column widths" in Columns); a Rows choice (Compact, titles on
  2 lines, titles on 3 lines) sets one row height for every row, so bars,
  arrows and the grid stay aligned, with the full title on hover; the optional
  Progress column became % complete (Done 100, otherwise the checklist share;
  parents weighted by working days). "Show on board" and "Show on timeline" are
  icon links in the drawer header rather than menu items, so read-only drawers
  keep their previous controls.
