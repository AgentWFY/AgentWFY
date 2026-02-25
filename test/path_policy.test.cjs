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
  await withTempDir('tradinglog-path-policy-', async (rootDir) => {
    await assert.rejects(
      () => assertPathAllowed(rootDir, '../outside.txt', { allowMissing: true }),
      /Path traversal denied/
    );
  });
});

test('assertPathAllowed denies symlink escapes that leave root', async () => {
  await withTempDir('tradinglog-path-symlink-root-', async (rootDir) => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tradinglog-path-symlink-outside-'));
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

test('all file-tool path profiles deny access to .agent paths', async () => {
  await withTempDir('tradinglog-path-agent-', async (rootDir) => {
    const privateDir = path.join(rootDir, '.agent');
    const privateFile = path.join(privateDir, 'secret.txt');
    await fs.mkdir(privateDir, { recursive: true });
    await fs.writeFile(privateFile, 'classified', 'utf-8');

    const profiles = [
      { tool: 'read', relativePath: '.agent/secret.txt' },
      { tool: 'write', relativePath: '.agent/new.txt', options: { allowMissing: true } },
      { tool: 'edit', relativePath: '.agent/secret.txt' },
      { tool: 'ls', relativePath: '.agent' },
      { tool: 'mkdir', relativePath: '.agent/new-dir', options: { allowMissing: true } },
      { tool: 'remove', relativePath: '.agent/secret.txt', options: { allowMissing: true } },
      { tool: 'find', relativePath: '.agent', options: { allowMissing: true } },
      { tool: 'grep', relativePath: '.agent', options: { allowMissing: true } },
    ];

    for (const profile of profiles) {
      await assert.rejects(
        () => assertPathAllowed(rootDir, profile.relativePath, profile.options),
        /Access denied for private path/,
        `${profile.tool} must deny .agent paths`
      );
    }

    await assert.rejects(
      () => assertPathAllowed(rootDir, 'subdir/../.agent/secret.txt', { allowMissing: true }),
      /Access denied for private path/
    );
  });
});
