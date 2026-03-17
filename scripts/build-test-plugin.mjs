#!/usr/bin/env node

/**
 * Creates a test plugin package at dist/echo-plugin.sqlite
 *
 * Usage: node scripts/build-test-plugin.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');
fs.mkdirSync(dist, { recursive: true });

const outPath = path.join(dist, 'echo-plugin.sqlite');

// Remove if exists
try { fs.unlinkSync(outPath); } catch {}

const db = new DatabaseSync(outPath);

db.exec(`
  CREATE TABLE plugins (
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    version TEXT NOT NULL,
    code TEXT NOT NULL
  );

  CREATE TABLE docs (
    name TEXT NOT NULL,
    content TEXT NOT NULL
  );
`);

const pluginCode = `
module.exports = {
  activate(api) {
    api.registerFunction('echoTest', async (params) => {
      return { echoed: params, timestamp: Date.now() }
    })

    api.registerFunction('echoRepeat', async (params) => {
      const text = params?.text ?? ''
      const count = params?.count ?? 3
      return { repeated: Array(count).fill(text).join(' ') }
    })
  }
}
`;

const docContent = `# plugin.echo

Echo test plugin. Provides two functions for verifying plugin connectivity.

## echoTest(params)

Returns the input back with a timestamp.

\`\`\`js
const result = await echoTest({ message: 'hello' })
// → { echoed: { message: 'hello' }, timestamp: 1710000000000 }
\`\`\`

## echoRepeat(params)

Repeats a text string.

- \`params.text\` — string to repeat
- \`params.count\` — number of repetitions (default 3)

\`\`\`js
const result = await echoRepeat({ text: 'hi', count: 2 })
// → { repeated: 'hi hi' }
\`\`\`
`;

db.prepare('INSERT INTO plugins VALUES (?, ?, ?, ?)').run(
  'echo',
  'Echo test plugin for verifying plugin connectivity',
  '1.0.0',
  pluginCode
);

db.prepare('INSERT INTO docs VALUES (?, ?)').run(
  'plugin.echo',
  docContent
);

db.close();

console.log(`Built test plugin: ${outPath}`);
