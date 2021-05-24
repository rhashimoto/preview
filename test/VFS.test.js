import { getSQLite, getSQLiteAsync } from './api-instances.js';
import * as SQLite from '../src/sqlite-api.js';
import * as VFS from '../src/VFS.js';
import { MemoryAsyncVFS } from '../src/examples/MemoryAsyncVFS.js';
import { MemoryVFS } from '../src/examples/MemoryVFS.js';
import { IndexedDbVFS } from '../src/examples/IndexedDbVFS.js';

import GOOG from './GOOG.js';

/**
 * @param {SQLiteAPI} sqlite3 
 * @param {number} db 
 */
async function loadSampleTable(sqlite3, db) {
  await sqlite3.exec(db, `
    PRAGMA journal_mode = DELETE;
    CREATE TABLE goog (${GOOG.columns.join(',')});
    BEGIN TRANSACTION;
  `);
  for (const row of GOOG.rows) {
    const formattedRow = row.map(value => {
      if (typeof value === 'string') {
        return `'${value}'`;
      }
      return value;
    }).join(',');
    await sqlite3.exec(db, `
      INSERT INTO goog VALUES (${formattedRow})
    `);
  }
  await sqlite3.exec(db, `
    COMMIT;
  `);
}

function shared(ready) {
  const setup = {};

  /** @type {SQLiteAPI} */ let sqlite3, vfs;
  let db, sql;
  beforeEach(async function() {
    ({ sqlite3, vfs} = await ready);
    db = await sqlite3.open_v2('foo', 0x06, vfs.name);

    // Delete all tables.
    const tables = [];
    await sqlite3.exec(db, `
      SELECT name FROM sqlite_master WHERE type='table';
    `, row => {
      tables.push(row[0]);
    });
    for (const table of tables) {
      await sqlite3.exec(db, `DROP TABLE ${table}`);
    }

    sql = async function(strings, ...values) {
      let interleaved = [];
      strings.forEach((s, i) => {
        interleaved.push(s, values[i]);
      });

      const results = [];
      await sqlite3.exec(db, interleaved.join(''), (row, columns) => {
        results.push(row);
      });
      return results;
    }

    // Package test objects for non-shared tests.
    Object.assign(setup, { sqlite3, db, sql })
  });

  afterEach(async function() {
    await sqlite3.close(db);
  });

  it('prepare', async function() {
    const str = sqlite3.str_new(db);
    sqlite3.str_appendall(str, 'SELECT 1 + 1');
    const prepared = await sqlite3.prepare_v2(db, sqlite3.str_value(str));
    expect(typeof prepared.stmt).toBe('number');
    expect(sqlite3.column_name(prepared.stmt, 0)).toBe('1 + 1');
    expect(sqlite3.sql(prepared.stmt)).toBe('SELECT 1 + 1');
    await sqlite3.finalize(prepared.stmt);
    sqlite3.str_finish(str);
  });

  it('bind', async function() {
    await sqlite3.exec(db, `
      CREATE TABLE tbl (id, cBlob, cDouble, cInt, cNull, cText);
    `);

    const str = sqlite3.str_new(db);
    sqlite3.str_appendall(str, `
      INSERT INTO tbl VALUES (:Id, :cBlob, :cDouble, :cInt, :cNull, :cText);
    `);
    const prepared = await sqlite3.prepare_v2(db, sqlite3.str_value(str));

    let result;
    const cBlob = new Int8Array([8, 6, 7, 5, 3, 0, 9]);
    const cDouble = Math.PI;
    const cInt = 42;
    const cNull = null;
    const cText = 'foobar';

    result = sqlite3.bind_collection(prepared.stmt, [
      'array', cBlob, cDouble, cInt, cNull, cText
    ]);
    expect(result).toBe(SQLite.SQLITE_OK);
    result = await sqlite3.step(prepared.stmt);
    expect(result).toBe(SQLite.SQLITE_DONE);
    result = await sqlite3.reset(prepared.stmt);
    expect(result).toBe(SQLite.SQLITE_OK);

    result = sqlite3.bind_collection(prepared.stmt, {
      ':Id': 'object',
      ':cBlob': cBlob,
      ':cDouble': cDouble,
      ':cInt': cInt,
      ':cNull': cNull,
      ':cText': cText
    });
    expect(result).toBe(SQLite.SQLITE_OK);
    result = await sqlite3.step(prepared.stmt);
    expect(result).toBe(SQLite.SQLITE_DONE);
    result = await sqlite3.reset(prepared.stmt);
    expect(result).toBe(SQLite.SQLITE_OK);

    result = await sqlite3.finalize(prepared.stmt);
    expect(result).toBe(SQLite.SQLITE_OK);

    const results = [];
    await sqlite3.exec(
      db, `
        SELECT cBlob, cDouble, cInt, cNull, cText FROM tbl;
      `,
      function(rowData, columnNames) {
        rowData = rowData.map(value => {
          // Blob results do not remain valid so copy to retain.
          return value instanceof Int8Array ? Array.from(value) : value;
        });
        results.push(rowData);
      });

    const expected = [Array.from(cBlob), cDouble, cInt, cNull, cText];
    expect(results[0]).toEqual(expected);
    expect(results[1]).toEqual(expected);
  });

  it('exec', async function() {
    // Without callback.
    await sqlite3.exec(
      db, `
      CREATE TABLE tableA (x, y);
      INSERT INTO tableA VALUES (1, 2);
    `);

    // With callback.
    const rows = [];
    await sqlite3.exec(
      db, `
      CREATE TABLE tableB (a, b, c);
      INSERT INTO tableB VALUES ('foo', 'bar', 'baz');
      INSERT INTO tableB VALUES ('how', 'now', 'brown');
      SELECT * FROM tableA;
      SELECT * FROM tableB;
      `,
      function(row, columns) {
        switch (columns.length) {
          case 2:
            expect(columns).toEqual(['x', 'y']);
            break;
          case 3:
            expect(columns).toEqual(['a', 'b', 'c']);
            break;
          default:
            fail();
            break;
        }
        rows.push(row);
      });

      expect(rows).toEqual([
        [1, 2],
        ['foo', 'bar', 'baz'],
        ['how', 'now', 'brown']
      ]);
  });

  it('reset', async function() {
    await sqlite3.exec(
      db, `
      CREATE TABLE tbl (x);
      INSERT INTO tbl VALUES ('a'), ('b'), ('c');
    `);
    expect(sqlite3.changes(db)).toBe(3);

    const str = sqlite3.str_new(db, 'SELECT x FROM tbl ORDER BY x');
    const prepared = await sqlite3.prepare_v2(db, sqlite3.str_value(str));
    await sqlite3.step(prepared.stmt);
    expect(sqlite3.column(prepared.stmt, 0)).toBe('a');
    await sqlite3.step(prepared.stmt);
    expect(sqlite3.column(prepared.stmt, 0)).toBe('b');

    await sqlite3.reset(prepared.stmt);
    await sqlite3.step(prepared.stmt);
    expect(sqlite3.column(prepared.stmt, 0)).toBe('a');

    sqlite3.finalize(prepared.stmt);
    sqlite3.str_finish(str);
  });

  it('function', async function() {
    // Populate a table with each value type, one value per row.
    await sqlite3.exec(db, `CREATE TABLE tbl (value)`);
    const str = sqlite3.str_new(db, `
      INSERT INTO tbl VALUES (?), (?), (?), (?), (?);
    `);
    const prepared = await sqlite3.prepare_v2(db, sqlite3.str_value(str));

    let result;
    const vBlob = new Int8Array([8, 6, 7, 5, 3, 0, 9]);
    const vDouble = Math.PI;
    const vInt = 42;
    const vNull = null;
    const vText = 'foobar';
    result = sqlite3.bind_collection(prepared.stmt, [
      vBlob, vDouble, vInt, vNull, vText
    ]);
    expect(result).toBe(SQLite.SQLITE_OK);
    result = await sqlite3.step(prepared.stmt);
    expect(result).toBe(SQLite.SQLITE_DONE);
    result = await sqlite3.finalize(prepared.stmt);
    expect(result).toBe(SQLite.SQLITE_OK);

    // This function evaluates to its second argument.
    let appData = null;
    function f(context, values) {
      // Unlikely anyone will ever use this call but check it anyway.
      appData = sqlite3.user_data(context);

      const value = sqlite3.value(values[1]);
      sqlite3.result(context, value);
    }
    result = sqlite3.create_function(
      db, "MyFunc", 2, SQLite.SQLITE_UTF8, 0x1234, f, null, null);
    expect(result).toBe(SQLite.SQLITE_OK);

    // Apply the function to each row.
    const values = [];
    await sqlite3.exec(db, `SELECT MyFunc(0, value) FROM tbl`, row => {
      // Blob results do not remain valid so copy to retain.
      const value = row[0] instanceof Int8Array ? Array.from(row[0]) : row[0];
      values.push(value);
    });
    const expected = [Array.from(vBlob), vDouble, vInt, vNull, vText];
    expect(values).toEqual(expected);

    expect(appData).toBe(0x1234);
  });

  it('aggregate', async function() {
    // A real aggregate function would need to manage separate
    // invocations by keying off context but that is unnecessary
    // for this test.
    let sum = 0;
    function SumStep(context, values) {
      const value = sqlite3.value_int(values[0]);
      sum += value;
    }
    function SumFinal(context) {
      sqlite3.result(context, sum);
    }

    let result;
    result = sqlite3.create_function(
      db, "MySum", 1, SQLite.SQLITE_UTF8, 0x1234, null, SumStep, SumFinal);
    expect(result).toBe(SQLite.SQLITE_OK);

    await sqlite3.exec(db, `
      CREATE TABLE tbl (value);
      INSERT INTO tbl VALUES (1), (2), (3), (4);
      SELECT MySum(value) FROM tbl;
    `, row => {
      result = row[0];
    });
    expect(result).toBe(10);
  });

  it('persists', async function() {
    // Load data into the database.
    await loadSampleTable(sqlite3, db);
    const resultA = await sql`SELECT COUNT(*) FROM goog`;
    expect(resultA[0][0]).toBeGreaterThan(0);

    // Close and reopen the database.
    await sqlite3.close(db);
    db = await sqlite3.open_v2('foo', 0x06, vfs.name);

    const resultB = await sql`SELECT COUNT(*) FROM goog`;
    expect(resultB[0][0]).toBe(resultA[0][0]);
  });

  it('resize', async function() {
    // Load data into the database.
    await loadSampleTable(sqlite3, db);
    await sql`DELETE FROM goog WHERE Close > Open`;
    await sql`VACUUM`;

    const result = await sql`SELECT COUNT(*) FROM goog`;
    expect(result[0][0]).toBeGreaterThan(0);
  });

  return setup;
}

