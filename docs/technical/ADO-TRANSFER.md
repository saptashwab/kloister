# ADO transfer internals

Kloister exchanges work items with Azure DevOps (ADO) through CSV files that a person carries
between the two systems. The server never connects to ADO and holds no ADO credentials. This
document describes how the transfer is built; the user-facing guides are
[ADO-TRANSFER-GUIDE.md](../ADO-TRANSFER-GUIDE.md) (step by step) and
[ADO-EXPORT.md](../ADO-EXPORT.md) (permissions, limits, acceptance drill). The rules come from
SPEC §7.

## Code

| File                                 | Role                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `apps/api/src/ado/ado.controller.ts` | Routes under `/api/v1/projects/{id}/ado`                                                        |
| `ado.service.ts`                     | Configuration, previews, prepare, apply, cancel, history, nightly clean-up; all in transactions |
| `profiles.ts`                        | Process presets (Agile, Scrum, CMMI, Basic) and profile validation                              |
| `selection.ts`                       | Which items an export includes (scope, labels, ancestors, Done)                                 |
| `export.ts`                          | Builds create and update files from the selection and the links                                 |
| `transfer.ts`                        | Reading incoming rows: normalizing, matching references, differences, the incoming plan         |
| `csv.ts`                             | Strict RFC 4180 reading and writing                                                             |
| `values.ts`                          | Value conversions: dates, identities, rich text, the Description footer                         |
| `packages/shared/src/ado.ts`         | DTOs, limits (`ADO_LIMITS`) and the field names shared with the web app                         |

The web screen is `apps/web/src/app/pages/ado-transfer/`.

## Permissions

| Route                                                                        | Permission                   |
| ---------------------------------------------------------------------------- | ---------------------------- |
| Profile (read), export preview, prepare, download                            | `EXPORT_ADO` (PMs and Leads) |
| Destination, review policy, sample, incoming preview, apply, cancel, history | `IMPORT_ADO` (PMs)           |

System administration adds no transfer rights. Personal spaces answer 404, and archived projects
accept no transfer writes. Every incoming change is checked again with the ordinary item rules
(hierarchy, assignment, buckets, labels) before it is applied.

## Destination and profile

`AdoDestination` (one per project) holds the ADO organization and project names and the profile:
the process, the forward and reverse type mappings, state to status and bucket mappings, field and
identity mappings, tag handling, date columns, area and iteration paths and constant columns. A
`revision` increases with every change; previews record it and apply refuses a stale one. A PM can
suggest a profile from a sample ADO export (`POST .../sample`), which reads the file's columns and
values and stores nothing. `requireDetailedReview` makes every transfer use Detailed review.

The destination is not unique across projects, so a later version can map several Kloister
projects to one ADO project.

## Links and references

`AdoItemLink` ties a local item to an ADO work item for one destination:

- An export of a new item issues a random **reference** and writes it into the item's Description
  as a small visible footer. When the person brings back an ADO export that includes the
  Description, the reference identifies the row, so ADO IDs are linked without custom fields or
  tags. Without a reference, a PM matches the row by hand; titles are never used to match.
- `remoteId` is the ADO ID once confirmed; it is unique per destination.
- `localBaseline` and `remoteBaseline` hold the values at the last confirmed sync. Comparing them
  with the current local values and the incoming ADO values tells which side changed each field.
- `intent` records the exact values an export sent, with `_sent` naming the fields of an update
  file, so a later ADO value can be told apart from ADO's own creation defaults.
- `pendingBatchId` marks items whose create file was prepared but whose ADO IDs have not come back;
  no second create file is issued for them.
- Deleting a local item leaves its link as a tombstone (`tombstonedAt`), so an identity is never
  reused.

## Export

1. **Selection** (`selection.ts`): the whole project, a sprint, a subtree or a manual selection,
   optionally filtered by labels (any or all), with "include ancestors" (default on) and "exclude
   Done". Only items the caller can see are eligible.
2. **Plan** (`export.ts`): items without a confirmed link go into a **create** file: no `ID`
   column for new trees, the hierarchy expressed by which `Title N` column holds the title, rows in
   depth-first order. New children of linked parents use a mixed file with the parents as
   ID-bearing context rows. Linked items go into an **update** file with only the fields that
   changed locally since the last confirmed sync; unchanged or lossy fields are left out, so an
   update never overwrites ADO values Kloister cannot represent. Constant columns are written on
   create only.
