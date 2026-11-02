# M12: items in and out of the plan, trash and item references

Planning baseline: 2026-11-02. Status: approved in outline by the owner (2026-11-02); owner decisions in section 8.
Starts after M11 is committed.

## 1. Goals

- New items land where the PM wants them, not in whichever bucket happens to be first.
- Sprints follow the hierarchy: Stories are planned into sprints; their Tasks and Bugs follow; Epics and
  Features show their children's sprints.
- Ad-hoc items (a call, a quick check) are shared and tracked but never part of the plan.
- Deleted items can be restored for a while instead of being gone at once.
- Typing an item key in text links to it.
- Everything stays live (M10): every change here is audited and therefore announced, and every new screen reads
  the live project store.

## 2. Default bucket for new items

- Project setting (PM, Settings › General): "New items start in" — a bucket of the project. Default: the
  first bucket, so nothing changes until a PM chooses.
- Used wherever a Story, Task or Bug is created without a bucket being chosen: timeline rows and paste, New item
  (preselected), duplication when the source bucket is gone, ADO import of new rows (unless mapped).
- If the caller cannot create items in that bucket (BUCKETS scope), the first bucket they can use is taken, as
  today. Deleting the chosen bucket resets the setting to the first bucket (like the status map).
- Stored in `Project.settings` (`newItemBucketId`), no migration.

## 3. Sprints follow the hierarchy

| Type                                         | Sprint                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Epic, Feature                                | No sprint of their own. The drawer, backlog and timeline show the sprints of their children, read-only ("Sprints 3–5"). The API refuses a sprint on them (400)                                                                                                                                                             |
| Story                                        | Has the sprint; the unit planned into sprints                                                                                                                                                                                                                                                                              |
| Task, Bug under a Story                      | Follow their Story: when the Story's sprint changes, children whose sprint was the old one (or none) move with it, in the same transaction and audit (one Undo). A child may still be put into another sprint on purpose; it then shows a small "Not in its story's sprint" marker (drawer, backlog, timeline Sprint cell) |
| Task, Bug under a Feature, or without parent | Own sprint, as today                                                                                                                                                                                                                                                                                                       |

- A child created under a Story starts in the Story's sprint unless another is chosen.
- Closing a sprint moves unfinished Stories with their unfinished children that were in the same sprint (to the
  chosen sprint or the backlog), never splitting a Story from its Tasks silently.
- Timeline sprint bands, bulk "set sprint" and "new sprint from selection" apply the same rules; selected Epics
  and Features are skipped and reported.
- The plan setting (M9.2) still applies: changing a sprint is a plan change.
- Upgrade: existing sprints on Epics and Features are handled per decision 8.1.

## 4. Ad-hoc items

