import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { compareDocument, END, parseSchema, START } from './schema-diagram.mjs';

// Keep the technical documents in step with the code (docs/M11-PLAN.md section 5).
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const dataModel = read('../docs/technical/DATA-MODEL.md');
// Text written by hand: the generated diagram does not count as describing a model.
const handWritten =
  dataModel.slice(0, dataModel.indexOf(START)) + dataModel.slice(dataModel.indexOf(END));

test('the schema diagram in DATA-MODEL.md matches schema.prisma', () => {
  const { current, expected } = compareDocument();
  assert.equal(current, expected, 'DATA-MODEL.md diagram is stale; run npm run docs');
});

test('every Prisma model and enum is described in DATA-MODEL.md', () => {
  const { models, enums } = parseSchema(read('../apps/api/prisma/schema.prisma'));
  assert(models.size > 0 && enums.size > 0);
  for (const name of [...models.keys(), ...enums.keys()]) {
    assert(handWritten.includes(`\`${name}\``), `${name} is not described in DATA-MODEL.md`);
  }
});

test('every API module is described in ARCHITECTURE.md', () => {
  const architecture = read('../docs/technical/ARCHITECTURE.md');
  const modules = readdirSync(new URL('../apps/api/src/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert(modules.includes('items'));
  for (const name of modules) {
    assert(
      architecture.includes(`\`${name}/\``),
      `apps/api/src/${name}/ is not in ARCHITECTURE.md`,
    );
  }
});

test('the technical documents link to each other and the root README links to them', () => {
  const folder = new URL('../docs/technical/', import.meta.url);
  const documents = readdirSync(folder).filter((name) => name.endsWith('.md'));
  const summary = read('../docs/technical/README.md');
  for (const name of documents.filter((name) => name !== 'README.md')) {
    assert(summary.includes(`(${name})`), `docs/technical/README.md does not link ${name}`);
  }
  assert(read('../README.md').includes('docs/technical/README.md'));
  assert(read('../README.md').includes('CONTRIBUTING.md'));
});
