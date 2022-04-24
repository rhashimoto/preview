// Copyright 2021 Roy T. Hashimoto. All Rights Reserved.
import * as VFS from '../VFS.js';
import { WebLocks } from './WebLocks.js';
import { IDBContext } from './IDBContext.js';

const BLOCK_SIZE = 4096;

/**
 * @typedef VFSOptions
 * @property {"default"|"strict"|"relaxed"} [durability]
 * @property {"deferred"|"manual"} [purge]
 * @property {number} [purgeAtLeast]
 */

/** @type {VFSOptions} */
const DEFAULT_OPTIONS = {
  durability: "default",
  purge: "deferred",
  purgeAtLeast: 16
};

function log(...args) {
  // console.debug(...args);
}

/**
 * @typedef FileBlock
 * @property {string} name
 * @property {number} index
 * @property {number} version
 * @property {Int8Array} data
 *
 * @property {number} [fileSize]
*/

/**
 * @typedef OpenedFileEntry
 * @property {string} path
 * @property {number} flags
 * @property {FileBlock} block0
 * 
 * Extra state for database files:
 * @property {number[]} [journalPages]
 * @property {Set<number>} [changedPages]
 * 
 * Extra state for journal files:
 * @property {number} [cachedPageIndex]
 * @property {Int8Array} [cachedPageEntry]
 */

// Use IndexedDB as a versioned block device. Each object in IndexedDB holds
// a fixed-size block of file data (block 0 for each file contains some
// extra metadata).
//
// There can be multiple versions of a file block. Newer versions have lower
// numbers (e.g. version -50 is newer than version -20), which makes it
// easier to get the latest version using IndexedDB. This versioning makes
// it possible to implement zero-store rollback journals because the
// pre-transaction data can be restored from the database file.
export class IndexedDbVFS extends VFS.Base {
  #options;
  /** @type {Map<number, OpenedFileEntry>} */ #mapIdToFile = new Map();
  /** @type {Map<string, OpenedFileEntry>} */ #mapPathToFile = new Map();

  /** @type {IDBContext} */ #idb;
  #webLocks = new WebLocks();
  /** @type {Set<string>} */ #pendingPurges = new Set();

