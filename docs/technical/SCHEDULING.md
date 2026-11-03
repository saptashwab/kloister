# Scheduling and the timeline

The timeline (SPEC §6.4) plans items in half days, links them finish-to-start and moves dependent
items when dates change. The rules live in one pure module,
[`packages/shared/src/schedule.ts`](../../packages/shared/src/schedule.ts), used by the API (which
applies changes) and by the web app (which shows durations, totals and previews), so both always
agree.

## Dates and half days

- An item has a `startDate` and a `dueDate` (calendar dates, `YYYY-MM-DD`, read in UTC like every
  date in the app). Either may be missing.
- Each working day has a 1st and a 2nd half, with no clock times. `startSecondHalf` means the item
  starts in the 2nd half of its start date; `dueFirstHalf` means it finishes after the 1st half of
  its due date. The grid shows these as "5 Nov, 2nd half" and "7 Nov, 1st half".
- The optional `dueTime` (`HH:MM` in the API, stored as minutes after midnight) is a reminder on the due date for the board and
  notifications. It plays no part in scheduling.

## Working days and holidays

Working days are Monday to Friday minus holidays. Internally every working half day is a _slot_:
consecutive integers that skip weekends and holidays, so durations and links are integer
arithmetic.

- A `WorkCalendar` is built from holiday ranges (`workCalendar()`); weekend days inside a range are
  ignored.
- A project's calendar is its own holidays plus, unless the project setting `useInstanceHolidays`
  is off, the instance-wide holidays (`HolidaysService.calendar()` in `apps/api/src/holidays/`).
- Holidays are whole days. Adding one never moves items: durations are kept as working time, so a
  bar that crosses a new holiday simply covers it. Administrators' instance changes are listed for
  a project's PMs and Leads, who mark them reviewed (`holidaysReviewedAt`); removed holidays keep
  their row with `deletedAt` so the list can show them.

## Durations

The working duration of an item is the number of working half days from its start slot to its
finish slot, divided by two (`workingDuration()`), so durations read "4" or "2.5" days. An item
with only one date has no duration of its own (0); in a parent's span that date counts as one half
day toward the span and adds nothing to the work total. Typing a duration sets the due date from the start
(`finishAfter()`); durations must be positive multiples of a half day (`isValidDuration()`).

## Links and pins

- Dependencies (`WorkItemDependency`, "blocked by") are finish-to-start links without lag: a
  successor may start at the half day after its latest predecessor finishes (`earliestStart()`).
  Only predecessors with a due date constrain.
- A pin, "start no earlier than" (`startNoEarlierThan` and `startNoEarlierThanSecondHalf`), holds an
  item later than its predecessors would allow.
- Pins are managed by the pin action of a change (`PinAction`):
  - `auto` (default): when a Not started item with constraining predecessors gets a start later
    than its earliest start, that start becomes its pin; a start earlier than allowed is moved
    ("snapped") to the earliest start and the pin is cleared;
  - `keep` leaves the pin; `set` pins the new start; `remove` clears it and moves the item to its
    earliest start;
  - an exact `pinTo` (used by Undo) replaces whatever the rule decided.
- Orphaned pins (v1.4.0): under `auto`, a requested change whose item has no start or no visible
  predecessor drops its pin. The API also drops it when an item update leaves the item without a start
  (`ItemsService.update`) and when the last predecessor link the caller can see is removed
  (`DependenciesService.remove`); each is audited as a `startNoEarlierThan` change.

## The planner

`planSchedule(items, edges, requested, calendar)` takes the visible items, the links whose both
ends are visible and the requested changes, and returns:

- `changes`: every item that changes, requested ones first, then in dependency order, each with its
  dates and pin before and after, whether it was requested and whether its start was snapped;
- `kept`: dependent items that would have moved but stay, with the reason (`KeptReason`):
  - `NOT_EDITABLE`: the caller may not change the item's plan;
  - `STARTED`: it is in progress, blocked or done, and only Not started items move;
  - `PINNED`: its pin holds it where it is.

Rules:

- Requested dates apply first. Then the planner walks the successors in topological order: a Not
  started successor that the caller may change, with dates, moves so that it starts at
  `max(earliest start, pin)`, keeping its duration. It moves earlier as well as later.
- The chain stops at items that stay (started, not editable, pinned, undated, or without
  constraining predecessors).
- Hidden items and links are never passed in, so they are never moved, counted or used as a
  constraint.

## Rescheduling through the API

`POST /api/v1/projects/{id}/timeline/reschedule` (`TimelineService.reschedule()` in
`apps/api/src/timeline/`) runs in one serializable transaction:

1. Every requested item is resolved through the visibility filter first, so a hidden item answers
   404 before any other check. Each must pass the plan rule (`canPlanItem`), else 403.
2. The planner runs on all visible items and links with the project's calendar.
3. `mode` decides what happens:
   - `preview`: return the plan; nothing changes;
   - `apply`: apply the requested changes and the dependent moves;
   - `only`: apply only the requested changes (their own pin rule or snap still applies).
