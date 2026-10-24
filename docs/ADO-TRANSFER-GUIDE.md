# ADO transfer: step-by-step guide

This guide walks a project PM through moving work between a Kloister project and an Azure
DevOps (ADO) project with CSV files: first setup, the everyday **Quick review** round trip,
the **Detailed review**, and what differs for the Agile, Scrum, Basic and customized
processes. [ADO-EXPORT](ADO-EXPORT.md) is the reference for every rule and limit.

Kloister never connects to ADO. You carry CSV files between the two: export from one,
import into the other. The same guide, with screenshots, is in the app under **Help &
FAQ** (topic "ADO transfer"), so users never need this file.

## Two ways to start

Work can start on either side:

- **Starting in Kloister** (sections 2 and the follow-up steps): export to ADO, import there,
  bring ADO's export back to link the new IDs, then send state and assignee.
- **Starting in ADO** (section 3): export from ADO and import into Kloister as new items.

After either start, items are linked by ADO ID and you keep both sides in step in both
directions (section 5).

## Who can do what

- **Project PM**: everything below, including transfer settings and bringing ADO files back.
- **Project Lead**: export to ADO only.
- Members, Viewers and system administrators without a project role cannot transfer.
- In ADO, importing CSV files needs **Project Administrators** (or Team Foundation
  Administrators) membership in the ADO project.

## Before you start: work that exists on both sides

Kloister links an ADO row to a Kloister item only through the reference it put into a create file, or by your hand match to an item still waiting for its returned ID. It cannot link an item that already existed in ADO to one that already existed in Kloister, and titles are never used to match. So when the same work already exists on both sides, importing either way creates a duplicate.

- Choose one side as the source for each piece of work before the first transfer.
- Starting in Kloister: export only items that do not exist in ADO yet (use exact items or a subtree instead of the whole project). If ADO already has some of them, close or remove those ADO items first, or leave them out of the export.
- Starting in ADO: import only rows that do not exist in Kloister yet. Use Detailed review to select individual rows, or export a narrower ADO query. If Kloister already has some of them, delete or archive the Kloister copies first, or leave those rows out.
- After the first transfer, use only linked items for updates. A row that matches no linked item always needs your confirmation before it becomes a new item.

## Before you start: protect valuable data

Use Detailed review for the first transfer of a project and whenever a file contains more than you meant to change. Quick review takes a field changed on one side only, and a cell someone cleared counts as a change: if a date, iteration, assignee or description was emptied in ADO since the last sync, a Quick import empties it in Kloister too.

- Export from ADO only the columns you want to sync. A column that is not in the file is never changed in Kloister.
- Before the first import into ADO, export the ADO project to CSV as a record of its state; ADO also keeps each work item’s history, which shows and can restore earlier field values.
- Ask the Kloister administrator for a fresh backup before a large first import into Kloister.
- Read the preview summary every time: it lists what will be created, linked, updated or left unchanged, and every field sent or taken.
- Bring back a recent ADO export (Review remote observations for later export) before preparing an update file, and import that update in ADO soon after: CSV cannot lock ADO, so edits made in ADO after that export can be overwritten by the fields you send.

## What is never overwritten or deleted

Missing rows never delete anything on either side, and deleting an item in one system never deletes it in the other; a deleted Kloister item is never recreated by a later import. Update files send only fields you changed in Kloister, never ADO values Kloister cannot represent: people outside the project, tags without a label, Area Path, a state shared by several statuses, and an ADO description with embedded images unless you explicitly choose to replace it. ADO comments, attachments, history, links other than parent and fields Kloister does not map are never touched. In Kloister, imports never change checklists, notes, files, dependencies or extra assignees, never create buckets, sprints or accounts, and create labels only when you choose to. A field changed on both sides is never decided for you.

## 1. Set up once per project

1. In the ADO project, open **Boards > Queries**, create a flat query (**Flat list of work
   items**) that returns a few existing items, and add the columns **ID, Work Item Type,
   Title, State, Assigned To, Tags, Iteration Path** and any date fields you use. Run it and
   choose **Export to CSV** from the **⋯** menu.
2. In Kloister, open the project's **ADO transfer** tab, then **Transfer settings**.
3. Enter the ADO organization (or collection) and project name. Under **Start from a
   sample**, choose the exported file. Kloister suggests the process, the work item types,
   each ADO state's status and bucket, tags, iterations and the date order.
4. Check every suggestion, then **Save**. Kloister never creates buckets, sprints, accounts
   or memberships; map ADO states to existing buckets.

People are matched by email. Add an identity row only for someone who uses a different
address in ADO. Tick a date for a type only if that ADO type has the field (an Agile Task
has no Target Date, and ADO silently drops a date its type does not have).

## 2. Starting in Kloister (Quick review)

Quick review is the default. A field changed on only one side since the last sync takes
that side's value; you choose only where both sides changed, and one summary is confirmed
before anything is prepared or applied.

### Export and create in ADO

1. **Export to ADO**: choose what to send: the whole project, a sprint, a subtree, or exact
   items (select rows in the Backlog and use **Transfer selected to ADO**). Parents are
   included by default so the hierarchy survives.
2. **Preview export CSV**, read the summary and warnings, then **Prepare reviewed CSV
   files** and **Download reserved CSV files** (a ZIP with one or more CSV files).

3. In ADO: **Boards > Queries > Import work items**, choose the create file, check the
   preview and **Save items**. New items start in ADO's default state and without an
   assignee; Kloister remembers the intended state and assignee for step 5.

