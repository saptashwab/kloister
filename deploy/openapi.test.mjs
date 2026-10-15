import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('generated API document covers current routes, DTOs, session and CSRF requirements', () => {
  const document = JSON.parse(
    readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8'),
  );
  assert.equal(document.openapi, '3.0.0');
  assert(document.paths['/api/v1/projects/{id}/items/{item}/duplicate'].post);
  assert(document.paths['/api/v1/me/snapshots'].get);
  assert(document.paths['/api/v1/me/introduction'].put);
  assert(!Object.keys(document.paths).some((path) => path.includes('/export/ado')));
  assert.deepEqual(document.security, [{ cookie: [] }]);
  assert.equal(document.components.securitySchemes.cookie.name, 'sid');
  assert.deepEqual(document.paths['/api/v1/health'].get.security, []);
  assert.deepEqual(document.paths['/api/v1/auth/login'].post.security, []);
  assert(document.components.schemas.LoginDto.required.includes('password'));
  for (const path of Object.values(document.paths)) {
    for (const method of ['post', 'put', 'patch', 'delete']) {
      if (!path[method]) continue;
      assert(
        path[method].parameters.some(
          (parameter) => parameter.name === 'X-Requested-With' && parameter.required,
        ),
      );
    }
  }
});
