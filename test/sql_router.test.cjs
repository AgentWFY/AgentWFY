const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parseRunSqlRequest, routeSqlRequest } = require('../dist/services/sql-router.js');

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('parseRunSqlRequest validates runSql payload shape', () => {
  assert.throws(() => parseRunSqlRequest(null), /expected an object/);
  assert.throws(() => parseRunSqlRequest({ target: 'invalid', sql: 'SELECT 1' }), /target must be "agent" or "sqlite-file"/);
  assert.throws(() => parseRunSqlRequest({ target: 'agent', sql: '' }), /sql must be a non-empty string/);
  assert.throws(() => parseRunSqlRequest({ target: 'sqlite-file', sql: 'SELECT 1', path: 5 }), /path must be a string/);
  assert.throws(() => parseRunSqlRequest({ target: 'agent', sql: 'SELECT 1', confirmed: 'yes' }), /confirmed must be a boolean/);
});

test('agent target blocks writes until confirmed and allows writes when confirmed', async () => {
  await withTempDir('tradinglog-sql-agent-', async (dataDir) => {
    await assert.rejects(
      () => routeSqlRequest(dataDir, {
        target: 'agent',
        sql: 'INSERT INTO views (name, content) VALUES (?, ?)',
        params: ['Main', '<div>Main</div>'],
      }),
      /ReadOnlyViolation: INSERT statements are not permitted/
    );

    await routeSqlRequest(dataDir, {
      target: 'agent',
      sql: 'INSERT INTO views (name, content) VALUES (?, ?)',
      params: ['Main', '<div>Main</div>'],
      confirmed: true,
    });

    const rows = await routeSqlRequest(dataDir, {
      target: 'agent',
      sql: 'SELECT name FROM views WHERE name = ?',
      params: ['Main'],
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Main');
  });
});

test('sqlite-file target blocks writes until confirmed and preserves routing by path', async () => {
  await withTempDir('tradinglog-sql-file-', async (dataDir) => {
    const sqlitePath = 'journal.sqlite';

    await routeSqlRequest(dataDir, {
      target: 'sqlite-file',
      path: sqlitePath,
      sql: 'CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL)',
      confirmed: true,
    });

    await assert.rejects(
      () => routeSqlRequest(dataDir, {
        target: 'sqlite-file',
        path: sqlitePath,
        sql: 'INSERT INTO trades (symbol) VALUES (?)',
        params: ['AAPL'],
      }),
      /ReadOnlyViolation: INSERT statements are not permitted/
    );

    await routeSqlRequest(dataDir, {
      target: 'sqlite-file',
      path: sqlitePath,
      sql: 'INSERT INTO trades (symbol) VALUES (?)',
      params: ['AAPL'],
      confirmed: true,
    });

    const rows = await routeSqlRequest(dataDir, {
      target: 'sqlite-file',
      path: sqlitePath,
      sql: 'SELECT symbol FROM trades ORDER BY id ASC',
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].symbol, 'AAPL');
  });
});

test('sqlite-file target denies .agent paths', async () => {
  await withTempDir('tradinglog-sql-private-', async (dataDir) => {
    await fs.mkdir(path.join(dataDir, '.agent'), { recursive: true });

    await assert.rejects(
      () => routeSqlRequest(dataDir, {
        target: 'sqlite-file',
        path: '.agent/private.sqlite',
        sql: 'SELECT 1',
      }),
      /Access denied for private path/
    );
  });
});
