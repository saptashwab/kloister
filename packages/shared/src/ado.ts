import type { ItemStatus, ItemType } from './items.js';

/** Hard limits for operator-carried transfers; never truncate to fit. */
export const ADO_LIMITS = {
  uploadBytes: 10 * 1024 * 1024,
  rows: 1000,
  cellBytes: 1024 * 1024,
} as const;

/** Supported templates; a preset always requires destination review. */
export type AdoProcess = 'Basic' | 'Agile' | 'Scrum' | 'CMMI' | 'Custom';

/** Transferable scalar fields. Missing columns preserve local values. */
export type AdoField =
  | 'title'
  | 'type'
  | 'description'
  | 'status'
  | 'priority'
  | 'assigneeIds'
  | 'labelIds'
  | 'sprintId'
  | 'startDate'
  | 'dueDate'
  | 'parentId'
  | 'bucketId';

/** Per-project reviewed process and field contract; no credentials. */
export interface AdoProfile {
  /** Template used for the explicit flattening policy. */
  process: AdoProcess;
  /** Forward types; null explicitly omits a type. */
  types: Record<ItemType, string | null>;
  /** Unambiguous reverse choices for incoming new types. */
  reverseTypes: Record<string, ItemType>;
  /** Forward states indexed by local type, then local status. Null omits State. */
  states: Record<ItemType, Record<ItemStatus, string | null>>;
  /** Remote type/state keys use a newline separator. */
  incomingStates: Record<string, { status: ItemStatus; bucketId: string }>;
  /** Enabled optional field headers; dates default disabled. */
  fields: Partial<
    Record<'priority' | 'labelIds' | 'sprintId' | 'startDate' | 'dueDate' | 'area', string>
  >;
  /** Date capability is disabled for every type until explicitly confirmed. */
  dateTypes: Partial<Record<'startDate' | 'dueDate', ItemType[]>>;
  /** Local member IDs to remote identity strings. */
  identities: Record<string, string>;
  /** Incoming aliases to an existing member ID or explicit unassigned. */
  incomingIdentities: Record<string, string | null>;
  /** Remote tags to existing label IDs or explicit omission. */
  tags: Record<string, string | null>;
  /** Iteration paths to existing sprint IDs or explicit no sprint. */
  iterations: Record<string, string | null>;
  /** Remote path used when no sprint override is set. */
  iterationRoot: string;
  /** Default outgoing area, metadata only on import. */
  area: string;
  /** Required extra columns; reserved columns cannot be overridden. */
  constants: { header: string; value: string }[];
}

/** Destination identity and reviewed profile. */
export interface AdoDestinationInput {
  /** Organization/collection identity, stored canonically, never fetched. */
  organization: string;
  /** Remote project identity. */
  remoteProject: string;
  /** Reviewed process contract. */
  profile: AdoProfile;
  /** Optimistic config revision; zero for first setup. */
  revision: number;
}

/** Read-only profile details available to PMs and project Leads. */
export interface AdoDestinationDto extends AdoDestinationInput {
  /** Scoped destination identity. */
  id: string;
}

/** Complete server-side selection across every page. */
export interface AdoSelection {
  /** Selection basis. */
  scope: 'project' | 'sprint' | 'subtree' | 'manual';
  /** Sprint or subtree root, according to scope. */
  rootId?: string;
  /** Explicit local item IDs; never implicitly includes children. */
  itemIds?: string[];
  /** Optional label filters. */
  labelIds: string[];
  /** Whether all or any labels must match. */
  labelMode: 'any' | 'all';
  /** Add ancestor context by default. */
  ancestors: boolean;
  /** Exclude completed matching items before adding context. */
  excludeDone: boolean;
  /** Render notes as labelled description content. */
  notes: boolean;
}

/** Choice is explicit for every changed incoming field, including initial links. */
export type AdoChoice = 'local' | 'incoming' | 'skip';

