import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  ErrorCode,
  FILE_NAME_HEADER,
  LiveEvent,
  ProjectPermission,
  ProjectRole,
  permissionsFor,
} from '@kloister/shared';
import { format, resolveConfig } from 'prettier';
import { AppModule } from '../app.module.js';
import { configureApp, createAdapter } from '../app.factory.js';
import {
  ADMIN_ONLY_KEY,
  ALLOW_PENDING_PASSWORD_CHANGE_KEY,
  IS_PUBLIC_KEY,
} from '../auth/decorators.js';
import { SESSION_COOKIE } from '../auth/session.service.js';
import {
  PROJECT_PERMISSION_KEY,
  type ProjectPermissionRequirement,
} from '../projects/project-access.guard.js';
import { OPERATION_EXAMPLES } from './openapi-examples.js';
import { plainDocText, type SchemaObject, TypeSchemaReader } from './openapi-types.js';

// Build-time only: construct metadata without app.init(), listen(), scheduled
// jobs or database queries. Never mount Swagger UI or a document HTTP endpoint.
// Writes apps/api/dist/openapi.json by default; `npm run docs` copies it to
// docs/ and a deployment test fails when the committed copy is stale.

process.env['DATABASE_URL'] = 'postgresql://documentation:documentation@127.0.0.1:1/documentation';
process.env['NODE_ENV'] = 'development';
delete process.env['LOG_DIR'];

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '../..');
const version = (
  JSON.parse(readFileSync(resolve(apiRoot, '../../package.json'), 'utf8')) as { version: string }
).version;

/** Responses written by hand for routes that answer through the raw reply. */
const RAW_RESPONSES: Record<string, { status: string; content: Record<string, SchemaObject> }> = {
  LiveController_open: {
    status: '200',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  },
  ProjectSnapshotsController_download: {
    status: '200',
    content: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
        schema: { type: 'string', format: 'binary' },
      },
      'application/zip': { schema: { type: 'string', format: 'binary' } },
    },
  },
  WorkSnapshotsController_download: {
    status: '200',
    content: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
        schema: { type: 'string', format: 'binary' },
      },
      'application/zip': { schema: { type: 'string', format: 'binary' } },
    },
  },
  TimelineController_msProject: {
    status: '200',
    content: { 'application/xml': { schema: { type: 'string', format: 'binary' } } },
  },
  AdoController_download: {
    status: '200',
    content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
  },
};

/** Media types of file downloads that return a `StreamableFile`. */
const FILE_TYPES: Record<string, string[]> = {
  PublicBrandingController_logo: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  PublicBrandingController_font: ['font/woff2', 'font/woff', 'font/ttf', 'font/otf'],
  InlineImagesController_view: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};

/**
 * Error statuses a route answers beyond what its guards, parameters and
 * method imply, read from the routes' doc comments.
 */
const EXTRA_ERRORS: Record<string, string[]> = {
  PersonalController_get: ['404'],
  PublicBrandingController_logo: ['404'],
  PublicBrandingController_font: ['404'],
  AdoController_sample: ['413'],
  AdoController_previewImport: ['413'],
};

/** Routes that answer 304 to a matching `If-None-Match` (ETag). */
const NOT_MODIFIED = new Set(['PublicBrandingController_logo', 'PublicBrandingController_font']);

/** Data schema of each live-update event, by event name (shared type names). */
const LIVE_EVENT_DATA: Record<LiveEvent, string | null> = {
  [LiveEvent.HELLO]: 'LiveHelloDto',
  [LiveEvent.ITEM_CHANGED]: 'LiveItemsDto',
  [LiveEvent.ITEM_REMOVED]: 'LiveItemsDto',
  [LiveEvent.LINKS_CHANGED]: 'LiveLinksDto',
  [LiveEvent.BOARD_CHANGED]: 'LiveProjectDto',
  [LiveEvent.ACCESS_CHANGED]: 'LiveProjectDto',
  [LiveEvent.NOTIFICATION]: null,
  [LiveEvent.PRESENCE]: 'LivePresenceDto',
  [LiveEvent.PROJECT_RESYNC]: 'LiveProjectDto',
  [LiveEvent.RESYNC]: null,
  [LiveEvent.DISABLED]: null,
};

