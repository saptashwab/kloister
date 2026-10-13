import type { BucketDto, LabelDto, SprintDto } from '@kloister/shared';
import { fromDbDate } from '../common/dates.js';
import type { Bucket, Label, Sprint } from '../generated/prisma/client.js';

/**
 * Converts a bucket row to its API shape.
 *
 * @param bucket The row.
 * @returns The DTO.
 */
export function toBucketDto(bucket: Bucket): BucketDto {
  return {
    id: bucket.id,
    name: bucket.name,
    position: bucket.position,
    onEnterMode: bucket.onEnterMode,
    onEnterStatus: bucket.onEnterStatus,
  };
}

/**
 * Converts a label row to its API shape.
 *
 * @param label The row.
 * @returns The DTO.
 */
export function toLabelDto(label: Label): LabelDto {
  return { id: label.id, name: label.name, colour: label.colour };
}

/**
 * Converts a sprint row to its API shape.
 *
 * @param sprint The row.
 * @returns The DTO.
 */
export function toSprintDto(sprint: Sprint): SprintDto {
  return {
    id: sprint.id,
    name: sprint.name,
    startDate: fromDbDate(sprint.startDate) ?? '',
    endDate: fromDbDate(sprint.endDate) ?? '',
    state: sprint.state,
    adoIterationPath: sprint.adoIterationPath,
  };
}
