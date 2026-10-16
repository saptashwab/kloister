# Manual Azure Boards CSV transfer

Use **ADO transfer** in an ordinary project. This is separate from **Export…**,
which produces Excel/offline reading snapshots for every role's readable data.
Transfer files are carried by an operator. Neither browser nor backend contacts
ADO, asks for a PAT, or fetches resources mentioned in imported HTML.

Project PMs and project Leads prepare exports. Only project PMs configure the
destination, upload incoming files, link IDs, apply changes and cancel pending
creates. Team leadership and system administration grant no additional transfer
rights. Personal spaces are excluded. Archived projects reject transfer writes;
previously prepared outbound files remain downloadable with export permission.

## Configure and review

A PM opens **Transfer settings**, identifies the organization/collection and ADO
project, then reviews a Basic, Agile, Scrum, CMMI or Custom profile against actual
query exports from that destination. Nothing is fetched from an identity URL.
One destination belongs to each local project. Its remote tuple is not globally
exclusive, but transfers never route between local projects. Sharing a remote
destination grants no additional local access. Once durable links exist, changing
destination identity is blocked. Profile changes invalidate previews and require
reviewing remote observations again; links are retained.

Review forward types, reverse choices for new rows, states by type, identity
aliases, optional field headers, iteration paths, tag mappings and required
constants. A state mapping names a local status and an **existing bucket**. Board
columns and remote states are independent. No bucket, account, membership, sprint
or dependency is automatically created. New labels require a separate explicit
PM-reviewed tag/name/colour list. Unknown tags, assignees and iterations need a
mapping or explicit omission/unassigned/no-sprint choice.

Dates default disabled. Enable only headers and local types confirmed to support
them in the target process; do not assume Target Date or Due Date exists for every
type. Mixed create trees omit optional date columns when support is not confirmed
for every included type, with a warning. Constants cannot override reserved or
duplicate columns. Blank forward states explicitly omit State for those updates.
Basic omits local Epics, promotes their children, maps Features to remote Epics
and Story/Bug to Issue. Review these losses; reverse Issue requires an explicit
Story/Bug choice, while existing linked local types are preserved unless reviewed.

## Start with local work

1. Choose **Export CSV**. Select the whole project, a sprint, a subtree or exact
   items; any/all label filters combine with that scope. Backlog's **Transfer
   selected to ADO** carries exact selected identities. All matching pages count.
   Only subtree selection expands children. Ancestors default on; turning them
   off explicitly loses hierarchy outside the selection. Done defaults included.
2. Review selected rows, added parents, omitted types, assignee choices, files,
   context counts and warnings. Choose one remote assignee when there are several
   locally. Initial creation deliberately omits State and Assigned To, preserving
   that intended local work for the subsequent real-ID update.
3. **Prepare reviewed CSV files** reserves issued references, pending identity and
   exact outgoing intent atomically. Download/extract the ZIP; import the create
   files in the destination's Boards query UI, review there and **save** the rows.
   A download is not confirmation that ADO created anything.
4. Export the saved ADO rows with ID, Work Item Type, Title/Title hierarchy,
   Description and relevant fields. Include Team Project and organization or
   collection provenance where available. A PM uploads this CSV in **Link returned
   IDs only** mode, checks the destination, row subset and identities, previews
   and applies the links. Initial ADO state/assignment defaults do not overwrite
   local intent. Description contains a visible random `Kloister reference:`
   footer, with no mandatory URL, tag or custom field.
5. If the footer/Description is absent, explicitly map the remote ID to a known
   pending local item. Titles and row order are never matching authority. Unknown,
   duplicate, conflicting or foreign markers block linking. A marker alone is
   insufficient: project scope, durable issued reference, unique ID and PM review
   are checked. Reconciliation never silently creates new local work.
6. Return to Export CSV. Review current local, supplied remote and confirmed
   baseline values; choose file contents explicitly. A PM must have supplied and
   reviewed observations for every linked update/context. Acknowledge their
   timestamps and freshness limits. Prepare the separate **update** files with
   actual IDs, desired supported State and one mapped Assigned To. Import/save in
   ADO, then bring a fresh query CSV back to review the resulting observation.

New children under linked parents use ID-bearing existing ancestor context rows
and ID-empty child rows in the create file. Context is never a new create. Every
emitted context field must have a safe fresh reviewed remote value; missing
columns or unreviewed hierarchy block generation. Supply Parent or hierarchy
columns when remote parent relationships are needed. Shared ancestors are
deduplicated within a file, and repeated ancestors in another file retain IDs.

## Start with ADO work, then repeat

Upload a query CSV in **Import reviewed local changes / new rows** mode. Select
all rows or an exact subset. A new remote ID without a validated issued reference
needs an explicit confirmation as new. Review reverse types, destination provenance,
parents and each changed field, then preview again and apply the error-free review.
New local items and remote links are committed together using ordinary local
creator, timestamps, notifications, hierarchy, assignment and item validation.

A parent outside the subset must resolve to an existing mapped local parent, be
selected explicitly, or be intentionally omitted with a warning. Never infer that
an unselected row should be created. Missing rows never delete or unlink work.
Deleted local identities remain tombstones; this version refuses resurrection.