/** Shared error responses, each referencing the one error schema. */
const ERROR_RESPONSES: Record<string, { name: string; description: string }> = {
  '400': {
    name: 'BadRequest',
    description:
      '`VALIDATION_FAILED`: a parameter or body field is invalid; `details` lists `{ field, messages }` per field. A password change with a wrong current password answers `INVALID_CREDENTIALS`.',
  },
  '401': {
    name: 'Unauthenticated',
    description:
      '`UNAUTHENTICATED`: no valid session cookie. Sign-in with a wrong email or password answers `INVALID_CREDENTIALS`.',
  },
  '403': {
    name: 'Forbidden',
    description:
      '`FORBIDDEN` (the role or a rule does not allow it), `PASSWORD_CHANGE_REQUIRED` (the temporary password must be changed first) or `CSRF_HEADER_MISSING` (a write without the header).',
  },
  '404': {
    name: 'NotFound',
    description:
      '`NOT_FOUND`: it does not exist, or the caller may not know it exists (non-members, items outside the visibility scope).',
  },
  '409': {
    name: 'Conflict',
    description:
      '`CONFLICT` or a specific code (`PROJECT_ARCHIVED`, `HAS_CHILDREN`, `BUCKET_NOT_EMPTY`, `LAST_ADMIN`, `LAST_PM`, `QUOTA_EXCEEDED`, `BACKUP_RUNNING`): the change clashes with the current state.',
  },
  '413': {
    name: 'TooLarge',
    description:
      '`FILE_TOO_LARGE`: the upload exceeds the size limit. A body above the request limit of the route also answers 413.',
  },
  '415': {
    name: 'UnsupportedType',
    description: '`UNSUPPORTED_FILE_TYPE`: the file content is not an accepted type.',
  },
  '429': {
    name: 'RateLimited',
    description: '`RATE_LIMITED`: too many sign-in attempts; see the `Retry-After` header.',
  },
};

/** Area order for the reference; any other tag follows alphabetically. */
const TAG_ORDER = [
  'Health',
  'Auth',
  'Me',
  'Introduction',
  'Work',
  'Work snapshots',
  'Personal',
  'Projects',
  'Project',
  'Members',
  'Teams',
  'Buckets',
  'Labels',
  'Sprints',
  'Items',
  'Checklist',
  'Duplication',
  'Notes',
  'Attachments',
  'Inline images',
  'Timeline',
  'Project holidays',
  'Project snapshots',
  'ADO transfer',
  'Notifications',
  'Live updates',
  'Public branding',
  'Admin users',
  'Admin settings',
  'Admin branding',
  'Admin holidays',
  'Backups',
  'Audit log',
];

/** Tag names that read better than the controller name. */
const TAG_NAMES: Record<string, string> = {
  AdoController: 'ADO transfer',
  LiveController: 'Live updates',
  AuditController: 'Audit log',
};

/**
 * Turns a controller class name into its tag: `AdminUsersController` →
 * `Admin users`.
 *
 * @param className The class name.
 * @returns The tag.
 */
