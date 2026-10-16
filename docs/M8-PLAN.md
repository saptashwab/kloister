# UI fixes and Azure Boards CSV transfers

Planning baseline: 2026-10-16. This document specifies future work; it does not
claim these features are implemented. Implement M7.5 first, then M8. The storage,
retention and input-limit proposal was approved on 2026-10-16; review it before
schema or API edits and ask before materially changing it.

Implementation follow-up: M7.5 is complete. The M8 source implementation and its
conservative file/context choices are recorded in DECISIONS and ADO-EXPORT. This
document retains the approved planning baseline; live target/server acceptance
remains operator-run and no release publication is part of M8 implementation.

## 1. Confirmed scope

- M7.5 addresses six reported UI problems and improvements. M8 delivers both
  directions of manual Azure Boards CSV transfer together, prioritizing the
  Kloister-to-ADO path within that implementation.
- Each ordinary Kloister project has one ADO destination: organization/collection
  and project. Process, types, states, fields and identity mappings are per project.
  The actual service/server version and process are not known yet. Do not assume
  Basic, one global template, or unrestricted ADO configuration permissions.
- Kloister exports need project PM or project Lead permission. Incoming CSV
  preview, manual ID linking, reconciliation and apply need project PM permission.
  System administrators get no additional transfer rights through their role.
  Personal spaces are excluded. Existing Excel/offline snapshots remain separate.
- Transfer core fields: title, type, sanitized description, valid parent hierarchy,
  status, priority, labels/tags, one ADO assignee, dates and area/iteration paths
  where the destination supports them. No native transfer of file bytes, inline
  images, comment history or dependency links is promised. Checklists and additional
  assignees can be rendered as clearly labelled description text.
- Persist mappings; permit a return CSV to learn assigned ADO IDs. Use a visible
  Kloister reference in Description, with explicit manual linking if it is absent.
  Require neither custom ADO fields nor creation of new tags to identify items.
- Show differences and require explicit decisions for conflicts. Missing rows
  never delete items. Never create accounts or project memberships automatically.
  Unknown identities require an existing-member mapping or an explicit unassigned
  choice. All these rules apply independently of whether the transfer is partial.

## 2. M7.5: UI behavior and acceptance

1. **Labels empty state.** The current `.label-list li` grid places the empty-state
   component in its first narrow column. Give the empty row a distinct layout or
   span the complete grid. Preserve the populated label layout, previews and
   permissions. Test zero, one and several labels, narrow widths and long text.
2. **Notifications width.** `.n-list` is capped at 880 px while its page header uses
   the available width. Align the list/empty panel and header in the same responsive
   content region, removing the unexplained right-hand gap. Keep message text
   readable, action controls reachable and long titles wrapped.
3. **Bucket deletion destination.** Wrap the bare select in a labelled Material
   form field with a visible outline, placeholder and useful width. Reset a stale
   target when changing the bucket being deleted; exclude that bucket. Require a
   destination before deleting a populated bucket, preserve Cancel and the final
   confirmation, and retain the existing no-entry-rule semantics of deletion.
4. **Bottom card drops.** Provide a comfortably sized trailing drop region inside
   each list, including populated lists, plus a clear insertion indicator and
   scrolling behavior. Do not introduce a fake draggable item or change order
   indices. Verify empty/short/long columns, same/cross-column moves, filtered
   boards, scrolling and failures. Keep the existing keyboard alternative.
5. **Board bucket management.** In Bucket grouping only, allow PMs and project
   Leads to hold and drag the bucket top bar horizontally and add a named
   bucket directly from the board. Personal-space owners get the same controls;
   archived/read-only views do not. New buckets append with entry mode NONE and
   null target status. Nested column/card drags must not intercept one another.
   Double-click the bucket name to rename it. A compact actions menu offers Rename
   and keyboard move-left/right; omit separate visible handles and arrow rows.
   Keep a visible Add bucket action. Reuse existing
   bucket APIs and canonical project state; Board and Settings agree immediately
   when navigating between them and after reload. This does not introduce live
   cross-browser synchronization. Non-bucket groupings cannot reorder buckets.
6. **User pickers.** One input with a Search button/Enter opens a result dropdown
   anchored to that same field. Selecting a result commits its user ID, never the
   typed text. Show name and email, loading, no matches, errors and clear/change.
   Preserve selected chips across searches for multiple PMs. Discard stale search
   responses and invalidate an old single selection when its text is edited.
   Apply consistently to project creation/PM assignment/member addition and review
   other user selectors for the same interaction; local member-only selectors
   should not start querying the system directory. Preserve scoped candidate APIs,
   active-user restrictions and keyboard/screen-reader operation.

