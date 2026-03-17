#!/usr/bin/env node

/**
 * Builds the plugin package → dist/<name>.plugins.awfy
 *
 * Usage: node build.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

const root = import.meta.dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const pluginName = pkg.name.replace('agentwfy-plugin-', '');

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const outPath = path.join(dist, `${pluginName}.plugins.awfy`);
try { fs.unlinkSync(outPath); } catch {}

const db = new DatabaseSync(outPath);

db.exec(`
  CREATE TABLE plugins (name TEXT NOT NULL, description TEXT NOT NULL, version TEXT NOT NULL, code TEXT NOT NULL);
  CREATE TABLE docs (name TEXT NOT NULL, content TEXT NOT NULL);
`);

const code = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf-8');

db.prepare('INSERT INTO plugins VALUES (?, ?, ?, ?)').run(
  pluginName, pkg.description, pkg.version, code
);

// Read and insert all docs
const docsDir = path.join(root, 'docs');
for (const file of fs.readdirSync(docsDir).filter(f => f.endsWith('.md'))) {
  const name = file.replace(/\.md$/, '');
  const content = fs.readFileSync(path.join(docsDir, file), 'utf-8');
  db.prepare('INSERT INTO docs VALUES (?, ?)').run(name, content);
}

db.close();
console.log(`Built: ${outPath}`);
