# Manual Azure Boards CSV transfer

Use **ADO transfer** (the last tab of an ordinary project) to move work between Kloister and
Azure Boards with CSV files. This is separate from **Export…**, which makes Excel/offline reading
copies for every role. Neither the browser nor the backend contacts ADO, asks for a token or
fetches anything mentioned in imported HTML: you carry the files.

Who can do what:

- Project PMs and project Leads export.
- Only project PMs change transfer settings, bring files back from ADO, link IDs, apply changes
  and cancel pending creates.
- Team leadership and system administration add nothing. Personal spaces are excluded, and
  archived projects accept no transfer writes (prepared files stay downloadable).
- In ADO, importing CSV files needs Project Administrators (or Team Foundation Administrators)
  membership in the ADO project.

## Set up once per project

1. In the ADO project, run a query with the columns ID, Work Item Type, Title, State, Assigned To,
   Tags, Iteration Path and any date fields you use, then choose **Export to CSV**.
2. In Kloister, open **Transfer settings**, choose that file under **Start from a sample**, enter
   the organization (or collection) and ADO project, and check the suggestions:
   - process, types and states (presets follow Microsoft's default Basic, Agile, Scrum and CMMI
     processes; customized processes may differ),
   - each ADO state's status and existing bucket (no buckets, sprints, accounts or memberships are
     ever created),
     including the states of any extra or custom ADO types you import; update files send a
     state of the row's own ADO type and keep the ADO state when that type has none for the status,
   - tags (a tag without a label stays in ADO only and is kept when Kloister updates tags),
   - iterations, and the date order of the exported dates.
3. Save. People are matched by email; add a row only for someone who uses another address in ADO.
   Dates are sent only for the types you tick, because ADO silently drops a date its type does not
   have (an Agile Task has no Target Date). Optional due times stay in Kloister: files carry the
   calendar date only, and imports never set a time (an imported date change keeps the
   item's local due time).

A PM can tick **Require Detailed review** to make every transfer in the project use Detailed review.

## Quick and Detailed review

Every export and import offers **Quick review** (the default) or **Detailed review**.

- **Quick** compares each field with the last sync. A field changed on only one side takes that
  side's value; you choose only where both sides changed. One summary ("Update: 3 · Sent to ADO:
  Status ×2") is shown before anything is prepared or applied. Rows that match no item still need
  an explicit confirmation as new (one button confirms them all) or a manual match.
- **Detailed** asks about every difference, shows both last-synced values, and asks you to confirm
  links, rows, parents, labels and assignees one by one.

Both modes keep the same safety rules: permissions, idempotent retries, refused stale previews,
tombstones, duplicate/unknown reference blocking, and "missing rows never delete anything".

## Start with Kloister work

1. **Export to ADO**: choose the whole project, a sprint, a subtree or exact items (Backlog's
   **Transfer selected to ADO** carries a selection); label filters combine with it. Parents are
   included by default. Preview, then **Prepare reviewed CSV files** and download the ZIP.
2. In ADO: **Boards > Queries > Import work items**, choose the create file, check the rows and
   **Save items**. New items start in ADO's default state and, by Microsoft's guidance, without an
   assignee; Kloister keeps your intended state and assignee for the next step.
3. Export those items from ADO (with Description, which carries a small `Kloister reference:`
   footer) and bring the file back under **Import from ADO** in **Link returned IDs only** mode.
   Apply. ADO's defaults do not overwrite your local state or assignees.
4. Choose **Prepare the follow-up update (state and assignee)**, preview and prepare it, and import
   that update file in ADO the same way.

If the footer was removed, match each row to its waiting item by hand. Titles and row order are
never used to identify items.

## Start with ADO work, then keep both in step

- Bring an ADO export back in **Import reviewed local changes / new rows** mode, confirm the new
  rows and apply. New items, their links and audit entries are saved together.
- Later exports and imports match by ADO ID. Update files carry **only the fields you changed
  locally**, in flat ID / Work Item Type / Title files; anything Kloister cannot represent (an ADO
  assignee who is not a member, unmapped tags, an ADO state that shares a local status with others,
  Area Path, embedded images) is never written back.
- A local parent change is reported but not sent: change the parent in ADO.
- An update needs a recent ADO export of the item, brought back by a PM (**Review remote
  observations for later export** records it without changing anything). CSV cannot lock ADO or
  notice edits made after that export; the preview asks you to acknowledge this.

## Recovery, storage and limits

- **Transfer history** lists prepared files and reviews. Pending creates block another create for
  the same items until their IDs are linked or the batch is cancelled. Cancelling cannot undo an
  import already made in ADO, and replaying a create file in ADO can create duplicates.
- Files without organization and project columns need an explicit destination acknowledgement;
  contradictory provenance is rejected.
- Uploads are limited to 10 MiB, 1,000 data rows and 1 MiB per cell; nothing is truncated. Exports
  write UTF-8 with BOM, CRLF and RFC 4180 quoting, at most 1,000 rows per file; create files split
  only between whole trees. Cells starting with `=` are refused; `+`, `-` and `@` are sent as text,
  so open transfer files only in ADO, not in a spreadsheet.
- Dates are written as `YYYY-MM-DDT12:00:00Z`, which ADO's import accepts under any user locale.
  Exported dates follow the exporting user's locale and time zone (for example
  `02/11/2026 05:30:00`); Kloister reads the date ADO showed that user.