Use existing Material/CDK components, tokens and shared feedback. Do not change
authorization to make controls appear. Browser evidence must include the reported
empty states, dark custom themes, light mode, phone/tablet widths and keyboard use.

## 3. M8: distinct transfer interface

Provide a lazy project-level **ADO transfer** entry, not a replacement for the
existing **Export...** snapshot dialog. It offers Export CSV and, for PMs, Import /
reconcile CSV. PM-only Settings configure the destination and mappings. Do not ask
for a token or contact ADO from the backend or browser.

Export scopes: entire project, sprint, subtree, explicit selected items and label
filters (match any/all). Scope and filters compose; selections survive pagination
and do not mean only currently rendered rows. Default Include ancestors on and
Exclude Done off. Preview names selected versus automatically included parents,
counts, resulting type/state mappings, creates versus updates, excluded items and
all losses. An explicit subtree selects descendants; an ordinary item selection
does not silently expand to children or dependencies. Turning ancestors off warns
about lost hierarchy. Filtering never deletes or unlinks excluded items.

Import offers all uploaded rows or an explicit subset before apply. A missing
parent outside that subset must resolve to an existing mapped parent, be included
explicitly, or be intentionally omitted with a warning. Never silently import
unselected rows. Reuse existing buckets; require reviewed mappings from incoming
states to Kloister statuses and existing buckets. Do not rebuild the board, create
buckets, infer dependencies or create users automatically.

## 4. Workflow and identity

### Start with Kloister data

1. Configure the destination and process/field mappings; preview a selected export.
2. Produce a create-only CSV for previously unlinked items. Reserve their transfer
   identities and capture the exact outgoing intent. Initial creation omits State
   and Assigned To; stage those values for the later ID-based update pass.
3. The operator imports/saves in ADO, then exports those rows with ID, Work Item
   Type, titles and Description, plus the fields needed for review.
4. A PM uploads that CSV in reconciliation mode. Match the exact issued reference
   to its pending item, validate destination and ID uniqueness, and show every link.
   Default reconciliation to link-only: ADO's initial defaults must not silently
   replace intended Kloister status or assignments. Other inbound changes require
   the ordinary field-difference review.
5. Generate a separate update CSV carrying real ADO IDs and reviewed values,
   including desired state/assignee where supported. The operator imports it and
   returns a fresh ADO CSV to confirm the result.

### Start with ADO data

1. Export the desired query rows and fields from ADO; upload to the selected
   Kloister project's destination profile.
2. Preview mappings, selected rows, hierarchy and assignees. Create only confirmed
   new rows; store their ADO IDs in the same transaction as the new Kloister items.
3. Later CSV uploads match destination plus ADO ID and update those linked items.
   Kloister exports for those items already carry the real IDs.

### Subsequent transfers

- Classify each row as new, linked, unchanged, changed, conflicted, pending or
  invalid. Never use title, row order or a name similarity score as identity.
- Do not emit another create file for items awaiting returned IDs. Allow recovery
  through re-downloading the same pending batch, reconciliation or a deliberate
  cancellation with a duplicate-risk warning. A download is not proof of import.
- Use an opaque stable reference, such as `Kloister reference: <random token>`, in
  a small visible description footer. Do not include internal paths, credentials
  or a mandatory externally reachable URL. Keep the marker in generated ADO
  descriptions; strip only a validated issued marker from incoming user content.
  Unknown/duplicate/conflicting markers block linking. A marker is not authority:
  verify project/destination scope and require explicit PM confirmation.
- If Description is omitted or the marker was removed, require a PM to explicitly
  map the incoming ADO ID to a known pending Kloister item, or explicitly confirm
  that it is new. Missing correlation during reconciliation must never default to
  creating a copy. Show destination and both item identities prominently.
- CSV cannot enforce uniqueness inside ADO. Reimporting a create CSV manually,
  removing references or ignoring reconciliation can create duplicates there.
  Document this limit; do not promise a transactional or automatic live sync.

## 5. Differences, conflicts and data fidelity

- Compare per-field normalized Kloister values and incoming ADO values against the
  last confirmed observations of each side. Do not advance confirmations merely
  because a file was generated, downloaded or reported as imported without data.
- Show current local, incoming and baseline values; allow keep local, take incoming
  or skip for each conflict. First linking with no baseline requires explicit
  review. Preserve unselected local changes; never apply an entire row blindly.
