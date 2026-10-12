import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateMeDto, UpdateUserDto } from './users.dto.js';

async function invalidFields(cls: new () => object, body: object): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body));
  return errors.map((e) => e.property).sort();
}

describe('update DTOs', () => {
  it('accept omitted fields', async () => {
    expect(await invalidFields(UpdateUserDto, {})).toEqual([]);
    expect(await invalidFields(UpdateMeDto, {})).toEqual([]);
  });

  it('reject explicit nulls instead of passing them to the database', async () => {
    expect(
      await invalidFields(UpdateUserDto, { displayName: null, systemRole: null, isActive: null }),
    ).toEqual(['displayName', 'isActive', 'systemRole']);
    expect(await invalidFields(UpdateMeDto, { displayName: null })).toEqual(['displayName']);
  });

  it('trim and bound display names', async () => {
    expect(await invalidFields(UpdateMeDto, { displayName: '   ' })).toEqual(['displayName']);
    const dto = plainToInstance(UpdateMeDto, { displayName: '  Ann ' });
    expect(dto.displayName).toBe('Ann');
  });
});