4. Checks against concurrent edits, both answering 409 `CONFLICT`:
   - `expect` maps item ids to the version (`updatedAt`) the caller saw; any difference refuses
     the request;
   - `previewed` lists the dependent moves a preview showed; `apply` refuses when the plan now
     differs.
5. Each changed item is saved through the ordinary item update, with its own audit entry. All
   entries share a `rescheduleId`; moved items also name the item that triggered the move.

## Automatic and confirmed moves

The project setting `autoMoveDependents` decides how the web app uses this route
(`apps/web/src/app/core/reschedule.ts`):

- **On** (new projects): the change applies at once with dependent moves; a version conflict is
  retried once with fresh data.
- **Off** (projects from before M9, or switched off by a PM): the app previews first. If only the
  requested items change, it applies directly; otherwise a dialog lists the moves and kept items
  and asks whether to move the dependent items, change only the requested ones, or cancel. A PM can
  switch automatic moving on from the dialog.

Either way the toast offers **Undo**, which sends the old dates and exact pins of every changed
item in `only` mode, with their new versions as `expect`: all or nothing, refused if any of them
changed since.

The item drawer uses the same flow for date fields, so a date changed there moves dependent items
by the same rules.

## Ad-hoc items and sprints

Ad-hoc items (M12) are not part of the plan: the planner, the grid, parent spans, plan totals and
the Excel Timeline sheet leave them out, and the API refuses to reschedule them. The timeline shows
how many there are, with a link to the board. Epics and Features have no sprint of their own; the
grid shows their stories' sprints read-only, and a Task or Bug in another sprint than its Story
is marked.

## Who may change the plan

The plan of an existing item is its title, type, parent, sprint, dates, half days, pin and
dependencies. While `planLeadsOnly` is on (the default), only PMs, Leads, the item's team Leads and,
for an item they created that is not yet scheduled, its Member creator may change it. An item is
scheduled once it has a start or due date, a sprint, or a link or child the creator can see; the
change that schedules it is the creator's last. Members still set all of these when creating an
item. See [SECURITY.md](SECURITY.md#project-roles-and-permissions).

## Shares, workload and calendar moves (M13)

Each assignment has a share (5–100%, default 100). The workload report
(`apps/api/src/reports/report-logic.ts`) takes every visible, dated (start and due), unfinished,
non-ad-hoc item, counts its working days in each week with `workingDaysWithin()` (half days and the
project's holidays included) and multiplies them by each assignee's share; unassigned work gets its
own row. A week's available days are its working days (`workingDaysIn()`). Planned ÷ available is
amber from 80% and red above 100%. Items with only one date are not counted.

The calendars move an item with `moveFinishTo()`: the due date moves to the chosen day (back to
the previous working day if it is a weekend or holiday) and the start follows so the working
duration stays the same. The change then goes through the ordinary reschedule flow, so the plan
setting, dependent moves and Undo apply as on the timeline. Ad-hoc items and personal spaces, which
have no timeline, save the new dates with an item update.

The sprint report's burndown sums the working days of the items that were in the sprint at the end
of each working day and not yet finished; sprint membership is worked back from the items' history
(`ITEM_UPDATED` and `SPRINT_FOLLOWED` entries), so additions count from when an item joined.

## Parent spans and plan totals

Parents on the timeline show a summary bar from the earliest start to the latest finish of their
visible dated descendants without children (`scheduleSpan()`, used by
`apps/web/src/app/core/timeline-logic.ts`). The span reports both its working duration (first start
to last finish) and the sum of the items' own durations. The plan total row spans every visible
dated item without visible children. Summary spans are computed, never stored, and parents' own
dates are not changed by them.

## Excel Timeline sheet

Project Excel snapshots include a Timeline sheet (`apps/api/src/items/snapshot-timeline.ts`): the
readable items in hierarchy order with Excel outline levels, summary spans for parents, a plan row,
a sprint row and a holidays row, then one column per week (at most 156) filled for each item's
dates. Durations skip the project's holidays. Only items the caller can read are included.

## Microsoft Project file

`GET /api/v1/projects/{id}/timeline/msproject` (`TimelineService.msProject()`, built by the pure
`msProjectXml()` in `apps/api/src/timeline/msproject.ts`) writes the readable plan as Microsoft
Project XML (Project 2007 schema; elements in schema order). Rows follow the outline order with the
key in WBS; rows with children are summary tasks. Half days map to 08:00–12:00 and 13:00–17:00 in an
8-hour, Monday–Friday calendar whose exceptions are the project's holidays (overlaps merged).
Dated tasks get a Start No Earlier Than constraint at their start, so Project keeps Kloister's
dates and still moves tasks that their finish-to-start links push. Assignees become resources with
their shares as assignment units; undated tasks get an estimated day.

## Row order and dragging

Rows keep their siblings' outline order (`WorkItem.outlinePosition`, see `compareOutline`).
Dragging rows (`pages/timeline/row-drag.ts`) computes the drop in `dropTarget()` against the rows
left once the dragged ones are taken out, shows it at once with `applyOutlineMoves()` (the server's
placement rule) and saves the placements one after another through `POST items/:item/outline`.