  constructor(idbDatabaseName = 'wa-sqlite', options = DEFAULT_OPTIONS) {
    super();
    this.name = idbDatabaseName;
    this.#options = Object.assign({}, DEFAULT_OPTIONS, options);
    this.#idb = new IDBContext(openDatabase(idbDatabaseName), {
      durability: this.#options.durability
    });
  }

  xOpen(name, fileId, flags, pOutFlags) {
    return this.handleAsync(async () => {
      log(`xOpen ${name} ${fileId} 0x${flags.toString(16)}`);

      try {
        const url = new URL(name, 'http://localhost/');
        const file = {
          path: url.pathname,
          flags,
          block0: null
        };
        this.#mapIdToFile.set(fileId, file);
        this.#mapPathToFile.set(file.path, file);

        // Read the first block, which also contains the file metadata.
        file.block0 = await this.#idb.run('readonly', ({blocks}) => {
          return blocks.get(IDBKeyRange.bound(
            [file.path, 0],
            [file.path, 0, Infinity]))
        });
        if (!file.block0) {
          // File doesn't exist, create if requested.
          if (flags & VFS.SQLITE_OPEN_CREATE) {
            file.block0 = {
              name: file.path,
              index: 0,
              version: 0,
              data: new Int8Array(BLOCK_SIZE),

              fileSize: 0
            };

            // Write metadata block to IndexedDB.
            if (!this.#isJournal(file)) {
              this.#idb.run('readwrite', ({blocks}) => blocks.put(file.block0));
              this.purge(file.path);
              await this.#idb.sync();
            }
          } else {
            throw new Error(`file not found: ${file.path}`);
          }
        }

        pOutFlags.set(0);
        return VFS.SQLITE_OK;
      } catch (e) {
        console.error(e.message);
        return VFS.SQLITE_CANTOPEN;
      }
    });
  }

  xClose(fileId) {
    return this.handleAsync(async () => {
      const file = this.#mapIdToFile.get(fileId);
      if (file) {
        log(`xClose ${file.path}`);

        this.#mapIdToFile.delete(fileId);
        this.#mapPathToFile.delete(file.path);
        if (file.flags & VFS.SQLITE_OPEN_DELETEONCLOSE) {
          this.#idb.run('readwrite', ({blocks}) => {
            blocks.delete(IDBKeyRange.bound(
              [file.path],
              [file.path, []],
            ))
          });
        }
      }
      return VFS.SQLITE_OK;
    });
  }

  xRead(fileId, pData, iOffset) {
    return this.handleAsync(async () => {
      // Special handling for journal files.
      const file = this.#mapIdToFile.get(fileId);
      if (this.#isJournal(file)) {
        return this.#xReadJournal(file, pData, iOffset);
      }

      const blockSize = file.block0.data.byteLength;
      const blockIndex = (iOffset / blockSize) | 0;
      if (iOffset + pData.size > (blockIndex + 1) * blockSize) {
        // TODO: consider using #xReadGeneral for all cases.
        return this.#xReadGeneral(file, pData, iOffset);
      }
  
      log(`xRead ${file.path} ${pData.size} ${iOffset}`);

      // Check for read past the end of data.
      if (iOffset >= file.block0.fileSize) {
        pData.value.fill(0, pData.size);
        return VFS.SQLITE_IOERR_SHORT_READ;
      }

      // Fetch from IndexedDB.
      /** @type {FileBlock} */ let block = await this.#idb.run('readonly', ({blocks}) => {
        return blocks.get(IDBKeyRange.bound(
          [file.path, blockIndex, file.block0.version],
          [file.path, blockIndex, Infinity]));
      });

      // Block 0 contains file metadata so it is cached.
      if (blockIndex === 0) {
        if (file.block0.version > block.version) {
          // Incoming version is newer.
          file.block0 = block;
        } else {
          block = file.block0;
        }
      }

      const blockOffset = iOffset % blockSize;
      pData.value.set(block.data.subarray(blockOffset, blockOffset + pData.value.length));
      return VFS.SQLITE_OK
    });
  }

  /**
   * Handles unaligned reads that can cross block boundaries.
   * @param {OpenedFileEntry} file 
   * @param {*} pData 
   * @param {number} iOffset 
   * @returns {Promise<number>}
   */
  async #xReadGeneral(file, pData, iOffset) {
    log(`xRead (slow path) ${file.path} ${pData.size} ${iOffset}`);

    // Clip the requested read to the file boundary.
    const bgn = Math.min(iOffset, file.block0.fileSize);
    const end = Math.min(iOffset + pData.size, file.block0.fileSize);    

    let bytesRemaining = end - bgn;
    let bufferOffset = 0;
    let fileOffset = iOffset;
    const blockSize = file.block0.data.byteLength;
    while (bytesRemaining) {
      const blockIndex = Math.floor(fileOffset / blockSize);
      const blockOffset = fileOffset % blockSize;
      const blockBytes = Math.min(blockSize - blockOffset, bytesRemaining);

      // Fetch from IndexedDB.
      /** @type {FileBlock} */ let block = await this.#idb.run('readonly', ({blocks}) => {
          return blocks.get(IDBKeyRange.bound(
            [file.path, blockIndex, file.block0.version],
            [file.path, blockIndex, Infinity]
          ));
        }) ?? file.block0;

      // Block 0 contains file metadata so it is cached.
      if (blockIndex === 0) {
        if (file.block0.version > block.version) {
          // Incoming version is newer.
          file.block0 = block;
        } else {
          block = file.block0;
        }
      }

      pData.value.subarray(bufferOffset)
        .set(block.data.subarray(blockOffset, blockOffset + blockBytes));

      bufferOffset += blockBytes;
      fileOffset += blockBytes;
      bytesRemaining -= blockBytes;
    }

    if (bufferOffset !== pData.size) {
      // Zero unused area of read buffer.
      pData.value.subarray(bufferOffset).fill(0, pData.size - bufferOffset);
      return VFS.SQLITE_IOERR_SHORT_READ;
    }
    return VFS.SQLITE_OK;
  }
  
  /**
   * Reads rollback journal files. Journal data is not saved to IndexedDB
   * so it needs to be reconstituted from the previous version of the
   * database.
   * @param {OpenedFileEntry} file 
   * @param {*} pData 
   * @param {number} iOffset 
   * @returns 
   */
  async #xReadJournal(file, pData, iOffset) {
    log(`xRead (journal) ${file.path} ${pData.size} ${iOffset}`);

    const dbPath = this.#getJournalDatabasePath(file);
    const dbFile = this.#mapPathToFile.get(dbPath);
    const journalHeaderView = new DataView(file.block0.data.buffer);
    const sectorSize = journalHeaderView.getUint32(20);
    const entrySize = dbFile.block0.data.length + 8;
    if (iOffset >= sectorSize) {
      // This read is past the header so it is reading a rollback page
      // entry. The entry must be regenerated by reading the database file.
      // The entry is typically read with three calls to xRead so it is
      // cached.
      const entryIndex = ((iOffset - sectorSize) / entrySize) | 0;
      const pageIndex = dbFile.journalPages[entryIndex];
      if (file.cachedPageIndex !== pageIndex) {
        // Fetch file data. Note that the lower version bound is open,
        // so we don't read data from the current transaction.
        /** @type {FileBlock} */ const block = await this.#idb.run('readonly', ({blocks}) => {
          return blocks.get(IDBKeyRange.bound(
            [dbPath, pageIndex, dbFile.block0.version],
            [dbPath, pageIndex, Infinity],
            true, false));
        });

        // Build a rollback page entry, which contains the page index,
        // the page data, and the page checksum. In the journal the page
        // index is 1-based.
        // https://www.sqlite.org/fileformat.html#the_rollback_journal
        const nonce = journalHeaderView.getUint32(12);
        const pageSize = dbFile.block0.data.length;
        this.cachedPageIndex = pageIndex;
        this.cachedPageEntry = new Int8Array(entrySize);
        const cachedPageView = new DataView(this.cachedPageEntry.buffer);
        cachedPageView.setUint32(0, pageIndex + 1); // 1-based
        this.cachedPageEntry.set(block.data, 4);
        cachedPageView.setUint32(entrySize - 4, this.#checksum(block.data, nonce, pageSize));
      }
    
      // Transfer the requested portion of the page entry.
      const skip = (iOffset - sectorSize) % entrySize;
      pData.value.set(this.cachedPageEntry.subarray(skip, skip + pData.value.length));
    } else {
      // Read journal header.
      pData.value.set(file.block0.data.subarray(iOffset, iOffset + pData.size));
    }
    return VFS.SQLITE_OK;
  }

  xWrite(fileId, pData, iOffset) {
    // Special handling for journal files.
    const file = this.#mapIdToFile.get(fileId);
    if (this.#isJournal(file)) {
      return this.#xWriteJournal(file, pData, iOffset);
    }

    // Check if read-modify-write path is needed.
    const blockSize = file.block0.data.byteLength;
    const blockIndex = (iOffset / blockSize) | 0;
    if (iOffset !== blockIndex * blockSize ||
        (iOffset < file.block0.fileSize && pData.size !== blockSize)) {
      return this.#xWriteGeneral(file, pData, iOffset);
    }

    log(`xWrite ${file.path} ${pData.size} ${iOffset}`);

    // Extend the file when writing past the end.
    file.block0.fileSize = Math.max(file.block0.fileSize, iOffset + pData.size);

    // Copy data into a block.
    /** @type {FileBlock} */ const block = blockIndex === 0 ?
      file.block0 :
      {
        name: file.block0.name,
        index: blockIndex,
        version: file.block0.version,
        data: new Int8Array(file.block0.data.length)
      };
    block.data.set(pData.value);

    // Store the block to IndexedDB, except not block 0 yet. Block 0
    // contains the published file version so it isn't written until
    // the transaction is complete.
    if (blockIndex) {
      this.#idb.run('readwrite', ({blocks}) => {
        blocks.put(block);
      });
    }
    file.changedPages?.add(blockIndex);
    return VFS.SQLITE_OK;
  }

  /**
   * Handles unaligned, partial block, and multi-block writes.
   * @param {OpenedFileEntry} file 
   * @param {*} pData 
   * @param {number} iOffset 
   */
  #xWriteGeneral(file, pData, iOffset) {
    return this.handleAsync(async () => {
      log(`xWrite (slow path) ${file.path} ${pData.size} ${iOffset}`);

      let bufferOffset = 0;
      let fileOffset = iOffset;
      let bytesRemaining = pData.value.length;
      const blockSize = file.block0.data.byteLength;
      const lastBlockIndex = Math.floor(file.block0.fileSize / blockSize);
      while (bytesRemaining) {
        const blockIndex = Math.floor(fileOffset / blockSize);
        const blockOffset = fileOffset % blockSize;
        const blockBytes = Math.min(blockSize - blockOffset, bytesRemaining);

        // Read.
        /** @type {FileBlock} */ let block;
        if (blockIndex === 0) {
          // Block 0 is always cached.
          block = file.block0;
        } else if (blockIndex <= lastBlockIndex && blockBytes < blockSize) {
          // Fetch from IndexedDB.
          block = await this.#idb.run('readonly', ({blocks}) => {
            return blocks.get(IDBKeyRange.bound(
              [file.path, blockIndex],
              [file.path, blockIndex, Infinity]
            ));
          });
        } else {
          // Any existing data is overwritten so no read is necessary.
          block = {
            name: file.block0.name,
            index: blockIndex,
            version: file.block0.version,
            data: new Int8Array(file.block0.data.length)
          };
        }

        // Modify.
        block.data.set(
          pData.value.subarray(bufferOffset, bufferOffset + blockBytes),
          blockOffset);
        
        // Write (except block 0).
        if (blockIndex) {
          this.#idb.run('readwrite', ({blocks}) => {
            blocks.put(block);
          });
        }
        file.changedPages?.add(blockIndex);

        bufferOffset += blockBytes;
        fileOffset += blockBytes;
        bytesRemaining -= blockBytes;
      }
      
      file.block0.fileSize = Math.max(file.block0.fileSize, iOffset + pData.size);
      return VFS.SQLITE_OK;
    });
  }

  /**
   * Writes rollback journal files.
   * @param {OpenedFileEntry} file 
   * @param {*} pData 
   * @param {number} iOffset 
   */
  #xWriteJournal(file, pData, iOffset) {
    log(`xWrite (journal) ${file.path} ${pData.size} ${iOffset}`);

    // Get the associated opened database file.
    const dbPath = this.#getJournalDatabasePath(file);
    const dbFile = this.#mapPathToFile.get(dbPath);

    if (iOffset === 0) {
      // Writing the journal header. This is the only journal data saved.
      console.assert(pData.value.length <= file.block0.data.length, 'unexpected write');
      file.block0.data.set(pData.value.subarray(0, file.block0.data.length));

      if (file.block0.data[0]) {
        // This begins a new journalled transaction.
        dbFile.journalPages = [];
        dbFile.changedPages = new Set();
        file.cachedPageIndex = -1;
        file.cachedPageEntry = null;

        // Decrement the database block0 version (lower number is newer).
        // Subsequent writes to the database will have this version.
        dbFile.block0.version--;
      }
    } else {
      // Extract and store page indices.
      // See https://www.sqlite.org/fileformat.html#the_rollback_journal
      const view = new DataView(file.block0.data.buffer);
      const sectorSize = view.getUint32(20);
      const entrySize = dbFile.block0.data.length + 8;
      if ((iOffset - sectorSize) % entrySize === 0) {
        // Store the page index for this page entry. The data is discarded.
        // The page index in the journal data is 1-based.
        const entryIndex = (iOffset - sectorSize) / entrySize;
        const pageIndex =
          new DataView(pData.value.buffer, pData.value.byteOffset).getUint32(0) - 1;
        dbFile.journalPages[entryIndex] = pageIndex;
      }
    }

    file.block0.fileSize = Math.max(file.block0.fileSize, iOffset + pData.size);
    return VFS.SQLITE_OK;
  }

  xTruncate(fileId, iSize) {
    const file = this.#mapIdToFile.get(fileId);
    log(`xTruncate ${file.path} ${iSize}`);

    file.block0.fileSize = iSize;

    // Update metadata and delete all blocks beyond the file size. SQLite
    // calls this on a database file outside of any journal lifetime so it
    // shouldn't remove blocks that the journal might need.
    const block0 = Object.assign({}, file.block0);
    const lastBlockIndex = Math.floor(file.block0.fileSize / file.block0.data.length);
    this.#idb.run('readwrite', ({blocks})=> {
      blocks.put(block0);
      blocks.delete(IDBKeyRange.bound(
        [file.path, lastBlockIndex, Infinity],
        [file.path, Infinity, Infinity]));
    });
    return VFS.SQLITE_OK;
  }

  xSync(fileId, flags) {
    return this.handleAsync(async () => {
      const file = this.#mapIdToFile.get(fileId);
      log(`xSync ${file.path} ${flags}`);

      // Write block 0. For database files (the only files where version
      // changes) this makes all the changes at the new version publicly
      // visible.
      if (!this.#isJournal(file)) {
        this.#idb.run('readwrite', async ({blocks})=> {
          blocks.put(file.block0);

          // Update purge state if necessary.
          const changedPages = file.changedPages;
          if (changedPages) {
            // Blocks to purge are saved in a special IndexedDB object with
            // an "index" of "purge".
            const purgeBlock = await blocks.get([file.path, 'purge', 0]) ?? {
              name: file.path,
              index: 'purge',
              version: 0,
              data: new Map()
            };

            // journalPages are pre-existing pages that *may* have been
            // overwritten. changedPages are written pages. The intersection
            // of these collections need to be purged.
            for (const pageIndex of file.journalPages) {
              if (changedPages.has(pageIndex)) {
                purgeBlock.data.set(pageIndex, file.block0.version);
              }
            }
            blocks.put(purgeBlock);
            this.#maybePurge(file.path, purgeBlock.data.size);
          }
        });

        if (this.#options.durability !== 'relaxed') {
          await this.#idb.sync();
        }
      }
      return VFS.SQLITE_OK;
    });
  }

  xFileSize(fileId, pSize64) {
    const file = this.#mapIdToFile.get(fileId);
    log(`xFileSize ${file.path}`);

    pSize64.set(file.block0.fileSize)
    return VFS.SQLITE_OK;
  }

  xLock(fileId, flags) {
    return this.handleAsync(async () => {
      const file = this.#mapIdToFile.get(fileId);
      log(`xLock ${file.path} ${flags}`);

      // Acquire the lock.
      const result = this.#webLocks.lock(file.path, flags);
      if (flags === VFS.SQLITE_LOCK_RESERVED) {
        // Clear blocks from abandoned transactions, i.e. blocks with
        // lower (newer) versions than block 0. This is done on reserved
        // locking which is after changes by other connections can be made,
        // and before a journal file is initialized.
        this.#idb.run('readwrite', async ({blocks}) => {
          const dbPath = this.#getJournalDatabasePath(file);
          const dbFile = this.#mapPathToFile.get(dbPath);
          const keys = await blocks.index('version').getAllKeys(IDBKeyRange.bound(
            [dbPath],
            [dbPath, dbFile.block0.version],
            false, true));
          for (const key of keys) {
            blocks.delete(key);
          }
        });
      }

      return result;
    });
  }

  xUnlock(fileId, flags) {
    return this.handleAsync(async () => {
      const file = this.#mapIdToFile.get(fileId);
      log(`xUnlock ${file.path} ${flags}`);
      
      return this.#webLocks.unlock(file.path, flags);
    });
  }

  xSectorSize(fileId) {
    log('xSectorSize', BLOCK_SIZE);
    return BLOCK_SIZE;
  }

  xDeviceCharacteristics(fileId) {
    log('xDeviceCharacteristics');
    return VFS.SQLITE_IOCAP_SAFE_APPEND |
           VFS.SQLITE_IOCAP_SEQUENTIAL |
           VFS.SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN;
  }

  xAccess(name, flags, pResOut) {
    return this.handleAsync(async () => {
      const path = new URL(name, 'file://localhost/').pathname;
      log(`xAccess ${path} ${flags}`);

      // Check if block 0 exists.
      const key = await this.#idb.run('readonly', ({blocks}) => {
        return blocks.getKey(IDBKeyRange.bound(
          [path, 0],
          [path, 0, Infinity]));
      });
      pResOut.set(key ? 1 : 0);
      return VFS.SQLITE_OK;
    });
  }

  xDelete(name, syncDir) {
    return this.handleAsync(async () => {
      const path = new URL(name, 'file://localhost/').pathname;
      log(`xDelete ${path} ${syncDir}`);

      const complete = this.#idb.run('readwrite', ({blocks}) => {
        return blocks.delete(IDBKeyRange.bound(
          [path],
          [path, []]));
      });
      if (syncDir) {
        await complete;
      }
      return VFS.SQLITE_OK;
    });
  }

  /**
   * Purge obsolete blocks from a database file.
   * @param {string} name 
   */
  purge(name) {
    const start = Date.now();
    const path = new URL(name, 'file://localhost/').pathname;
    this.#idb.run('readwrite', async ({blocks}) => {
      const purgeBlock = await blocks.get([path, 'purge', 0]);
      if (purgeBlock) {
        for (const [pageIndex, version] of purgeBlock.data) {
          blocks.delete(IDBKeyRange.bound(
            [path, pageIndex, version],
            [path, pageIndex, Infinity],
            true, false));
        }
        await blocks.delete([path, 'purge', 0]);
      }
      log(`purge ${name} ${purgeBlock?.data.size ?? 0} pages in ${Date.now() - start} ms`);
    });
    }

  /**
   * Conditionally schedule a purge task.
   * @param {string} name 
   * @param {number} nPages 
   */
  #maybePurge(name, nPages) {
    if (this.#options.purge === 'manual' ||
        this.#pendingPurges.has(name) ||
        nPages < this.#options.purgeAtLeast) {
      // No purge needed.
      return;
    }
    
    if (globalThis.requestIdleCallback) {
      globalThis.requestIdleCallback(() => {
        this.purge(name);
        this.#pendingPurges.delete(name)
      });
    } else {
      setTimeout(() => {
        this.purge(name);
        this.#pendingPurges.delete(name)
      });
    }
    this.#pendingPurges.add(name);
  }

  /**
   * @param {OpenedFileEntry} file 
   */
  #isJournal(file) {
    return file.flags & (VFS.SQLITE_OPEN_MAIN_JOURNAL | VFS.SQLITE_OPEN_TEMP_JOURNAL)
  }

  /**
   * @param {OpenedFileEntry} file 
   */
  #getJournalDatabasePath(file) {
    return file.path.replace(/-journal$/, '');
  }

  /**
   * @param {Int8Array} data 
   * @param {number} nonce 
   * @param {number} pageSize 
   * @returns {number}
   */
  #checksum(data, nonce, pageSize) {
    let result = nonce;
    let x = pageSize - 200;
    while (x > 0) {
      const value = data[x];
      result += value >= 0 ? value : value + 256;
      x -= 200;
    }
    return result;
  }
}