### Bring the new IDs back

4. In ADO, export the new items with a flat query that includes **ID, Work Item Type,
   Title, State and Description** (the Description carries a small `Kloister reference:`
   footer that links each row to its Kloister item). In Kloister, open **Import from ADO**,
   keep **Link returned IDs only**, choose the file and **Preview incoming CSV**, then
   **Apply**. ADO's defaults do not overwrite your local status or assignees.

### Send state and assignee

5. Choose **Prepare the follow-up update (state and assignee)**, confirm the freshness
   notice, preview and prepare it. Import that update file in ADO the same way as in
   step 3. It carries only ID, type, title and the fields being sent.

From now on, items match by ADO ID. Later exports send only the fields you changed in
Kloister, and later imports take changes made in ADO.

## 3. Starting in ADO (Quick review)

1. In ADO, export the items with a flat query (as in setup).
2. In Kloister, **Import from ADO**, choose **Import reviewed local changes / new rows**,
   choose the file and **Preview incoming CSV**.
3. Rows that match no Kloister item need your confirmation: **Confirm all unmatched rows
   as new items** (or match a row to an existing item by hand). Preview again and
   **Apply**. Each new item gets its bucket from the state mapping.

Bringing the same file back again changes nothing: counts stay the same in both systems,
and rows missing from a file never delete anything.

## 4. Detailed review

On the Export to ADO or Import from ADO tab, switch the review toggle to **Detailed
review** when you want to approve every
change: every difference, link, row, parent, new label and assignee needs an explicit
choice, and the last-synced values are shown beside the local and ADO values. A PM can
make Detailed review mandatory for the project under **Transfer settings**.

Typical uses: the first import of a large ADO backlog, a file that several people edited,
or a change you want to audit field by field.

## 5. Keep both sides in step

- **Update ADO from Kloister**: an update needs a recent ADO export of the items. Bring it
  back with **Review remote observations for later export** (this records ADO's values
  without changing Kloister), then export. The update file carries only fields you changed
  locally; values Kloister cannot represent (people outside the project, unmapped tags,
  Area Path, embedded images) are never overwritten.
- **Update Kloister from ADO**: bring an ADO export back in **Import reviewed local changes
  / new rows** mode. Fields changed only in ADO are taken; fields changed on both sides
  ask you to keep Kloister's value, take ADO's or skip.
- A parent changed in Kloister is reported but not sent; change it in ADO.
- **Transfer history** lists prepared files and reviews. A pending create blocks another
  create for the same items until its IDs are linked or the batch is cancelled.

## 6. Process notes

| Kloister | Agile      | Scrum                | Basic                          | Customized |
| -------- | ---------- | -------------------- | ------------------------------ | ---------- |
| Epic     | Epic       | Epic                 | — (left out, children move up) | as mapped  |
| Feature  | Feature    | Feature              | Epic                           | as mapped  |
| Story    | User Story | Product Backlog Item | Issue                          | as mapped  |
| Task     | Task       | Task                 | Task                           | as mapped  |
| Bug      | Bug        | Bug                  | Issue                          | as mapped  |

**Agile.** States New, Active, Resolved, Closed (and Removed). Check what Resolved maps
to: it is usually In progress. A Bug's main text in ADO is Repro Steps, but Kloister
writes Description.

**Scrum.** Product Backlog Items use New, Approved, Committed, Done; Tasks use To Do,
In Progress, Done. Map Approved and Committed deliberately: both are "not done", but you
may want Approved in a backlog bucket and Committed in an active one.

**Basic.** Basic has three levels, so Kloister Epics are left out of the files and their
Features become ADO Epics; the preview warns about this. Stories and Bugs both become
Issues, so a returned Issue needs a reverse type in **Transfer settings** (usually Story).
States are To Do, Doing, Done. Leaving the Epic out never changes the Feature's parent in
Kloister.

**Customized (inherited) processes.** Set the profile to **Custom** or start from the
closest preset, then upload a sample export from the customized project so its extra
states and types appear:

- Map every extra state to a status and bucket (for example **In Review** → In progress).
  Unmapped states are reported and never guessed.
- Give extra work item types (for example **Spike**) a reverse type so they can be
  imported. Kloister creates items only with the types in its own mapping, so a Spike
  started in ADO is imported as, say, a Story and stays a Spike in ADO: updates send that
  row a state of its own type.
- Required custom fields (for example **Team Code**) can be sent as constant columns on
  create files. ADO keeps a constant only on types that have the field.

All four were checked live in a disposable Azure DevOps Services organization: create,
link returned IDs, and follow-up update. CMMI and Azure DevOps Server have not been
checked; run the operator drill in [ADO-EXPORT](ADO-EXPORT.md) before relying on them.

## 7. If something goes wrong

- **ADO rejects a row on import**: read ADO's message (for example "not in the list of
  supported values" for State). Fix the state mapping in **Transfer settings**, bring a
  fresh ADO export back with **Review remote observations for later export**, and prepare
  the update again.
- **"Choose … (changed on both sides)"**: someone changed the same field in both systems.
  Pick which value wins, or skip it.
- **Apply is refused after a preview**: Kloister data or settings changed after the
  preview. Preview again.
- **A create file was imported twice in ADO**: the returned export is refused because two
  rows carry the same reference. Delete the duplicates in ADO, export again and link.
- **Missing footer**: if the `Kloister reference:` footer was removed from a description,
  match that row to its waiting item by hand. Titles are never used to identify items.