- Outbound update preparation needs a recent operator-supplied ADO CSV for the
  selected linked items. It shows its observation time and warns that ADO may have
  changed afterwards. Without network access, Kloister cannot perform revision-
  conditional writes or detect changes made in ADO after that CSV was exported.
  Require a freshness acknowledgement; never claim that the preview locks ADO.
- A PM uploads/reviews and stores the remote observations needed for updates;
  a Lead consumes those observations through the export-only preview. A Lead
  cannot upload/reconcile the return CSV through a disguised export endpoint.
  If observations are missing or stale, ask a PM to refresh them before export.
- CSV rows may lack trustworthy organization/collection or project provenance.
  Validate explicit provenance columns such as Team Project when supplied and
  reject contradictions; otherwise require acknowledgement of the selected
  destination. IDs alone do not prove where a file originated. Local marker/link
  checks cannot certify the external system without that operator assertion.
- A Lead can prepare outbound files but cannot apply incoming values to Kloister
  or confirm mappings. Route needed reconciliation to a PM. Outbound resolutions
  choose file contents only; they do not grant incoming-write permissions.
- Preview apply revalidates local versions, mapping/config versions, user rights
  and referenced members/buckets. Stale previews fail for renewed review. Process
  each selected import batch atomically, including links, audit and item changes;
  retries cannot duplicate its creates. Reject invalid rows before applying.
- An omitted CSV column means leave unchanged. An empty supplied cell must be
  distinguished from omission and reviewed as clear/unassigned where supported;
  missing required data is an error. Preserve fields outside transfer scope.
- One ADO assignee is selected explicitly when Kloister has several. Returning
  that assignee must not silently discard Kloister's additional assignees.
- Keep structured checklists, notes and assignments intact when description text
  includes a readable representation. Do not parse that text back into structured
  entities. Avoid repeatedly appending the same generated block; test round trips.
- Labels and tags map by reviewed settings. Unsupported/new ADO tags can be omitted
  with a warning when permissions are restricted; identity never depends on tags.
  New Kloister labels require a PM-reviewed creation list; otherwise map or skip.
- Map iteration paths to existing Kloister sprints or explicitly no sprint; do not
  manufacture sprint dates. Preserve unmapped ADO area/path information in transfer
  metadata rather than inventing project teams or altering board configuration.
- New/imported objects use normal local audit/creator/timestamp rules; historical
  ADO authorship and dates must not impersonate local audit events.
- Sanitize incoming HTML, remove external/unsafe images with a visible warning and
  never fetch URLs. Exports explain omitted file/image content. A Basic/custom type
  mapping that loses distinctions or violates Kloister hierarchy requires a visible
  resolution; preserve the original Kloister type for already linked items unless
  a reviewed valid type change is intended.

## 6. Process profiles and CSV constraints

Offer Basic, Agile, Scrum, CMMI and Custom presets, with configurable forward and
reverse type/state mappings per type, field headers, dates, area/iteration paths,
identity aliases and required constants. Unknown process requires configuration,
not silent Basic defaults. The existing Basic flattening policy (omit Kloister
Epics, map Features to ADO Epics) is a previewed export transformation, not a
reversible schema mapping. Warn about omitted items and require reverse choices
for ambiguous new ADO types. Never reinterpret an already linked item blindly.

Board columns and work-item states are different concepts. Do not assume that
To Do / Doing / Done is every project's workflow, or that a Blocked state exists.
Require an explicit fallback or omission warning for unsupported values. Optional
date fields default to disabled until confirmed for that profile and item type;
provide a chooser for supported headers rather than assuming Target Date works.

Write UTF-8 BOM, CRLF, RFC 4180 quoting; read common BOM/line-ending forms with
strict encoding/header/row validation. Use depth-first Title 1...Title N for create
hierarchies and ID-based updates for existing rows. Validate all required headers,
types and parent consistency. Do not claim that CSV changes arbitrary link types,
board configuration, process rules or state-transition rules.

Separate creation and update workflows, maximum 1,000 rows per file. A purely new
tree can omit ID. For new children of already linked parents, explicitly generate
a mixed hierarchy-create CSV: ID-bearing existing ancestor context rows followed
by ID-empty child rows in the documented title hierarchy. Do not create the parent
again. Show these context rows in the preview and count them toward the file limit.
The initial file still omits State/Assigned To. Every other emitted field on an
existing context row must use its fresh reviewed ADO value, not a blank that could
clear it or an unreviewed Kloister value. If a safe complete context row cannot be
formed, block and request the needed ADO columns or a reduced export profile.
Turning ancestors off explicitly warns that new children will lack those links.
Deduplicate shared ancestor context within each file. If it must recur across
files, it remains an existing-ID context row, never a create or proof of import.

