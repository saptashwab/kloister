import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { builtPath, formattedReference, referencePath } from './api-reference.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const document = JSON.parse(read('../docs/openapi.json'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const operations = Object.entries(document.paths).flatMap(([path, item]) =>
  METHODS.filter((method) => item[method]).map((method) => ({ path, method, ...item[method] })),
);

/**
 * Checks a value against the subset of OpenAPI schemas the generator writes.
 * Unknown object properties are errors too, so examples cannot carry typos.
 *
 * @param {unknown} value The value.
 * @param {Record<string, any>} schema The schema.
 * @param {string} where Path for messages.
 * @returns {string[]} Problems found.
 */
function validate(value, schema, where) {
  if (schema.$ref !== undefined) {
    return validate(value, document.components.schemas[schema.$ref.split('/').at(-1)], where);
  }
  if (value === null) return schema.nullable ? [] : [`${where} is null`];
  const problems = (schema.allOf ?? []).flatMap((part) => validate(value, part, where));
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((part) => validate(value, part, where).length === 0);
    if (matches.length !== 1) problems.push(`${where} matches ${matches.length} of oneOf`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(`${where} is not one of ${schema.enum.join(', ')}`);
  }
  const actual = Array.isArray(value) ? 'array' : typeof value;
  const expected = schema.type === 'integer' ? 'number' : schema.type;
  if (expected !== undefined && actual !== expected)
    return [`${where} is ${actual}, not ${expected}`];
  if (actual === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      problems.push(`${where} too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      problems.push(`${where} too long`);
  }
  if (actual === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${where} too small`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${where} too large`);
  }
  if (actual === 'array' && schema.items !== undefined) {
    value.forEach((entry, index) =>
      problems.push(...validate(entry, schema.items, `${where}[${index}]`)),
    );
  }
  if (
    actual === 'object' &&
    (schema.properties !== undefined || schema.additionalProperties !== undefined)
  ) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) problems.push(`${where}.${name} is missing`);
    }
    for (const [name, entry] of Object.entries(value)) {
      const property = schema.properties?.[name] ?? schema.additionalProperties;
      if (property === undefined) problems.push(`${where}.${name} is not in the schema`);
      else problems.push(...validate(entry, property, `${where}.${name}`));
    }
  }
  return problems;
}

test('generated API document covers current routes, DTOs, session and CSRF requirements', () => {
  assert.equal(document.openapi, '3.0.0');
  assert(document.paths['/api/v1/projects/{id}/items/{item}/duplicate'].post);
  assert(document.paths['/api/v1/me/snapshots'].get);
  assert(document.paths['/api/v1/me/introduction'].put);
  assert(!Object.keys(document.paths).some((path) => path.includes('/export/ado')));
  assert.deepEqual(document.security, [{ session: [] }]);
  assert.deepEqual(document.components.securitySchemes.session, {
    type: 'apiKey',
    in: 'cookie',
    name: 'sid',
  });
  assert.equal(document.components.securitySchemes.csrf.in, 'header');
  assert.equal(document.components.securitySchemes.csrf.name, 'x-requested-with');
  assert.deepEqual(document.paths['/api/v1/health'].get.security, []);
  assert.deepEqual(document.paths['/api/v1/auth/login'].post.security, [{ csrf: [] }]);
  assert(document.components.schemas.LoginDto.required.includes('password'));
  for (const operation of operations) {
    const write = operation.method !== 'get';
    const schemes = operation.security.flatMap((entry) => Object.keys(entry));
    assert.equal(schemes.includes('csrf'), write, `${operation.operationId} CSRF requirement`);
  }
});

test('the document carries the release version from the root package.json', () => {
  const { version } = JSON.parse(read('../package.json'));
  assert.equal(document.info.version, version);
});

test('every operation has a summary, a permission, a tag and a documented response', () => {
  const tags = new Set(document.tags.map((tag) => tag.name));
  for (const operation of operations) {
    const name = `${operation.method.toUpperCase()} ${operation.path}`;
    assert(operation.summary?.trim(), `${name} has no summary`);
    assert(operation['x-permission']?.trim(), `${name} has no permission`);
    assert.equal(operation.tags.length, 1, `${name} needs one tag`);
    assert(tags.has(operation.tags[0]), `${name} tag ${operation.tags[0]} is not listed`);
    const success = Object.entries(operation.responses).filter(([status]) =>
      status.startsWith('2'),
    );
    assert(success.length > 0, `${name} has no success response`);
    for (const [status, response] of success) {
      assert(
        status === '204' || Object.keys(response.content ?? {}).length > 0,
        `${name} ${status} has no response schema`,
      );
      for (const media of Object.values(response.content ?? {})) {
        assert(media.schema !== undefined, `${name} ${status} has no response schema`);
      }
    }
    for (const response of Object.values(operation.responses)) {
      if (response.$ref === undefined) continue;
      const shared = document.components.responses[response.$ref.split('/').at(-1)];
      assert.deepEqual(shared.content['application/json'].schema, {
        $ref: '#/components/schemas/ApiError',
      });
    }
  }
  for (const tag of document.tags) assert(tag.description?.trim(), `tag ${tag.name} has no text`);
});

test('every schema reference resolves', () => {
  const text = JSON.stringify(document);
  for (const [, kind, name] of text.matchAll(/"#\/components\/(schemas|responses)\/([^"]+)"/g)) {
    assert(document.components[kind][name] !== undefined, `${kind}/${name} is missing`);
  }
});

test('the worked examples match the generated schemas', () => {
  let count = 0;
  for (const operation of operations) {
    const bodies = [
      ['request', operation.requestBody?.content?.['application/json']],
      ...Object.entries(operation.responses).map(([status, response]) => [
        status,
        response.content?.['application/json'],
      ]),
    ];
    for (const [label, media] of bodies) {
      if (media?.example === undefined) continue;
      count += 1;
      assert.deepEqual(
        validate(media.example, media.schema, `${operation.operationId} ${label}`),
        [],
      );
    }
  }
  // Items, timeline reschedule, notes and sprints carry examples (M11 plan section 4).
  assert(count >= 8, `only ${count} examples`);
});

test('the live update stream lists its events with their data', () => {
  const stream = document.paths['/api/v1/events'].get;
  assert(stream.responses['200'].content['text/event-stream']);
  assert(stream.responses['204']);
  for (const event of ['hello', 'item-changed', 'presence', 'resync', 'disabled']) {
    assert(stream['x-events'][event], event);
    assert(stream.description.includes(`\`${event}\``), event);
  }
});

test('the committed OpenAPI document and API reference match the build', async () => {
  // The API build writes apps/api/dist/openapi.json; `npm run docs` copies it here.
  if (existsSync(builtPath)) {
    assert.equal(
      read('../docs/openapi.json'),
      readFileSync(builtPath, 'utf8'),
      'docs/openapi.json is stale; run npm run build && npm run docs',
    );
  } else {
    assert(!process.env['CI'], 'CI must build before testing');
  }
  assert.equal(
    readFileSync(referencePath, 'utf8'),
    await formattedReference(document),
    'docs/technical/API.md is stale; run npm run docs',
  );
});
