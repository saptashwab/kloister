import { REFERENCE_KEYS_MAX } from '@kloister/shared';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString, Matches } from 'class-validator';

/** Query string of `GET /references` (M12). */
export class ReferencesQueryDto {
  /** Canonical item keys, comma-separated, e.g. `KLO-12,OPS-3`. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter((k) => k !== '') : value,
  )
  @IsArray()
  @ArrayMaxSize(REFERENCE_KEYS_MAX)
  @IsString({ each: true })
  @Matches(/^[A-Z]{2,6}-\d{1,9}$/, { each: true })
  keys: string[];
}