3. **Files**: UTF-8 with BOM, comma-separated, RFC 4180 quoting, CRLF. At most 1,000 rows per file:
   create files split only between complete top-level trees (a single tree above the limit blocks
   with guidance), update files by row count. Several files are delivered as one ZIP. Dates are
   written as noon UTC ISO timestamps, which ADO's import accepts under any user locale.
4. **Preview** (`POST .../export/preview`): rows, files, mapping and warnings (several assignees,
   flattened checklists, attachments not exported, Basic process flattening, missing iteration
   paths, splits), and a digest. Nothing is stored.
5. **Prepare** (`POST .../export/prepare`): with the preview digest and a retry key, the API
   rebuilds the plan, refuses it if the digest changed, issues references, records the intent on the
   links and stores the batch with its files. The same retry key returns the same batch.
6. **Download** (`GET .../batches/{batchId}/download`): the reserved ZIP. Downloading does not mean
   ADO imported it; the links are confirmed only by a returned ADO export.

ADO creates items in their default state, so the initial State and assignments travel in a
follow-up update file once the IDs are known; the screen offers it right after linking.

## Incoming files

`POST .../import/preview` takes the CSV text (at most 10 MiB, 1,000 data rows, 1 MiB per cell;
`readCsv` refuses anything malformed rather than guessing), a mode and the review choices:

- `reconcile` links returned rows to local items (link only: local status and assignments stay);
- `import` brings ADO changes and new ADO items into the project;
- `observe` records the current ADO values for later update files.

`incomingPlan()` (`transfer.ts`) normalizes every row with the profile, finds its local item by
ADO ID, then by reference, and classifies it (`create`, `update`, `link`, `observe`,
`unchanged`, `pending`, `context`, `omitted`). Unknown, duplicate or conflicting references block.
For each field it compares the local value, the incoming value and the baselines.

The preview is stored as a batch in state `PREVIEW` with the parsed rows, a digest over the request
and the current local versions, and the destination revision.

## Review modes

- **Quick** (default): rows with a valid reference link automatically; a field changed on only one
  side takes that side's value; fields changed on both sides are listed for an explicit
  keep/take/skip choice; one summary is confirmed before apply. Link-only returns never block on
  unmapped State, Assigned To, Tags or Iteration values; they become warnings.
- **Detailed**: every difference needs an explicit choice, with local, incoming and confirmed
  values side by side, manual link confirmation, row selection, parent omission, label creation and
  per-item assignee choices.

Both modes share the same permissions, retry keys, staleness checks, tombstones and the rule that
missing rows never delete anything.

## Apply

`POST .../batches/{batchId}/apply` (PM) runs in one transaction:

1. The batch must be an active incoming preview whose digest matches; an applied batch returns its
   receipt, so a repeated apply creates nothing twice.
2. The plan is rebuilt from the stored rows against the current data. If local items, links or the
   destination revision changed since the preview, it refuses with 409 and asks for a fresh preview.
3. Incoming changes are validated with the ordinary rules. Labels are created only for reviewed
   label choices a selected field actually uses. One ADO assignee never removes additional local
   assignees that ADO does not manage.
4. Items are created and changed through the normal item code, so they are audited and announced
   to live updates like any other change.
5. Links, baselines and row results are recorded and the batch becomes `APPLIED`.

Never done by an import: deleting items on either side, creating user accounts or memberships,
creating buckets, parsing checklist or note text back into structure, fetching remote images.

## Batch states

| Direction | States                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Outgoing  | `PENDING` (create files awaiting returned IDs), `PREPARED` (update files only), `CONFIRMED` (IDs returned and linked), `CANCELLED` |
| Incoming  | `PREVIEW`, `APPLIED`, `CANCELLED`                                                                                                  |

A PM can cancel a pending create after acknowledging the risk that it was already imported into
ADO (`POST .../batches/{batchId}/cancel`); its pending references are released.

## Retention

A nightly job (04:15) removes the stored content of completed batches after 90 days and of
unapplied incoming previews after 7 days, keeping a compact receipt so retries still answer
correctly. Active links are kept.

## Limits

| Limit                      | Value                                   |
| -------------------------- | --------------------------------------- |
| Incoming CSV               | 10 MiB, 1,000 data rows, 1 MiB per cell |
| Request body on CSV routes | 24 MiB                                  |
| Rows per outgoing file     | 1,000                                   |
| Preview kept unapplied     | 7 days                                  |
| Completed content kept     | 90 days                                 |

Verified by hand against Azure DevOps Services with the Agile, Scrum and Basic processes and a
customized inherited process. CMMI and Azure DevOps Server are unverified until an operator runs
the acceptance drill in ADO-EXPORT.md.
