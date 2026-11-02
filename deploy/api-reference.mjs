// Generates docs/technical/API.md from docs/openapi.json.
//
//   node deploy/api-reference.mjs           check only; exits 1 when docs/openapi.json or
//                                           API.md is stale
//   node deploy/api-reference.mjs --write   copy the build's apps/api/dist/openapi.json to
//                                           docs/ and rewrite API.md
//
// Run `npm run build` first: the API build writes apps/api/dist/openapi.json.
// Uses only Node and the repository's Prettier, so the output matches format:check.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const root = new URL('../', import.meta.url);
/** Document produced by the API build. */
export const builtPath = new URL('apps/api/dist/openapi.json', root);
/** Committed OpenAPI document. */
export const documentPath = new URL('docs/openapi.json', root);
/** Committed readable reference. */
export const referencePath = new URL('docs/technical/API.md', root);

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * GitHub's heading anchor for a heading text.
 *
 * @param {string} text Heading text.
 * @returns {string} The anchor without `#`.
 */
export function anchor(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Escapes text for a Markdown table cell.
 *
 * @param {string} text Cell text.
 * @returns {string} Safe text on one line.
 */
function cell(text) {
  return String(text ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * A short type for a schema, linking named schemas.
 *
 * @param {Record<string, any>} schema The schema.
 * @returns {string} Markdown type text.
 */
function typeText(schema) {
  if (schema === undefined || Object.keys(schema).length === 0) return 'any';
  let text;
  if (schema.$ref !== undefined) {
    const name = schema.$ref.split('/').at(-1);
    text = `[${name}](#${anchor(name)})`;
  } else if (schema.allOf?.length === 1) {
    text = typeText(schema.allOf[0]);
  } else if (schema.oneOf !== undefined) {
    text = schema.oneOf.map(typeText).join(' or ');
  } else if (schema.enum !== undefined) {
    text = schema.enum.map((value) => `\`${JSON.stringify(value)}\``).join(', ');
  } else if (schema.type === 'array') {
    text = `${typeText(schema.items)}[]`;
  } else if (schema.type === 'object' && schema.additionalProperties !== undefined) {
    text = `map of ${typeText(schema.additionalProperties)}`;
  } else {
    text = schema.format === undefined ? schema.type : `${schema.type} (${schema.format})`;
  }
  return schema.nullable ? `${text} or null` : text;
}

/**
 * Table rows for an object schema, flattening inline objects and arrays of
 * inline objects into dotted names.
 *
 * @param {Record<string, any>} schema The object schema.
 * @param {string} prefix Name prefix for nested rows.
 * @returns {string[]} Table rows.
 */
function propertyRows(schema, prefix = '') {
  const rows = [];
  const required = new Set(schema.required ?? []);
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const full = `${prefix}${name}`;
    const inner = property.type === 'array' ? property.items : property;
    const nested =
      inner?.type === 'object' && inner.properties !== undefined && inner.$ref === undefined;
    rows.push(
      `| \`${full}\` | ${cell(nested ? (property.type === 'array' ? 'object[]' : 'object') : typeText(property))} | ${required.has(name) ? 'yes' : 'no'} | ${cell(property.description)} |`,
    );
    if (nested)
      rows.push(...propertyRows(inner, `${full}${property.type === 'array' ? '[]' : ''}.`));
  }
  return rows;
}

/**
 * Describes a body schema: a property table for inline objects, otherwise a
 * type line.
 *
 * @param {Record<string, any>} schema The schema.
 * @returns {string[]} Markdown lines.
 */
function bodyLines(schema) {
  const inner = schema.type === 'array' ? schema.items : schema;
  if (inner?.type === 'object' && inner.properties !== undefined && inner.$ref === undefined) {
    return [
      schema.type === 'array' ? 'An array of objects:' : 'An object:',
      '',
      '| Field | Type | Required | Description |',
      '| --- | --- | --- | --- |',
      ...propertyRows(inner),
    ];
  }
  return [`Type: ${typeText(schema)}`];
}

/**
 * Renders the introduction that applies to every route.
 *
 * @param {Record<string, any>} document The OpenAPI document.
 * @returns {string[]} Markdown lines.
 */
function introduction(document) {
  const cookie = document.components.securitySchemes.session;
  const csrf = document.components.securitySchemes.csrf;
  const codes = document.components.schemas.ApiError.properties.code.enum;
  const responses = document.components.responses;
  const statusOf = Object.fromEntries(
    Object.entries(document.paths).flatMap(([, item]) =>
      METHODS.flatMap((method) =>
        Object.entries(item[method]?.responses ?? {})
          .filter(([, response]) => response.$ref !== undefined)
          .map(([status, response]) => [response.$ref.split('/').at(-1), status]),
      ),
    ),
  );
  const limit = document.paths['/api/v1/projects/{id}/items'].get.parameters.find(
    (parameter) => parameter.name === 'limit',
  );
  return [
    '# API reference',
    '',
    `<!-- Generated by deploy/api-reference.mjs from docs/openapi.json (version ${document.info.version}); do not edit by hand. -->`,
    '',
    `Every route of the Kloister API, generated from the code. The machine-readable document is [\`docs/openapi.json\`](../openapi.json) (OpenAPI ${document.openapi}); open it in any OpenAPI viewer to browse or try it. The app itself serves no API explorer.`,
    '',
    '## Contents',
    '',
    '- [Conventions](#conventions)',
    ...document.tags.map((tag) => `- [${tag.name}](#${anchor(tag.name)})`),
    '- [Live update events](#live-update-events)',
    '- [Schemas](#schemas)',
    '',
    '## Conventions',
    '',
    '### Base path and formats',
    '',
    'Routes live under `/api/v1` below the app path (for example `https://kloister.example.org/kloister/api/v1/health` when the app is served at `/kloister/`). Requests and responses are JSON unless a route says otherwise. Dates without a time are `YYYY-MM-DD` strings; timestamps are ISO 8601 in UTC.',
    '',
    '### Authentication',
    '',
    `Sign in with \`POST /api/v1/auth/login\`. The answer sets the \`${cookie.name}\` cookie (HttpOnly, scoped to the app path), which every other request sends. Routes marked "Public" need no session. While an account still has its temporary password, only the routes marked "Also allowed while the temporary password still has to be changed" work; the rest answer 403 \`PASSWORD_CHANGE_REQUIRED\`.`,
    '',
    `Every request that is not GET, HEAD or OPTIONS must send the header \`${csrf.name}: kloister\`, sign-in included. Browsers cannot add this header to a cross-site form post, so it protects the cookie session against cross-site request forgery; without it the API answers 403 \`CSRF_HEADER_MISSING\`.`,
    '',
    '### Permissions',
    '',
    "Each route names who may call it. Project routes (`/api/v1/projects/{id}/...`, where `{id}` is the project uuid or its key) need a project permission; the role list after each permission comes from the role table in `packages/shared/src/projects.ts`. Non-members get 404, so a project's existence is not disclosed. Items outside the caller's visibility scope also answer 404. Routes under `/api/v1/admin` need the system administrator role. Personal spaces are the exception to the role lists: only their owner reaches them (everyone else, administrators included, gets 404), and the members, teams, timeline, holidays, ADO and archive routes answer 404 even to the owner. See [SECURITY.md](SECURITY.md) for the complete rules.",
    '',
    '### Item references',
    '',
    '`{item}` in a path is the item uuid or its number within the project (`42` for `KLO-42`).',
    '',
    '### Pagination',
    '',
    `List routes that take \`cursor\` and \`limit\` return \`{ items, nextCursor }\`. Pass the previous \`nextCursor\` as \`cursor\` to get the next page; \`nextCursor\` is null on the last page. \`limit\` is ${limit.schema.minimum} to ${limit.schema.maximum} (default 50).`,
    '',
    '### Errors',
    '',
    'Every error has the [`ApiError`](#apierror) shape `{ code, message, details? }`. `message` is safe to show to users; `code` is stable.',
    '',
    '| Status | Meaning |',
    '| --- | --- |',
    ...Object.entries(responses)
      .sort(([a], [b]) => Number(statusOf[a]) - Number(statusOf[b]))
      .map(([name, response]) => `| ${statusOf[name]} | ${cell(response.description)} |`),
    '| 500 | `INTERNAL`: an unexpected server error; details go to the server log only. |',
    '',
    `Codes: ${codes.map((code) => `\`${code}\``).join(', ')}.`,
    '',
    '### Limits',
    '',
    "- JSON bodies: up to 1 MiB (Fastify's default), except the ADO sample and incoming-preview routes, which take up to 24 MiB because they carry a CSV of up to 10 MiB, 1,000 data rows and 1 MiB per cell.",
    '- Sign-in: a fixed number of attempts per client address per window (`LOGIN_RATE_LIMIT`, default 10, per `LOGIN_RATE_WINDOW_SECONDS`, default 60); more answer 429 with `Retry-After`.',
    '- Uploads (`application/octet-stream` bodies with an `x-file-name` header): the size limit and project quota are admin settings (`GET /api/v1/admin/settings/storage`).',
    '',
  ];
}

/**
 * Renders one operation.
 *
 * @param {string} path The path.
 * @param {string} method The method.
 * @param {Record<string, any>} operation The operation.
 * @returns {string[]} Markdown lines.
 */
function operationLines(path, method, operation) {
  const lines = [`### ${method.toUpperCase()} ${path}`, '', operation.summary, ''];
  const rest = (operation.description ?? '')
    .split('\n\n')
    .filter((part) => !part.startsWith('**Permission:**'))
    .join('\n\n');
  if (rest !== '') lines.push(rest, '');
  lines.push(`**Permission:** ${operation['x-permission']}`, '');
  const parameters = operation.parameters ?? [];
  if (parameters.length > 0) {
    lines.push(
      '| Parameter | In | Type | Required | Description |',
      '| --- | --- | --- | --- | --- |',
      ...parameters.map(
        (parameter) =>
          `| \`${parameter.name}\` | ${parameter.in} | ${cell(typeText(parameter.schema))} | ${parameter.required ? 'yes' : 'no'} | ${cell(parameter.description)} |`,
      ),
      '',
    );
  }
  if (operation.requestBody !== undefined) {
    const [mediaType, media] = Object.entries(operation.requestBody.content)[0];
    lines.push(`**Request body** (\`${mediaType}\`)`, '');
    if (operation.requestBody.description) lines.push(operation.requestBody.description, '');
    if (mediaType === 'application/json') lines.push(...bodyLines(media.schema), '');
    if (media.example !== undefined) {
      lines.push('Example:', '', '```json', JSON.stringify(media.example, null, 2), '```', '');
    }
  }
  lines.push('**Responses**', '');
  for (const [status, response] of Object.entries(operation.responses)) {
    if (response.$ref !== undefined) continue;
    const types = Object.keys(response.content ?? {});
    const media = response.content?.['application/json'];
    lines.push(
      `- **${status}** ${response.description}${types.length > 0 && media === undefined ? ` (${types.map((type) => `\`${type}\``).join(', ')})` : ''}`,
    );
    if (media !== undefined) {
      lines.push('', ...bodyLines(media.schema).map((line) => (line === '' ? '' : `  ${line}`)));
      if (media.example !== undefined) {
        lines.push(
          '',
          '  Example:',
          '',
          '  ```json',
          ...JSON.stringify(media.example, null, 2)
            .split('\n')
            .map((line) => `  ${line}`),
          '  ```',
        );
      }
    }
  }
  const errors = Object.entries(operation.responses)
    .filter(([, response]) => response.$ref !== undefined)
    .map(([status]) => status);
  if (errors.length > 0) lines.push(`- Errors: ${errors.join(', ')} ([ApiError](#apierror))`);
  lines.push('');
  return lines;
}

/**
 * Renders one named schema.
 *
 * @param {string} name The schema name.
 * @param {Record<string, any>} schema The schema.
 * @returns {string[]} Markdown lines.
 */
function schemaLines(name, schema) {
  const lines = [`### ${name}`, ''];
  if (schema.description) lines.push(schema.description, '');
  if (schema.enum !== undefined) {
    lines.push(`One of ${schema.enum.map((value) => `\`${JSON.stringify(value)}\``).join(', ')}.`);
  } else if (schema.properties !== undefined) {
    lines.push(
      '| Field | Type | Required | Description |',
      '| --- | --- | --- | --- |',
      ...propertyRows(schema),
    );
  } else {
    lines.push(`Type: ${typeText(schema)}`);
  }
  lines.push('');
  return lines;
}

/**
 * Renders the whole reference, unformatted.
 *
 * @param {Record<string, any>} document The OpenAPI document.
 * @returns {string} Markdown.
 */
export function renderReference(document) {
  const lines = introduction(document);
  for (const tag of document.tags) {
    lines.push(`## ${tag.name}`, '');
    if (tag.description) lines.push(tag.description, '');
    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of METHODS) {
        const operation = item[method];
        if (operation?.tags?.[0] === tag.name)
          lines.push(...operationLines(path, method, operation));
      }
    }
  }
  const stream = document.paths['/api/v1/events']?.get?.['x-events'];
  if (stream !== undefined) {
    lines.push(
      '## Live update events',
      '',
      'Data of each event on `GET /api/v1/events`; see [LIVE-UPDATES.md](LIVE-UPDATES.md).',
      '',
      '| Event | Data |',
      '| --- | --- |',
      ...Object.entries(stream).map(
        ([event, schema]) => `| \`${event}\` | ${cell(schema.$ref ? typeText(schema) : '`{}`')} |`,
      ),
      '',
    );
  }
  lines.push('## Schemas', '');
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    lines.push(...schemaLines(name, schema));
  }
  return lines.join('\n');
}

/**
 * Renders the formatted reference for a document.
 *
 * @param {Record<string, any>} document The OpenAPI document.
 * @returns {Promise<string>} Markdown that passes format:check.
 */
export async function formattedReference(document) {
  const options = await resolveConfig(fileURLToPath(referencePath));
  return format(renderReference(document), { ...options, parser: 'markdown' });
}

// Command line: check, or copy and rewrite with --write.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    if (!existsSync(builtPath)) throw new Error('Run npm run build first');
    writeFileSync(documentPath, readFileSync(builtPath, 'utf8'));
    const document = JSON.parse(readFileSync(documentPath, 'utf8'));
    writeFileSync(referencePath, await formattedReference(document));
  } else {
    const document = JSON.parse(readFileSync(documentPath, 'utf8'));
    const stale =
      (existsSync(builtPath) &&
        readFileSync(builtPath, 'utf8') !== readFileSync(documentPath, 'utf8')) ||
      readFileSync(referencePath, 'utf8') !== (await formattedReference(document));
    if (stale) {
      console.error('docs/openapi.json or docs/technical/API.md is stale; run npm run docs');
      process.exit(1);
    }
  }
}