function openDatabase(idbDatabaseName) {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(idbDatabaseName, 5);
    request.addEventListener('upgradeneeded', async (event) => {
      const { oldVersion, newVersion } = event;
      console.log(`Upgrading "${idbDatabaseName}" ${oldVersion} -> ${newVersion}`);

      // Upgrade one previous version.
      /** @type {IDBDatabase} */ const db = request.result;
      /** @type {IDBTransaction} */ const tx = request.transaction;
      switch (oldVersion) {
        case 0:
          db.createObjectStore('database');
          db.createObjectStore('spill');
          db.createObjectStore('journal');
        case 4:
          const blocks = db.createObjectStore('blocks', {
            keyPath: ['name', 'index', 'version']
          })
          blocks.createIndex('version', ['name', 'version']);
          await new Promise(complete => {
            const database = tx.objectStore('database');
            const cursorRequest = database.openCursor();
            cursorRequest.addEventListener('success', async (event) => {
              /** @type {IDBCursorWithValue} */ const cursor = cursorRequest.result;
              if (cursor) {
                const block = cursor.value;
                block.name = `/${block.name}`;
                block.version = 0;
                block.data = new Int8Array(block.data);
                blocks.put(cursor.value);
                cursor.continue();
              } else {
                complete();
              }
            });
          });            
          db.deleteObjectStore('database');
          db.deleteObjectStore('spill');
          db.deleteObjectStore('journal');
          break;
        default:
          const error = new Error(`incompatible IDB database '${idbDatabaseName}' exists`);
          reject(error);
          throw error;
      }
    });
    request.addEventListener('success', () => {
      resolve(request.result);
    });
    request.addEventListener('error', () => {
      reject(request.error);
    });
  });
}