function tagOf(className: string): string {
  const named = TAG_NAMES[className];
  if (named !== undefined) return named;
  const words = className
    .replace(/Controller$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The roles that hold a project permission, from the shared role table.
 *
 * @param permission The permission.
 * @returns Role names, e.g. `PM, LEAD`.
 */
function holders(permission: ProjectPermission): string {
  const roles = Object.values(ProjectRole).filter((role) =>
    permissionsFor(role, { membersCanAssignOthers: false }).includes(permission),
  );
  const optional = Object.values(ProjectRole).filter(
    (role) =>
      !roles.includes(role) &&
      permissionsFor(role, { membersCanAssignOthers: true }).includes(permission),
  );
  const text = roles.join(', ');
  const extra = optional.length > 0 ? `; ${optional.join(', ')} when the project allows it` : '';
  const admin =
    permission === ProjectPermission.VIEW_ITEMS || permission === ProjectPermission.ASSIGN_PMS
      ? '; system administrators in every ordinary project'
      : '';
  return `${text}${extra}${admin}`;
}

/**
 * Describes who may call a route from the guards' metadata.
 *
 * @param handler The route handler.
 * @param controller The controller class.
 * @returns The permission text and whether the route is public.
 */
function permissionOf(handler: object, controller: object): { text: string; isPublic: boolean } {
  const read = <T>(key: string): T | undefined =>
    (Reflect.getMetadata(key, handler) as T | undefined) ??
    (Reflect.getMetadata(key, controller) as T | undefined);
  if (read<boolean>(IS_PUBLIC_KEY) === true) {
    return { text: 'Public: no session needed.', isPublic: true };
  }
  const pending =
    read<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY) === true
      ? ' Also allowed while the temporary password still has to be changed.'
      : '';
  if (read<boolean>(ADMIN_ONLY_KEY) === true) {
    return { text: `System administrators only.${pending}`, isPublic: false };
  }
  const requirement = read<ProjectPermissionRequirement>(PROJECT_PERMISSION_KEY);
  if (requirement !== undefined) {
    const names = requirement.permissions
      .map((permission) => `\`${permission}\` (${holders(permission)})`)
      .join(' or ');
    const archived = requirement.allowArchived
      ? ' Allowed on archived projects.'
      : requirement.allowArchivedForPmAssignment
        ? ' Allowed on archived projects for administrators changing PM roles.'
        : '';
    return {
      text: `Project member with ${names}. Non-members get 404.${archived}${pending}`,
      isPublic: false,
    };
  }
  return { text: `Any signed-in user.${pending}`, isPublic: false };
}

const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(false), {
  logger: false,
});
try {
  await configureApp(app);
  const config = new DocumentBuilder()
    .setTitle('Kloister API')
    .setVersion(version)
    .setDescription(
      'REST API of Kloister under `/api/v1`, JSON unless a route says otherwise. ' +
        `Sign in with \`POST /api/v1/auth/login\`; the session travels in the \`${SESSION_COOKIE}\` cookie. ` +
        `Every request that is not GET, HEAD or OPTIONS needs the header \`${CSRF_HEADER}: ${CSRF_HEADER_VALUE}\`. ` +
        'Authorization is enforced by the API; items the caller may not see answer 404. ' +
        'Errors share the `ApiError` shape. The readable reference is docs/technical/API.md.',
    )
    .addCookieAuth(SESSION_COOKIE, undefined, 'session')
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: CSRF_HEADER,
        description: `Must be \`${CSRF_HEADER_VALUE}\` on every request that is not GET, HEAD or OPTIONS, sign-in included.`,
      },
      'csrf',
    )
    .build();
  const document: OpenAPIObject = SwaggerModule.createDocument(app, config);
  const schemas = (document.components ??= {}).schemas ?? {};
  const reader = new TypeSchemaReader(
    resolve(apiRoot, 'tsconfig.build.json'),
    new Set(Object.keys(schemas)),
  );

  // Controller classes by name, for the guards' metadata.
  const classes = new Map<string, new (...args: never[]) => object>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const metatype = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (metatype !== null) classes.set(metatype.name, metatype);
    }
  }

  const tags = new Map<string, string>();
  const used = new Set<string>();
  const errorRefs = new Set<string>();
  const useError = (status: string): { $ref: string } => {
    errorRefs.add(status);
    return { $ref: `#/components/responses/${ERROR_RESPONSES[status]?.name}` };
  };
  document.security = [{ session: [] }];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = item[method];
      if (operation === undefined) continue;
      const operationId = operation.operationId ?? '';
      const [className = '', methodName = ''] = operationId.split('_');
      const controller = classes.get(className);
      const facts = reader.controller(className);
      const prototype = controller?.prototype as Record<string, unknown> | undefined;
      const handler = prototype?.[methodName] as object | undefined;
      if (controller === undefined || facts === undefined || handler === undefined) {
        throw new Error(`Cannot find the source of ${operationId}`);
      }
      const method_ = facts.methods.get(methodName);
      if (method_ === undefined) throw new Error(`Cannot read the return type of ${operationId}`);

      // Area tag, described by the controller's doc comment.
      const tag = tagOf(className);
      operation.tags = [tag];
      if (!tags.has(tag)) tags.set(tag, facts.description);

      // Who may call it, from the same metadata the guards read.
      const write = method !== 'get';
      const access = permissionOf(handler, controller);
      (operation as unknown as Record<string, unknown>)['x-permission'] = access.text;
      operation.description = [operation.description, `**Permission:** ${access.text}`]
        .filter((part) => part !== undefined && part !== '')
        .join('\n\n');
      const security: Record<string, string[]> = {};
      if (!access.isPublic) security['session'] = [];
      if (write) security['csrf'] = [];
      operation.security = Object.keys(security).length === 0 ? [] : [security];

      // Success response, from the declared return type unless written by hand.
      const success = Object.keys(operation.responses).find((status) => status.startsWith('2'));
      if (success === undefined) throw new Error(`${operationId} has no success response`);
      const raw = RAW_RESPONSES[operationId];
      used.add(operationId);
      const previous = operation.responses[success] as { description?: string };
      delete operation.responses[success];
      if (raw !== undefined) {
        operation.responses[raw.status] = { description: 'Success.', content: raw.content };
      } else if (method_.response.kind === 'file') {
        const types = FILE_TYPES[operationId] ?? ['application/octet-stream'];
        operation.responses[success] = {
          description: 'The file, with `X-Content-Type-Options: nosniff`.',
          content: Object.fromEntries(
            types.map((type) => [type, { schema: { type: 'string', format: 'binary' } }]),
          ),
        };
      } else if (method_.response.kind === 'empty') {
        if (success !== '204') {
          throw new Error(`${operationId} returns nothing but answers ${success}; document it`);
        }
        operation.responses[success] = { description: 'Done; no body.' };
      } else {
        operation.responses[success] = {
          description: previous.description || 'Success.',
          content: { 'application/json': { schema: method_.response.schema } },
        };
      }

      // Raw uploads: the body is the file itself.
      if (method_.upload) {
        operation.requestBody = {
          required: true,
          description: `The file's bytes; its name goes in the \`${FILE_NAME_HEADER}\` header.`,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        };
      }

      // Errors the guards and validation can produce for this route.
      const hasInput =
        (operation.parameters?.length ?? 0) > 0 || operation.requestBody !== undefined;
      if (hasInput) operation.responses['400'] = useError('400');
      if (!access.isPublic) operation.responses['401'] = useError('401');
      if (!access.isPublic || write) operation.responses['403'] = useError('403');
      if (path.includes('{')) operation.responses['404'] = useError('404');
      if (write && !access.isPublic) operation.responses['409'] = useError('409');
      if (method_.upload) {
        operation.responses['413'] = useError('413');
        operation.responses['415'] = useError('415');
      }
      for (const status of EXTRA_ERRORS[operationId] ?? []) {
        operation.responses[status] = useError(status);
      }
      if (NOT_MODIFIED.has(operationId)) {
        operation.responses['304'] = { description: 'Not modified: the `ETag` still matches.' };
      }
      if (operationId === 'AuthController_login') {
        operation.responses['401'] = useError('401');
        operation.responses['429'] = useError('429');
      }

      // Worked examples for the main routes.
      const example = OPERATION_EXAMPLES[operationId];
      if (example !== undefined) {
        const body = operation.requestBody as
          { content?: Record<string, { example?: unknown }> } | undefined;
        const json = body?.content?.['application/json'];
        if (example.request !== undefined) {
          if (json === undefined) throw new Error(`${operationId} has no JSON body to illustrate`);
          json.example = example.request;
        }
        const response = operation.responses[success] as {
          content?: Record<string, { example?: unknown }>;
        };
        const answer = response.content?.['application/json'];
        if (example.response !== undefined) {
          if (answer === undefined)
            throw new Error(`${operationId} has no JSON answer to illustrate`);
          answer.example = example.response;
        }
      }

      // Summary from the doc comment (the compiler plugin only reads `*.controller.ts`).
      operation.summary = plainDocText(operation.summary ?? '') || method_.summary;
    }
  }

  // Hand-written entries must name real operations.
  for (const id of [
    ...Object.keys(RAW_RESPONSES),
    ...Object.keys(FILE_TYPES),
    ...Object.keys(EXTRA_ERRORS),
    ...NOT_MODIFIED,
    ...Object.keys(OPERATION_EXAMPLES),
  ]) {
    if (!used.has(id)) throw new Error(`No operation ${id}`);
  }

  // The live-update stream: list its events and their data schemas.
  const stream = document.paths['/api/v1/events']?.get;
  if (stream !== undefined) {
    const rows = Object.entries(LIVE_EVENT_DATA).map(([event, type]) => {
      const ref = type === null ? '`{}`' : `\`${type}\``;
      return `| \`${event}\` | ${ref} |`;
    });
    stream.responses['204'] = {
      description: 'Live updates are switched off; browsers do not retry a 204.',
    };
    stream.description = [
      stream.description,
      'Events (`event:` line, then a `data:` line with JSON):\n\n| Event | Data |\n| --- | --- |\n' +
        rows.join('\n'),
      'A comment line `: heartbeat` keeps the connection open; the first message also sets `retry: 5000`.',
    ].join('\n\n');
    (stream as unknown as Record<string, unknown>)['x-events'] = Object.fromEntries(
      Object.entries(LIVE_EVENT_DATA).map(([event, type]) => [
        event,
        type === null ? { type: 'object' } : reader.shared(type),
      ]),
    );
  }

  // Shared error schema and responses.
  schemas['ApiError'] = {
    type: 'object',
    description: 'Body of every error response (SPEC §8).',
    required: ['code', 'message'],
    properties: {
      code: { type: 'string', enum: Object.values(ErrorCode), description: 'Stable code.' },
      message: { type: 'string', description: 'Readable summary, safe to show to users.' },
      details: {
        description:
          'Optional detail; for `VALIDATION_FAILED` a list of `{ field, messages }` per invalid field.',
      },
    },
  };
  const responses: NonNullable<NonNullable<OpenAPIObject['components']>['responses']> = {};
  for (const [status, { name, description }] of Object.entries(ERROR_RESPONSES)) {
    if (!errorRefs.has(status)) continue;
    responses[name] = {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
    };
  }
  document.components.responses = responses;
  document.components.schemas = { ...schemas, ...reader.schemas };

  // Tags in reading order, each with its controller's description.
  const order = (tag: string): number => {
    const index = TAG_ORDER.indexOf(tag);
    return index === -1 ? TAG_ORDER.length : index;
  };
  document.tags = [...tags.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([name, description]) => ({ name, description }));

  const output = resolve(process.argv[2] ?? resolve(apiRoot, 'dist/openapi.json'));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    await format(JSON.stringify(document), {
      ...(await resolveConfig(resolve(apiRoot, '../../docs/openapi.json'))),
      parser: 'json',
    }),
    'utf8',
  );
} finally {
  await app.close();
}