Later uploads match the destination plus remote ID. Missing columns preserve
values. An explicitly supplied empty supported value is reviewed separately from
omission. One returned assignee cannot silently discard additional local people;
the previously confirmed remote assignee is managed separately, preserving extras.
Structured checklists, notes and assignments stay structured locally: generated
description text is never parsed into entities or attributed as historical events.
Edited generated footers need explicit correction/manual matching before taking
that description, avoiding repeated generated blocks.

Review current local, incoming, confirmed local baseline and confirmed remote
baseline values. Choose **Keep local**, **Take incoming** or **Skip** for each
unequal field, including first linking without baselines. Outbound choices affect
file contents only; a Lead cannot apply incoming changes through export routes.
Use **Review remote observations for later export** to record a PM-reviewed CSV
without applying local field changes. Refresh a stale preview after data, rights,
membership, referenced resources or profile changes. An apply commits all selected
rows, mappings and audit together; retrying the same reviewed batch is idempotent.

## Recovery, storage and limits

Recovery lists PM-visible batches and exact prepared files. Pending creates block
another create export for those items. Recover their original file or reconcile
returned IDs. **Cancel pending creates…** requires a duplicate-risk confirmation.
Cancellation cannot undo an import already performed in ADO. Manually replaying a
create file, removing references or bypassing reconciliation can create remote
duplicates; CSV offers no remote transaction, uniqueness constraint or live lock.

Files without trustworthy project provenance require explicit destination
acknowledgement. Supplied contradictory provenance is rejected. IDs alone cannot
prove file origin, and even a fresh query cannot reveal later external edits.

Input limits are 10 MiB per upload, 1,000 data rows per applied batch and 1 MiB per
cell, plus ordinary item-field limits. Malformed encoding/quotes, duplicate
headers/IDs/markers and ambiguous required values are rejected. Export uses UTF-8
BOM, CRLF, RFC 4180 quoting and true depth-first Title 1…Title N hierarchy. Pure
creates omit ID; mixed creates use confirmed context IDs; updates use real IDs.
Each file has at most 1,000 rows including context. Creates split only between
whole trees; an oversized single tree blocks with guidance. Reduce a selection if
updates plus ancestor context exceed the file limit. No content is truncated.
Formula-like cell prefixes are blocked with a source-review error rather than
silently modifying transferred text. Open transfer files as data; use snapshots
when the goal is spreadsheet reading.

Transfer records live in PostgreSQL and are included in database backups. Raw
uploaded CSV bytes are not persisted: recoverable previews retain bounded parsed
selected content and minimal hierarchy context. Completed content is cleared after
90 days. Active link baselines, observations, tombstones, pending workflows and
compact retry receipts survive; an expired retry cannot become a new create.
Audit records include action, identity and counts, without descriptions or CSV text.

Native attachment/image bytes, dependencies, comment history and historical audit
authorship are outside CSV fidelity. Descriptions are sanitized and embedded images
removed with a warning. Checklists, extra assignees and optional notes are labelled
readable description text. Unmapped area/path data stays in transfer metadata,
without inventing teams or dates. State transitions, required fields and supported
headers remain subject to the actual ADO process rules.

## Disposable operator acceptance drill

Back up the installed database and matching files, review [UPGRADE](UPGRADE.md),
then use a disposable local project and scratch ADO destination, never production
work. Preserve existing PostgreSQL clusters, deployment ports and configuration.

1. Review the actual target's query headers/types/states. Configure a tiny local
   Feature → Story → Task tree, two labels and a deliberately non-default task
   status. Export just the Task with ancestors on. Check context/row counts,
   BOM/Unicode, descriptions and omitted state/assignment before importing.
2. Save once in ADO, export assigned IDs and descriptions, link-only reconcile,
   then verify local numbers, state, assignments and count did not change. Export
   a real-ID update, inspect staged state/assignee and confirm it in ADO.
3. Add a new child under the linked Story. Return fresh complete parent/hierarchy
   observations; check the mixed create file keeps parent IDs/remote values and
   counts every context row. Import once and reconcile its one new ID.
4. From ADO, export two new scratch Tasks. Import only one with explicit reverse
   type/status/bucket/field choices. Repeat that one row and retry apply: both
   local and remote counts must stay stable. Import the second explicitly.
5. Edit the linked title differently on both sides, return a fresh CSV, inspect
   the two baselines and resolve explicitly. Make a local edit after preview and
   verify apply refuses until reviewed again. Missing rows must never delete.
6. Check pending recovery, missing-marker manual matching, cancelled-create
   warning, deleted-item tombstone refusal and denied Member/Viewer/admin/team-
   Lead writes. Keep the acceptance notes and restore drill with the runbook.

Implementation checks use synthetic independent fixtures and the documented
[Microsoft CSV contract](https://learn.microsoft.com/en-us/azure/devops/boards/queries/import-work-items-from-csv?view=azure-devops)
and [process guidance](https://learn.microsoft.com/en-us/azure/devops/boards/work-items/guidance/choose-process?view=azure-devops),
rechecked on 2026-10-16. No live ADO instance is available to implementation tests.
Compatibility with the owner's target version/process and server upgrade
acceptance remain **unverified until the operator runs this drill**.
