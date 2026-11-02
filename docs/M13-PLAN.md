# M13: reports, workload with assignee shares, and the calendar

Planning baseline: 2026-11-02. Status: approved in outline by the owner (2026-11-02), including the assignee
share (one additive column). Owner decisions in section 7. Starts after M12 is committed.

## 1. Goals

- A few dashboards with real data that answer "are we on track, and is anyone overloaded?" without exporting
  to Excel.
- Workload that reflects how teams split work, using a share per assignee that takes no extra effort in the
  common case.
- A calendar of items and holidays for people who think in dates rather than bars.
- Everything live (M10) and filtered by visibility: nobody sees counts or names they could not see on the board.

## 2. Assignee shares

- Each assignment has a share, 100% by default (`WorkItemAssignee.share Int @default(100)`, 5–100 in steps of 5;
  migration). Existing assignments read 100, so nothing changes until someone sets a share.
- Shown only when not 100%: "Bo 25%" on chips, avatars' tooltips and the timeline Who cell.
- Setting it, with no dialogs:
  - in every assignee list (drawer, board card menu, timeline Who menu, bulk assign), each ticked person has
    inline **100 · 50 · 25** buttons at the end of the row; ← / → change it and digits type any value;
  - the timeline Who cell takes typed text: `Ann, Raj, Bo 25, Lee 25` (a name without a number is 100%);
  - clicking a share badge in the drawer cycles 25 → 50 → 100 and saves at once, with Undo;
  - the timeline selection bar gains "Share…": a person and a share for all selected rows.
- Who may change it: the plan setting applies (PMs, Leads, team Leads; the creator while unscheduled; Members
  when the setting is off). Assigning yourself still adds you at 100%.
- API: `assignees` accepts `{ userId, share }` objects alongside plain ids (plain ids keep 100), so existing
  clients keep working. Item responses gain `assigneeShares`. ADO export and Excel exports list shares
  ("Bo (25%)") where assignees are listed.

## 3. Reports (project › Reports tab)

Four dashboards, each a single page of tiles and one chart, all computed in the API from items the caller can
see (`ItemsService.scoped()`), over the project's working calendar (holidays, half days). Each tile links to the
board, backlog or timeline filtered to the same items.

| Dashboard   | Content                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | Items by status; overdue; due this week; done in the last 14 days; open items per bucket; ad-hoc open items                                                                                                                                                                                                                                                                                                                        |
| Sprint      | For the active (or a chosen) sprint: done vs remaining items and working days; a burndown of remaining working days per day; items added and removed after the start (from item history, by when they joined or left the sprint, not their creation date); unfinished items at risk (due after the sprint ends)                                                                                                                    |
| Workload    | People × weeks (8 weeks from this week, scrollable). Available = the week's working days (holidays and half days counted). Planned = for each dated, not-Done, non-ad-hoc item, its working days in that week × the person's share. Load = planned ÷ available: under 80% neutral, 80–100% amber, over 100% red ("overallocated"). A cell lists its items with their days and shares; unassigned planned work shows as its own row |
| Plan health | Items past due and not Done; items starting before their predecessors finish (timeline conflicts); Stories and Tasks without dates in an active sprint; items whose pin holds them later than their predecessors allow                                                                                                                                                                                                             |

- Charts use the existing design tokens (accessible colours, text labels, no colour-only meaning) and render as
  SVG without a charting library. Tables beside each chart give the numbers for screen readers.
- Live: while a dashboard is open, item, sprint and holiday events for the project refresh it (debounced to at
  most once every 2 seconds); a small "Updated just now" note shows when it changes.
- Export: each dashboard's numbers can be downloaded as a sheet in the project Excel export ("Reports" sheet);
  no PDF.
- Personal spaces: Overview and Workload only (for the owner).

## 4. Calendar

- Project › Calendar tab, month and week views; My work › Calendar for the viewer's items across projects.
- Items appear on their due date, or as a span from start to due (half days shown as half cells). Done items are
  dimmed; ad-hoc items show with their tag; items without dates are listed in a side panel "Not on the calendar".
- Instance and project holidays are shaded and named; sprint ranges show as a thin band at the top of each week.
- Dragging an item to another day moves its due date (and start, keeping the working duration), through the same
  reschedule flow as the timeline: plan setting, dependent moves (automatic or confirmed), Undo. Keyboard: focus an
  item, arrows move it by a day, Enter saves, Escape cancels.
- Filters: assignee, type, label, sprint; a "My items" toggle.
- Live: the calendar reads the project store and the live stream; presence shows on items being edited.
- Phone width: an agenda list grouped by day.

## 5. Live updates (M10) touch points

- Share changes are audited (`ITEM_UPDATED` with the assignee change) and therefore announced; workload and
  timeline Who cells refresh from the store.
- Reports subscribe to project events and recompute; calendar and My work calendar reuse the store and the
  user's own stream for cross-project items.
- Two-user browser tests: a PM sets a share and the Member's workload changes; a drag on one calendar shows on
  the other's timeline.

## 6. API (additive)

- `GET /projects/:id/reports/overview|sprint|workload|plan-health` (query: sprint, weeks, from), every role that
  can view items; numbers only from visible items.
- `GET /me/calendar?from&to` and the project items list's existing date filters for the project calendar.
- Assignee shares on item create, update and bulk routes as in section 2.

## 7. Owner decisions (2026-11-02)

1. Workload: amber from 80%, red above 100%.
2. Reports: every project member, Viewers included, with their visibility applied.
3. Calendar drag moves start and due, keeping the working duration.

## 8. Data model

- `WorkItemAssignee.share Int @default(100)` with a check (5–100). One additive migration. No other change.

## 9. Verification

- Unit: workload arithmetic (holidays, half days, shares, partial weeks), sprint burndown from history, share
  parsing in the Who cell, calendar layout of spans and half days.
- Database tests (CI): reports never count hidden items (per role and scope); shares permissions under the plan
  setting; history-based sprint additions.
- Browser tests (CI): set shares inline and by typing; workload cell lists items; calendar drag with Undo and
  holidays shown; reports update live with two users; phone agenda.