Split creates at complete root-tree boundaries. A single create tree over 1,000 rows blocks with
actionable guidance to reduce/flatten the selection; never silently truncate,
exceed the limit or break a hierarchy. Flat updates may split by row count. Only
include parents with real IDs in update files; unresolved parents require the
creation/reconciliation workflow. Required headers/values are profile-dependent;
reject duplicate/reserved constant-column overrides.

## 7. Proposed implementation structure and persistence

This concrete design proposal, including the retention and input limits below,
was approved on 2026-10-16. It is not an implemented schema. M7.5 needs no
migration; material departures from this design need review before M8 schema edits.

- Add `apps/api/src/ado/` with a module/controller, CSV parser/writer, profile
  validation, selection/preview, import/reconciliation and persistence services.
  Keep ordinary item authorization/validation in existing shared service paths;
  extract reusable transaction helpers if needed rather than calling controllers
  or bypassing hierarchy/assignment checks. Add typed contracts in
  `packages/shared/src/ado.ts` and a dedicated PM-only import permission.
- `AdoDestination`: one unique ordinary `projectId`, canonical organization/
  collection identity and ADO project identity, process/profile JSON, config
  revision and timestamps. URLs are identity/display data, never fetch targets.
  The ADO organization/project tuple is not globally unique: future many-Kloister-
  to-one-ADO use must not require removing an exclusivity constraint. Profiles,
  item references, selections and transfer permissions remain Kloister-project
  scoped. Sharing an ADO destination must never imply importing every row into
  every linked Kloister project. Before exposing a shared-destination workflow,
  specify routing/partitioning and prevention of the same remote item being
  accidentally linked to two local projects, with no cross-project information
  leaks. Shared work-item editing is not part of this release.
  Once links exist, changing destination identity is blocked; explicit migration
  to multiple destinations is deferred. Profile edits invalidate previews and
  require re-review of stored baselines without discarding links.
- `AdoItemLink`: destination/project/item identity, unique issued reference,
  nullable ADO ID while pending, separate confirmed local/remote field snapshots
  and timestamps. Enforce uniqueness for destination+item and destination+ADO ID;
  composite keys prevent cross-project links. Use string-validated positive ADO
  IDs to avoid unsafe numeric conversions. Keep a tombstone when the local item
  is deleted so later imports cannot silently resurrect it; explicitly reject
  re-creation in this release. References are copied into exports, not normal
  descriptions stored on Kloister items.
- `AdoTransferBatch` and row records: direction/mode, creator, destination/profile
  revision, selected identities, file digest, outgoing intent/preview digest,
  local version checks, row results, idempotency key and pending/confirmed state.
  Store normalized scoped content required for recovery/conflicts, not arbitrary
  uploaded archives or unbounded source files. Use JSON-safe snapshots with size
  limits. Link-only reconciliation preserves both observed values and intended
  outbound values without declaring them synchronized.
- Keep completed raw CSV bytes temporary; proposed limits are 10 MiB per upload,
  1,000 data rows per applied batch and 1 MiB per cell, plus existing field limits.
  Reject excess input with a specific error; never silently truncate. Pending
  records and tombstones must not be removed by general log retention. Propose a
  bounded retention policy of 90 days for confirmed completed-batch content, preserving
  active link baselines and any pending workflow. Keep compact audit/idempotency
  receipts so old retries cannot become new creates after cleanup. Document
  storage in database backups. No deployment folder or external worker is required.
- Proposed routes under `/projects/:id/ado`: PM-only destination GET/PUT, export
  preview/prepare/download (PM/Lead), import preview/apply (PM), and explicit batch
  reconciliation/recovery (PM). Response filenames include mode and batch identity.
  Keep snapshot routes unchanged. Specify exact route contracts in the M8 file
  plan and generate build-time OpenAPI when implemented.
  Export previews expose the sanitized read-only profile/mapping information
  needed by PMs and Leads; that does not expose PM-only management/history data
  or allow a Lead to edit settings.
- Audit settings/link/import actions without full descriptions, CSV contents or
  passwords. No tokens, external requests, scheduled background sync, firewall,
  SELinux, httpd or deployment-model changes.

## 8. File plan

