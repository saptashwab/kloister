import { type AdoProfile, type AdoProcess, ItemType, ItemStatus } from '@kloister/shared';
import { invalidField } from '../common/api-exception.js';

/**
 * Builds conservative editable presets. State/bucket and reverse choices require PM review.
 * @param process Selected process.
 * @returns Unconfirmed profile; dates are disabled.
 */
export function preset(process: AdoProcess): AdoProfile {
  const types = {
    EPIC: 'Epic',
    FEATURE: 'Feature',
    STORY:
      process === 'Scrum'
        ? 'Product Backlog Item'
        : process === 'CMMI'
          ? 'Requirement'
          : 'User Story',
    TASK: 'Task',
    BUG: 'Bug',
  };
  const forward: AdoProfile['types'] =
    process === 'Basic'
      ? { EPIC: null, FEATURE: 'Epic', STORY: 'Issue', TASK: 'Task', BUG: 'Issue' }
      : types;
  if (process === 'Custom')
    for (const key of Object.keys(forward) as ItemType[]) forward[key] = null;
  return {
    process,
    types: forward,
    reverseTypes: {},
    states: Object.fromEntries(
      Object.values(ItemType).map((type) => [
        type,
        Object.fromEntries(Object.values(ItemStatus).map((s) => [s, null])),
      ]),
    ) as AdoProfile['states'],
    incomingStates: {},
    dateTypes: {},
    fields: {
      priority: 'Priority',
      labelIds: 'Tags',
      sprintId: 'Iteration Path',
      area: 'Area Path',
    },
    identities: {},
    incomingIdentities: {},
    tags: {},
    iterations: {},
    iterationRoot: '',
    area: '',
    constants: [],
  };
}

/**
 * Accepts only plain maps, preventing prototype-key interpretation in uploaded profiles.
 * @param value Unknown input.
 * @returns The validated own-property map.
 */
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidField('profile', 'Expected an object');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((k) => ['__proto__', 'constructor', 'prototype'].includes(k)))
    throw invalidField('profile', 'Reserved map key');
  return result;
}

/**
 * Validates nested settings before persistence or use; constants cannot override emitted fields.
 * @param value Unknown submitted profile.
 * @returns Typed reviewed profile.
 */
export function validateProfile(value: unknown): AdoProfile {
  const p = object(value);
  const allowed = new Set([
    'process',
    'types',
    'reverseTypes',
    'states',
    'incomingStates',
    'fields',
    'dateTypes',
    'identities',
    'incomingIdentities',
    'tags',
    'iterations',
    'iterationRoot',
    'area',
    'constants',
  ]);
  if (Object.keys(p).some((key) => !allowed.has(key)))
    throw invalidField('profile', 'Unknown profile property');
  if (!['Basic', 'Agile', 'Scrum', 'CMMI', 'Custom'].includes(String(p['process'])))
    throw invalidField('profile', 'Choose a known process or Custom');
  const text = (v: unknown, empty = true): v is string =>
    typeof v === 'string' &&
    v.length <= 1000 &&
    (empty || v.trim().length > 0) &&
    ![...v].some((c) => c.charCodeAt(0) < 32);
  const types = object(p['types']);
  const states = object(p['states']);
  for (const type of Object.values(ItemType)) {
    if (types[type] !== null && !text(types[type], false))
      throw invalidField('types', 'Map or explicitly omit every type');
    const map = object(states[type]);
    for (const status of Object.values(ItemStatus))
      if (map[status] !== null && !text(map[status], false))
        throw invalidField('states', 'Map or explicitly omit every status');
  }
  for (const v of Object.values(object(p['reverseTypes'])))
    if (!Object.values(ItemType).includes(v as ItemType))
      throw invalidField('reverseTypes', 'Unknown local type');
  for (const [key, v] of Object.entries(object(p['incomingStates']))) {
    const m = object(v);
    if (
      !key.includes('\n') ||
      !Object.values(ItemStatus).includes(m['status'] as ItemStatus) ||
      !text(m['bucketId'], false)
    )
      throw invalidField(
        'incomingStates',
        'Map each remote type/state to a status and existing bucket',
      );
  }
  const fields = object(p['fields']);
  const optional = ['priority', 'labelIds', 'sprintId', 'startDate', 'dueDate', 'area'];
  const reserved =
    /^(?:ID|Work Item Type|Description|Title(?: \d+)?|State|Assigned To|Parent|Team Project|Changed Date|Created By)$/iu;
  const headers = new Set<string>();
  const dateTypes = object(p['dateTypes']);
  for (const [key, value] of Object.entries(dateTypes))
    if (
      !['startDate', 'dueDate'].includes(key) ||
      !Array.isArray(value) ||
      value.some((v: unknown) => !Object.values(ItemType).includes(v as ItemType))
    )
      throw invalidField('dateTypes', 'Confirm date capability per local type');
  for (const [key, v] of Object.entries(fields)) {
    if (
      !optional.includes(key) ||
      !text(v, false) ||
      reserved.test(v) ||
      headers.has(v.toLowerCase())
    )
      throw invalidField('fields', 'Invalid or duplicate field header');
    headers.add(v.toLowerCase());
  }
  for (const name of ['identities', 'incomingIdentities', 'tags', 'iterations']) {
    for (const [k, v] of Object.entries(object(p[name])))
      if (!text(k, false) || !((name !== 'identities' && v === null) || text(v, false)))
        throw invalidField(name, 'Invalid mapping');
  }
  if (
    !text(p['iterationRoot']) ||
    !text(p['area']) ||
    !Array.isArray(p['constants']) ||
    p['constants'].length > 50
  )
    throw invalidField('profile', 'Invalid path or constants');
  for (const c of p['constants']) {
    const constant = object(c);
    const h = constant['header'];
    if (
      !text(h, false) ||
      !text(constant['value']) ||
      reserved.test(h) ||
      headers.has(h.toLowerCase())
    )
      throw invalidField('constants', 'Duplicate or reserved constant column');
    headers.add(h.toLowerCase());
  }
  if (p['process'] === 'Basic' && types['EPIC'] !== null)
    throw invalidField('types', 'Basic explicitly omits local Epics');
  if (JSON.stringify(p).length > 128 * 1024)
    throw invalidField('profile', 'Profile exceeds 128 KiB');
  return p as unknown as AdoProfile;
}