describe('MemoryVFS', function() {
  let resolveReady;
  let ready = new Promise(resolve => {
    resolveReady = resolve;
  });
  beforeAll(async function() {
    const sqlite3 = await getSQLite();
    const vfs = new MemoryVFS();
    sqlite3.vfs_register(vfs, false);
    resolveReady({ sqlite3 , vfs });
  });

  shared(ready);
});

describe('MemoryAsyncVFS', function() {
  let resolveReady;
  let ready = new Promise(resolve => {
    resolveReady = resolve;
  });
  beforeAll(async function() {
    const sqlite3 = await getSQLiteAsync();
    const vfs = new MemoryAsyncVFS();
    sqlite3.vfs_register(vfs, false);
    resolveReady({ sqlite3 , vfs });
  });

  shared(ready);
});

// Explore the IndexedDB filesystem without using SQLite.
class ExploreIndexedDbVFS extends IndexedDbVFS {
  handleAsync(f) {
    return f();
  }
}

// Convenience Promisification for IDBRequest.
function idb(request, listeners = {}) {
  listeners = Object.assign({
    'success': () => request.resolve(request.result),
    'error': () => request.reject('idb error')
  }, listeners);
  return new Promise(function(resolve, reject) {
    Object.assign(request, { resolve, reject });
    for (const type of Object.keys(listeners)) {
      request.addEventListener(type, listeners[type]);
    }
  });
}