/** Export inputs do not permit remote observations or incoming writes. */
export interface AdoExportRequest {
  /** Scoped selection. */
  selection: AdoSelection;
  /** Explicit single-assignee choices keyed by local item ID; null means unassigned. */
  assignees: Record<string, string | null>;
  /** Outbound field choices for linked items, keyed by item then field. */
  choices: Record<string, Partial<Record<AdoField, AdoChoice>>>;
  /** Accept CSV observation freshness limits. */
  freshnessAcknowledged: boolean;
  /** Required before preparing the preview. */
  previewDigest?: string;
  /** Durable retry identity. */
  idempotencyKey?: string;
}

/** Incoming file plus explicit per-row review instructions. */
export interface AdoImportRequest {
  /** Exact UTF-8 CSV text (bounded again server-side). */
  csv: string;
  /** Link-only preserves intended local status and assignments. */
  mode: 'import' | 'reconcile' | 'observe';
  /** Null selects all rows; otherwise zero-based data-row numbers. */
  selectedRows: number[] | null;
  /** Acknowledge destination when provenance is absent. */
  destinationAcknowledged: boolean;
  /** Incoming remote IDs to local pending item IDs; never title matching. */
  manualLinks: Record<string, string>;
  /** Explicit new remote IDs, needed when correlation is absent. */
  confirmedNew: string[];
  /** Parent remote IDs intentionally omitted from selection/hierarchy. */
  omittedParents: string[];
  /** Reviewed field resolutions keyed by remote ID. */
  choices: Record<string, Partial<Record<AdoField, AdoChoice>>>;
  /** Per-row reverse-type override for ambiguous new remote types. */
  types: Record<string, ItemType>;
  /** Reviewed labels to create; tags not listed still require mapping or omission. */
  createLabels: { tag: string; name: string; colour: string }[];
  /** Idempotency identity, retained after content expiry. */
  idempotencyKey: string;
}

/** Visible three-way field comparison; rendered as text, never trusted HTML. */
export interface AdoDifference {
  /** Local field. */
  field: AdoField;
  /** Present local value. */
  local: unknown;
  /** Normalized incoming value. */
  incoming: unknown;
  /** Last confirmed local value or null. */
  baselineLocal: unknown;
  /** Last confirmed remote value or null. */
  baselineRemote: unknown;
  /** Both sides changed since confirmation, or no confirmed baseline exists. */
  conflict: boolean;
  /** Current explicit resolution. */
  choice?: AdoChoice;
}

/** One reviewed row, without raw CSV or hidden-project information. */
export interface AdoPreviewRow {
  /** Zero-based CSV row or outgoing item order. */
  index: number;
  /** Local item identity when known. */
  itemId: string | null;
  /** Positive remote ID, never converted to a JavaScript number. */
  remoteId: string | null;
  /** Human-readable title. */
  title: string;
  /** Classification. */
  kind: 'create' | 'update' | 'link' | 'observe' | 'unchanged' | 'pending' | 'context' | 'omitted';
  /** Distinguishes explicit selection from ancestors. */
  selected: boolean;
  /** Three-way differences. */
  differences: AdoDifference[];
  /** Losses and required explicit resolutions. */
  warnings: string[];
}

/** Recoverable preview or completed receipt. */
export interface AdoPreview {
  /** Persisted batch identity, null for an unprepared outbound preview. */
  batchId: string | null;
  /** Staleness/content digest. */
  digest: string;
  /** Safe destination details. */
  destination: AdoDestinationDto;
  /** Reviewed rows. */
  rows: AdoPreviewRow[];
  /** Export filenames and row counts. */
  files: { name: string; rows: number }[];
  /** Cross-cutting losses/freshness warnings. */
  warnings: string[];
  /** Errors must be resolved in a new preview before apply/prepare. */
  errors: string[];
  /** Applied, pending or cancelled workflow. */
  state: string;
}
