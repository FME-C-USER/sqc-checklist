// ============================================================
// SQC 離線儲存 — IndexedDB
//   photoQueue：壓縮後待上傳照片（斷線暫存、恢復補傳）
//   drafts    ：點檢草稿（App 關閉/當掉可還原）
//   recordQueue：待送出/待同步的紀錄
// ============================================================
(function () {
  const DB_NAME = 'sqc-db';
  const VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('photoQueue')) {
          const s = db.createObjectStore('photoQueue', { keyPath: 'id' });
          s.createIndex('byStatus', 'status');
          s.createIndex('byRecord', 'recordId');
        }
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('recordQueue')) {
          const r = db.createObjectStore('recordQueue', { keyPath: 'id' });
          r.createIndex('byStatus', 'status');
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const os = t.objectStore(store);
      const out = fn(os);
      t.oncomplete = () => resolve(out && out.__req ? out.__req.result : out);
      t.onerror = () => reject(t.error);
    }));
  }

  const put = (store, val) => tx(store, 'readwrite', (os) => ({ __req: os.put(val) }));
  const del = (store, key) => tx(store, 'readwrite', (os) => ({ __req: os.delete(key) }));
  const get = (store, key) => tx(store, 'readonly', (os) => ({ __req: os.get(key) }));
  const all = (store) => tx(store, 'readonly', (os) => ({ __req: os.getAll() }));

  function allByIndex(store, index, value) {
    return open().then((db) => new Promise((resolve, reject) => {
      const os = db.transaction(store, 'readonly').objectStore(store);
      const req = os.index(index).getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  // 只數筆數、不讀出資料本體。照片的 blob 動輒 1MB，用 getAll 去數會把整個佇列
  // （可能數十MB）讀進記憶體，畫面每次更新都做一次會明顯卡頓。
  function countByIndex(store, index, value) {
    return open().then((db) => new Promise((resolve, reject) => {
      const os = db.transaction(store, 'readonly').objectStore(store);
      const req = value === undefined ? os.count() : os.index(index).count(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  window.SqcDB = {
    // 照片佇列
    addPhoto: (photo) => put('photoQueue', photo),
    updatePhoto: (photo) => put('photoQueue', photo),
    getPhoto: (id) => get('photoQueue', id),
    delPhoto: (id) => del('photoQueue', id),
    allPhotos: () => all('photoQueue'),
    pendingPhotos: () => allByIndex('photoQueue', 'byStatus', 'pending'),
    photosOfRecord: (recordId) => allByIndex('photoQueue', 'byRecord', recordId),
    countPhotos: (status) => countByIndex('photoQueue', 'byStatus', status),
    // 草稿
    saveDraft: (draft) => put('drafts', draft),
    getDraft: (id) => get('drafts', id),
    delDraft: (id) => del('drafts', id),
    // 紀錄佇列
    queueRecord: (rec) => put('recordQueue', rec),
    getQueuedRecord: (id) => get('recordQueue', id),
    delQueuedRecord: (id) => del('recordQueue', id),
    pendingRecords: () => allByIndex('recordQueue', 'byStatus', 'pending'),
  };
})();