describe('IndexedDbVFS', function() {
  let resolveReady;
  let ready = new Promise(resolve => {
    resolveReady = resolve;
  });
  beforeAll(async function() {
    /** @type {SQLiteAPI} */
    const sqlite3 = await getSQLiteAsync();
    const vfs = new IndexedDbVFS();
    sqlite3.vfs_register(vfs, false);
    resolveReady({ sqlite3 , vfs });
  });

  const setup = shared(ready);

  it('xTruncate reduces filesize', async function() {
    const sqlite3 = setup.sqlite3;
    const db = setup.db;
    const sql = setup.sql;

    const vfs = new ExploreIndexedDbVFS();
    const fileId = 0;
    await vfs.xOpen('foo', fileId, 0x6, { set() {} });

    // Load data into the database and record file size.
    const fileSizes = [];
    await loadSampleTable(sqlite3, db);
    await vfs.xLock(fileId, VFS.SQLITE_LOCK_SHARED);
    await vfs.xFileSize(fileId, { set(size) { fileSizes.push(size); } });
    await vfs.xUnlock(fileId, VFS.SQLITE_LOCK_NONE);

    // Shrink the database and record file size.
    await sql`DELETE FROM goog WHERE Close > Open`;
    await sql`VACUUM`;
    await vfs.xLock(fileId, 0x1);
    // SQLite doesn't always call xSync after xTruncate. The file size is
    // written to IDB on xUnlock but the extra blocks will remain until
    // whenever xSync is called. We call it here to delete the blocks
    // immediately.
    await vfs.xSync(fileId, VFS.SQLITE_LOCK_EXCLUSIVE);
    await vfs.xFileSize(fileId, { set(size) { fileSizes.push(size); } });
    await vfs.xUnlock(fileId, VFS.SQLITE_LOCK_NONE);

    vfs.xClose(fileId);
    expect(fileSizes[1]).toBeLessThan(fileSizes[0]);

    // Check that the number of IDB blocks is consistent.
    const nBlocks = Math.floor((fileSizes[1] + 8192 - 1) / 8192);
    const store = vfs.db.transaction('blocks').objectStore('blocks');
    const keyRange = IDBKeyRange.bound('foo#0', 'foo#~');
    const keys = await idb(store.getAllKeys(keyRange));
    expect(keys.length).toBe(nBlocks);
  });

  it('force unlock', async function() {
    const sql = setup.sql;

    // Start a transaction and leave it open.
    await sql`
      BEGIN TRANSACTION;
      CREATE TABLE tbl (x);
    `;

    // Attempting to lock the file from a second connection should fail.
    let status;
    const vfs = new ExploreIndexedDbVFS();
    const fileId = 0;
    status = await vfs.xOpen('foo', fileId, 0x6, { set() {} });
    expect(status).toBe(SQLite.SQLITE_OK);
    status = await vfs.xLock(fileId, VFS.SQLITE_LOCK_SHARED);
    expect(status).toBe(VFS.SQLITE_BUSY);

    // Forcibly clear the lock.
    vfs.forceClearLock('foo');

    // Now locking should work.
    status = await vfs.xLock(fileId, VFS.SQLITE_LOCK_SHARED);
    expect(status).toBe(VFS.SQLITE_OK);

    await vfs.xClose(fileId);
    await sql`ROLLBACK`;
  });

  it('delete file', async function() {
    const sqlite3 = setup.sqlite3;
    const db = setup.db;
    const sql = setup.sql;

    // Open a file and write some data.
    const vfs = new ExploreIndexedDbVFS();
    const fileId = 0;
    await vfs.xOpen('raw', fileId, 0x6, { set() {} });
    await vfs.xWrite(fileId, new Int8Array([1, 2, 3]), 0);

    // Check IDB.
    let store, keys;
    const keyRange = IDBKeyRange.bound('raw#', 'raw#~');

    store = vfs.db.transaction('blocks').objectStore('blocks');
    keys = await idb(store.getAllKeys(keyRange));
    expect(keys.length).toBeGreaterThan(0);

    // Delete the file.
    await vfs.deleteFile('raw');

    // Check IDB again.
    store = vfs.db.transaction('blocks').objectStore('blocks');
    keys = await idb(store.getAllKeys(keyRange));
    expect(keys.length).toBe(0);
  });
});