- A yes/no field `adHoc` on work items (migration, default false). Set in New item ("Ad hoc: not part of the
  plan"), in the drawer and as a timeline-free quick option on the board's quick add. Shown as a small "Ad hoc"
  tag on cards and rows.
- Ad-hoc items: no parent, no children, no dependencies (API refuses with 400; the pickers hide the options);
  any type that needs no children (Task or Bug; Epics, Features and Stories cannot be ad hoc).
- Shown on the board, backlog (in their own collapsible "Ad hoc" group), My work, search, notifications and due
  reminders, and in the normal Excel export. Left out of the timeline rows and bars, plan totals, parent spans,
  scheduling, the Excel Timeline sheet and the plan-health report (M13). The timeline shows a quiet line "N
  ad-hoc items are not in the plan (show on board)".
- Sprints: allowed if someone puts one in a sprint on purpose (some teams track calls in the sprint); not
  counted in sprint workload (M13) unless dated.
- Plan setting: anyone who can create items may create ad-hoc items. Turning an existing item into an ad-hoc
  item, or back, is a plan change (PMs, Leads, team Leads, or the creator while unscheduled).
- ADO export: per decision 8.2.

## 5. Trash and restore

- Deleting no longer removes rows at once: the item and, for a cascade, its subtree are marked deleted
  (`deletedAt`, `deletedById`, `deleteBatchId`; migration). Notes, attachments, checklist, assignees, labels and
  links are kept with them.
- Deleted items disappear from every screen, list, count, export, report, search, notification target,
  timeline and scheduling. `ItemsService.scoped()` adds `deletedAt: null`; every documented unscoped query is
  reviewed and gets the same filter; database tests cover each route family.
- Project › Trash (a page in project settings' area, visible to anyone who may delete something in the
  project): deleted items with who deleted them and when, grouped by delete batch, newest first, with Restore and
  (PMs) Delete permanently. Only items the viewer could see are listed.
- Restore: whoever could delete the item, and PMs and Leads for anything in their project. A batch restores
  together. If the parent is still deleted, the item is restored without a parent (with a note in the toast)
  unless the parent is restored in the same action. Dependency links come back when both ends are active.
  Restored items keep their number.
- The delete toast keeps its Undo (now a restore), so a mistaken delete is one click to undo.
- Purge: a nightly job deletes batches older than the retention (decision 8.3) for good, with their files, and
  records one audit entry per batch. "Delete permanently" (PMs) does the same at once.
- Personal spaces have their own trash (owner only). Admin audit excludes personal entries as today.
- Live updates: delete sends `item-removed`; restore sends `item-changed` for the batch; the Trash page updates
  live.

## 6. Item references in text

- In descriptions and notes, a project key and number (`KLO-12`), or `#12` for the same project, becomes a link
  when the text is saved: the server records it as a reference mark, like mentions, so it survives editing.
- Display: the key as a link with the item's type icon; hovering or focusing shows a small card (title, status,
  assignees, due); clicking opens the item's drawer. Typing `KLO-` or `#` offers an autocomplete of visible
  items, like `@` mentions.
- Non-disclosure: a reference to an item the reader cannot see renders as plain text (no title, no link, no
  hint it exists). References to other projects link only if the reader is a member there.
- Live updates: previews read the live store, so a referenced item's new status shows at once.
- The item's drawer gains a small "Referenced in" list (items whose text mentions it, visible ones only).

## 7. Live updates (M10) touch points

- New audit actions (`ITEM_TRASHED`, `ITEM_RESTORED`, `ITEM_PURGED`, `SPRINT_FOLLOWED`) are added to the live
  event mapping; the settings change (`newItemBucketId`) produces `access-changed`/`board-changed` as other
  settings do.
- Busy-item deferral and highlights apply to restored and moved items like any other change.
- Database tests extend the M10 publishing tests to trash, restore and purge; browser tests use two users (one
  deletes, the other sees it disappear; restore brings it back).

## 8. Owner decisions (2026-11-02)

1. Existing sprints on Epics and Features are cleared at upgrade; the release notes list how many per project.
2. Ad-hoc items are left out of ADO export by default, with an "Include ad-hoc items" option.
3. Trash retention: 30 days, admin-configurable from 1 to 365.
4. Closing a sprint moves an unfinished Story together with its unfinished children from that sprint.

## 9. Data model

- `WorkItem`: `adHoc Boolean @default(false)`, `deletedAt DateTime?`, `deletedById String? @db.Uuid`,
  `deleteBatchId String? @db.Uuid`, index on `(projectId, deletedAt)`.
- Reference marks stored in the sanitized HTML (`<a data-ref="<uuid>">`), no table; "Referenced in" uses a small
  `ItemReference` table (source item, target item, project) maintained on save — or, if review prefers, a
  query over the HTML (decided during implementation, recorded in DECISIONS).
- One additive migration generated offline as usual.

## 10. Implementation notes (2026-11-03)

Built as planned; the choices made while building are in docs/DECISIONS.md (M12). In short: the trash
condition lives in the shared scope filter, delete answers the batch for Undo, trash retention is part of the
admin storage settings, references store the canonical key and are redacted per reader, and "Referenced in"
uses the `ItemReference` table.

## 11. Verification

- Unit: sprint-follow rules, ad-hoc validation, reference parsing and rendering, restore with missing parents.
- Database tests (CI): permission matrix for trash, restore and purge per role and scope; every item route
  family ignores deleted items; sprint follow and close; ad-hoc constraints; references never disclose hidden
  items.
- Browser tests (CI): default bucket on the timeline; Story sprint change moving its Tasks with Undo; ad-hoc
  item on the board but not the timeline; delete, Trash, restore; `KLO-12` link and preview; two-user live
  check for delete and restore.
