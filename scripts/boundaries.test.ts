import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkAll, checkFile, importsOf } from './boundaries.ts';

const root = join(import.meta.dirname, '..');
const src = (pkg: string, name = 'x.ts') => join(root, 'packages', pkg, 'src', name);

test('Importe: Arten und «nur Typen»', () => {
  const refs = importsOf('a.ts', [
    "import type { A } from '@vollholz/workflow';",
    "import { type B, type C } from 'm1';",
    "import { D, type E } from 'm2';",
    "export * from './x.ts';",
    "export type { F } from 'm3';",
    "const m = await import('m4');",
    "type G = import('m5').G;",
  ].join('\n'));
  assert.deepEqual(refs.map(r => [r.spec, r.typeOnly]), [
    ['@vollholz/workflow', true], ['m1', true], ['m2', false], ['./x.ts', false], ['m3', true], ['m4', false], ['m5', true],
  ]);
});

test('workflow: kein @vollholz/*, nur erlaubte Abhängigkeiten', () => {
  assert.deepEqual(checkFile('workflow', 'src', src('workflow'), "import { x } from './ports.ts';\nimport type { F } from 'fastify';\nimport { Ajv } from 'ajv';\nimport { join } from 'node:path';"), []);
  assert.match(checkFile('workflow', 'src', src('workflow'), "import { a } from '@vollholz/some-app';")[0]!.message, /kein Paket @vollholz/);
  assert.match(checkFile('workflow', 'src', src('workflow'), "import pg from 'pg';")[0]!.message, /nicht erlaubte Abhängigkeit/);
  assert.match(checkFile('workflow', 'src', src('workflow'), "import x from '../../workflow-web/src/index.ts';")[0]!.message, /hinaus/);
});

test('workflow-web: Backend nur als Typ', () => {
  assert.deepEqual(checkFile('workflow-web', 'src', src('workflow-web', 'x.tsx'), "import type { ActorRef } from '@vollholz/workflow';\nimport { useMemo } from 'react';"), []);
  assert.match(checkFile('workflow-web', 'src', src('workflow-web', 'x.tsx'), "import { workflow } from '@vollholz/workflow';")[0]!.message, /nur Typen erlaubt/);
  assert.match(checkFile('workflow-web', 'src', src('workflow-web', 'x.tsx'), "import x from '../../workflow/src/index.ts';")[0]!.message, /hinaus/);
});

test('Begriffe einer App im Code des Pakets', () => {
  const found = checkFile('workflow', 'src', src('workflow'), '// lädt das Objekt\nconst x = 1; // Credentials\n');
  assert.deepEqual(found.map(f => f.line), [1, 2]);
  assert.deepEqual(checkFile('workflow', 'test', join(root, 'packages/workflow/test/a.test.ts'), '// Objekt im Test ist erlaubt\n'), []);
});

test('Tests: kein App-Paket', () => {
  assert.match(checkFile('workflow', 'test', join(root, 'packages/workflow/test/a.test.ts'), "import x from '@vollholz/other';")[0]!.message, /kein Paket einer App/);
});

test('Repository ist sauber', () => {
  assert.deepEqual(checkAll(), []);
});