- Transfer records live in PostgreSQL and are included in database backups. Raw uploads are not
  stored. Unapplied previews are cleared after 7 days and completed content after 90 days; links,
  observations, tombstones, pending work and retry receipts are kept.
- Descriptions are sanitized; embedded images, attachments, comments, dependencies and history are
  outside CSV transfer. Checklists, extra assignees and optional notes are added to the ADO
  description as labelled text and never read back into structured data. In Agile and CMMI, a
  Bug's main text is Repro Steps; Kloister uses Description.

## What was verified

Formats and behaviour were checked against Microsoft's
[CSV guide](https://learn.microsoft.com/en-us/azure/devops/boards/queries/import-work-items-from-csv?view=azure-devops)
and [process guidance](https://learn.microsoft.com/en-us/azure/devops/boards/work-items/guidance/choose-process?view=azure-devops),
and against a disposable Azure DevOps Services organization with Agile, Scrum, Basic and a
customized (inherited Agile) project: real exports are the test fixtures, and create, link-only
and follow-up update files were imported through the web UI in all four. Automated tests never
contact ADO. Azure DevOps Server and CMMI remain **unverified until an operator runs the drill
below**. Users find a step-by-step walkthrough with screenshots in the app's **Help &
FAQ**; [ADO-TRANSFER-GUIDE](ADO-TRANSFER-GUIDE.md) is the same guide as text.

## Operator acceptance drill

Back up the database and files first ([UPGRADE](UPGRADE.md)) and use a disposable Kloister project
and ADO project, never production work.

1. Set up from a sample export as above. Export a small Feature → Story → Task tree with one
   non-default task status; import it in ADO and save.
2. Bring the export back in link-only mode; check that local status and assignees are unchanged.
   Prepare the follow-up update, import it, and check the state and assignee in ADO.
3. Add a child under the linked Story locally; export, import, link its new ID.
4. Change a title only in ADO and bring it back with Quick review: it is taken. Change the same
   title on both sides: you are asked. Make a local edit after previewing: apply is refused until
   you preview again.
5. Import two new ADO items, one at a time; repeat a file and retry an apply: counts stay stable in
   both systems. Missing rows delete nothing.
6. Check pending recovery, manual matching without the footer, cancelled-create warning, deleted
   item refusal, and that Members, Viewers, team Leads and administrators without a project role
   cannot transfer.