M7.5: `pages/project-settings/project-board-settings.ts`,
`pages/notifications/notifications.ts`, `styles/_annotations.scss`,
`pages/board/board.ts`, `core/project-context.ts`, `pages/projects/projects.ts`,
`pages/project-settings/project-settings.ts`, applicable team/member selectors,
and a lazy/reusable `ui/user-picker.ts` with tests. Use existing
`core/items-api.service.ts` bucket calls. Add/extend page unit tests and
`apps/web/e2e/` UI regression scenarios. Update DESIGN, DECISIONS and bundled Help
for board management. Change shared tokens only when needed; preserve budgets.

M8: new `packages/shared/src/ado.ts` and barrel export; project permissions and
settings validation; Prisma schema plus an offline additive migration; new API
`src/ado/` and module registration; lazy web `pages/ado-transfer/`,
`core/ado-api.service.ts`, project routes/settings/navigation and backlog selection
integration. Add unit/HTTP tests, `apps/api/test/db/ado.db-spec.ts`,
`apps/web/e2e/ado.e2e-spec.ts`, and synthetic CSV fixtures. Update generated OpenAPI,
`docs/ADO-EXPORT.md` (both directions), README, Help, DESIGN and DECISIONS. Keep
test fixtures out of installation payloads where they are not runtime assets.

## 9. Verification and handoff gates

- Begin with current CI; fix newer red code before feature work. Current reference
  runs: application CI 38700907595 and release packaging 38704821553 are green.
- M7.5 checks both API denials and hidden/visible controls without changing the
  existing permission matrix. Browser checks cover actual drag coordinates,
  bottom insertion, nested drags, ordering persistence, filter behavior, keyboard
  alternatives, user search races, selection preservation and the three screenshots.
- M8 fixtures independently transcribe documented CSV contracts, including examples
  of their limitations; do not generate every expectation using the writer under
  test. Cover both directions, all presets, custom fields, partial selection,
  any/all labels, parents, Unicode, multiline HTML, formulas and spreadsheet CSV
  injection, malicious markup, duplicate headers/IDs/markers, foreign destinations,
  malformed/oversized input, unknown users/states and invalid hierarchy.
- Test mixed new/linked/pending items, first-return defaults, link-only flow,
  existing-parent/new-child context rows without optional-field clearing,
  repeated/shared ancestor context without duplicate creates,
  missing/provided destination provenance, Lead export from PM-reviewed observations,
  preserved extra assignees, missing columns versus explicit clears, no automatic
  deletion, tombstones, profile edits, normalized round trips, conflict choices,
  preview staleness, transaction rollback, concurrent/repeated apply and recovery.
  Permission tests include PM/Lead/Member/Viewer, team Leads, system admins,
  outsiders, archived projects and personal spaces on every new endpoint.
- Local gate: `npm ci`, `npm run format:check`, `npm run lint`, `npm run build`,
  `npm test`. Type-check API/database and browser tests; list browser scenarios.
  No local database/container or local browser-test execution. Database/browser
  tests run only in CI. Never weaken lint, budgets or assertions to pass.
- Fresh independent review per milestone, fix valid findings and rerun gates,
  Conventional Commit and push per milestone. Stop after M7.5 for the next
  milestone go-ahead. Packaging/release publication needs separate authorization.
- No live ADO is available to implementation. Verify against official documentation
  and synthetic fixtures, explicitly label live compatibility unverified, and give
  an operator acceptance checklist: scratch destination, tiny hierarchy, return IDs,
  initial-state update, partial repeat, conflicts and stable counts in both systems.
  First test against disposable data; existing production Kloister data is retained
  and upgrade/backup instructions remain applicable.

## 10. Documentation references and limits

Use the current [Microsoft CSV guide](https://learn.microsoft.com/en-us/azure/devops/boards/queries/import-work-items-from-csv?view=azure-devops)
for ID-based updates, create/import limitations, hierarchy columns and file limits,
and [process guidance](https://learn.microsoft.com/en-us/azure/devops/boards/work-items/guidance/choose-process?view=azure-devops)
for template differences. Check these again during implementation. The transfer
design above is a project proposal inferred from those constraints, not a claim
that Microsoft provides automatic synchronization or duplicate prevention.

Approval recorded (2026-10-16): the concrete persistence proposal in section 7,
including its 90-day completed-content retention and upload limits. The future
extension priority is multiple Kloister projects sharing one ADO project, not
multiple ADO destinations for one Kloister project. Preserve that possibility
without expanding M8 into cross-project synchronization. No application
implementation is authorized in this planning session.
