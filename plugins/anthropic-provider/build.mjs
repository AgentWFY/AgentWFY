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
  CREATE TABLE views (name TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL);
  CREATE TABLE config (name TEXT NOT NULL, value TEXT, description TEXT NOT NULL DEFAULT '');
`);

const code = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf-8');

db.prepare('INSERT INTO plugins VALUES (?, ?, ?, ?)').run(
  pluginName, pkg.description, pkg.version, code
);

// Read and insert all docs
const docsDir = path.join(root, 'docs');
if (fs.existsSync(docsDir)) {
  for (const file of fs.readdirSync(docsDir).filter(f => f.endsWith('.md'))) {
    const name = `plugin.${pluginName}.${file.replace(/\.md$/, '')}`;
    const content = fs.readFileSync(path.join(docsDir, file), 'utf-8');
    db.prepare('INSERT INTO docs VALUES (?, ?)').run(name, content);
  }
}

// Read and insert all views
const viewsDir = path.join(root, 'views');
if (fs.existsSync(viewsDir)) {
  for (const file of fs.readdirSync(viewsDir).filter(f => f.endsWith('.html'))) {
    const viewName = `plugin.${pluginName}.${file.replace(/\.html$/, '')}`;
    const content = fs.readFileSync(path.join(viewsDir, file), 'utf-8');
    const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : viewName;
    db.prepare('INSERT INTO views VALUES (?, ?, ?)').run(viewName, title, content);
  }
}

// Read and insert config
const configDir = path.join(root, 'config');
if (fs.existsSync(configDir)) {
  const configFile = path.join(configDir, 'config.json');
  if (fs.existsSync(configFile)) {
    const entries = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    for (const entry of entries) {
      db.prepare('INSERT INTO config VALUES (?, ?, ?)').run(
        entry.name, entry.value ?? null, entry.description || ''
      );
    }
  }
}

db.close();
console.log(`Built: ${outPath}`);
