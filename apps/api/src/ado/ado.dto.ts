import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  AdoChoice,
  AdoDestinationInput,
  AdoExportRequest,
  AdoField,
  AdoImportRequest,
  AdoProfile,
  AdoSelection,
  ItemType,
} from '@kloister/shared';

/** PM-only destination replacement, with an optimistic config revision. */
export class DestinationDto implements AdoDestinationInput {
  /** Organization/collection identity, never a fetch target. */
  @IsString() @MaxLength(1000) organization: string;
  /** Remote project identity. */
  @IsString() @MaxLength(200) remoteProject: string;
  /** Nested mappings receive additional semantic validation in the service. */
  @IsObject() profile: AdoProfile;
  /** Zero for a new destination. */
  @IsInt() @Min(0) revision: number;
}

/** Whole-project selection is evaluated server-side without pagination loss. */
export class SelectionDto implements AdoSelection {
  /** Selection basis. */
  @IsIn(['project', 'sprint', 'subtree', 'manual']) scope: AdoSelection['scope'];
  /** Sprint or subtree root. */
  @IsOptional() @IsUUID() rootId?: string;
  /** Exact manual identities. */
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) itemIds?: string[];
  /** Label filter IDs. */
  @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsUUID('all', { each: true }) labelIds: string[];
  /** Any/all label semantics. */
  @IsIn(['any', 'all']) labelMode: 'any' | 'all';
  /** Explicit ancestor choice. */
  @IsBoolean() ancestors: boolean;
  /** Explicit completion filter. */
  @IsBoolean() excludeDone: boolean;
  /** Optional labelled note rendering. */
  @IsBoolean() notes: boolean;
}

/** Export-only envelope: never accepts incoming observations. */
export class ExportDto implements AdoExportRequest {
  /** Server-side selection. */
  @ValidateNested() @Type(() => SelectionDto) selection: SelectionDto;
  /** Single outgoing assignee for each local item. */
  @IsObject() assignees: Record<string, string | null>;
  /** Reviewed file-only differences. */
  @IsObject() choices: Record<string, Partial<Record<AdoField, AdoChoice>>>;
  /** Operator freshness acknowledgement. */
  @IsBoolean() freshnessAcknowledged: boolean;
  /** Digest from preview, required by prepare. */
  @IsOptional() @IsString() @MaxLength(64) previewDigest?: string;
  /** Retry identity. */
  @IsOptional() @IsUUID() idempotencyKey?: string;
}

/** PM-only incoming preview. All decisions are bound into its persisted digest. */
export class ImportDto implements AdoImportRequest {
  /** UTF-8 file text, also checked by byte length. */
  @IsString() @MaxLength(10 * 1024 * 1024) csv: string;
  /** Link-only, observation-only or reviewed import. */
  @IsIn(['import', 'reconcile', 'observe']) mode: AdoImportRequest['mode'];
  /** Null explicitly selects every uploaded row. */
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @ArrayUnique() @IsInt({ each: true }) selectedRows:
    number[] | null;
  /** Required for files without provenance. */
  @IsBoolean() destinationAcknowledged: boolean;
  /** Remote IDs mapped to known local pending items. */
  @IsObject() manualLinks: Record<string, string>;
  /** Explicitly new remote IDs. */
  @IsArray() @ArrayMaxSize(1000) @ArrayUnique() @IsString({ each: true }) confirmedNew: string[];
  /** Explicitly omitted remote parents. */
  @IsArray() @ArrayMaxSize(1000) @ArrayUnique() @IsString({ each: true }) omittedParents: string[];
  /** Per-field incoming choices. */
  @IsObject() choices: Record<string, Partial<Record<AdoField, AdoChoice>>>;
  /** Reverse-type resolutions. */
  @IsObject() types: Record<string, ItemType>;
  /** Explicit label creation list, semantically validated before use. */
  @IsArray()
  @ArrayMaxSize(100)
  @IsObject({ each: true })
  createLabels: AdoImportRequest['createLabels'];
  /** Durable retry identity. */
  @IsUUID() idempotencyKey: string;
}

/** Apply exactly the reviewed persisted batch. */
export class ApplyDto {
  /** Digest shown in the review. */
  @IsString() @MaxLength(64) digest: string;
}

/** Cancellation is deliberately separate from download/recovery. */
export class CancelDto {
  /** Acknowledges that the operator may already have created remote duplicates. */
  @IsBoolean() duplicateRiskAcknowledged: boolean;
}
