const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { assertPathAllowed } = require('../dist/security/path-policy.js');

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('assertPathAllowed denies relative traversal outside root', async () => {
  await withTempDir('agentwfy-path-policy-', async (rootDir) => {
    await assert.rejects(
      () => assertPathAllowed(rootDir, '../outside.txt', { allowMissing: true }),
      /Path traversal denied/
    );
  });
});

test('assertPathAllowed denies symlink escapes that leave root', async () => {
  await withTempDir('agentwfy-path-symlink-root-', async (rootDir) => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentwfy-path-symlink-outside-'));
    try {
      const nestedDir = path.join(rootDir, 'nested');
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.symlink(outsideDir, path.join(nestedDir, 'escape'), 'dir');

      await assert.rejects(
        () => assertPathAllowed(rootDir, 'nested/escape/secret.txt', { allowMissing: true }),
        /Path escape denied/
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test('all file-tool path profiles deny access to .agentwfy paths', async () => {
  await withTempDir('agentwfy-path-agent-', async (rootDir) => {
    const privateDir = path.join(rootDir, '.agentwfy');
    const privateFile = path.join(privateDir, 'secret.txt');
    await fs.mkdir(privateDir, { recursive: true });
    await fs.writeFile(privateFile, 'classified', 'utf-8');

    const profiles = [
      { tool: 'read', relativePath: '.agentwfy/secret.txt' },
      { tool: 'write', relativePath: '.agentwfy/new.txt', options: { allowMissing: true } },
      { tool: 'edit', relativePath: '.agentwfy/secret.txt' },
      { tool: 'ls', relativePath: '.agentwfy' },
      { tool: 'mkdir', relativePath: '.agentwfy/new-dir', options: { allowMissing: true } },
      { tool: 'remove', relativePath: '.agentwfy/secret.txt', options: { allowMissing: true } },
      { tool: 'find', relativePath: '.agentwfy', options: { allowMissing: true } },
      { tool: 'grep', relativePath: '.agentwfy', options: { allowMissing: true } },
    ];

    for (const profile of profiles) {
      await assert.rejects(
        () => assertPathAllowed(rootDir, profile.relativePath, profile.options),
        /Access denied for private path/,
        `${profile.tool} must deny .agentwfy paths`
      );
    }

    await assert.rejects(
      () => assertPathAllowed(rootDir, 'subdir/../.agentwfy/secret.txt', { allowMissing: true }),
      /Access denied for private path/
    );
  });
});
