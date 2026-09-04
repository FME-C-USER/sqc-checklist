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
      req.onerror = () => reject(req.error || new Error('無法開啟本機資料庫（無痕視窗或瀏覽器設定可能封鎖了網站儲存空間）'));
    });
  }

  /**
   * 錯誤一定要留下可讀的原因。
   *
   * 原本只有 `t.onerror = () => reject(t.error)`：而 transaction.error 在 Safari 上
   * 常常是 null，於是「照片存不進待傳佇列」的提示只能寫「原因：未知」——
   * 2026-08-27 現場就是這樣，四家店 24 張照片存不進去，而我們查不出是儲存空間不足還是別的。
   * 請求層的錯誤（req.error）才帶得到 QuotaExceededError 這類具體原因，所以要自己接；
   * 兩層都拿不到時，至少給一句人看得懂的話，不要把 null 丟出去。
   */
  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const os = t.objectStore(store);
      const out = fn(os);
      let reqErr = null;
      if (out && out.__req) out.__req.onerror = () => { reqErr = out.__req.error; };
      const fail = (what) => reject(reqErr || t.error
        || new Error('IndexedDB ' + what + '（瀏覽器沒有提供原因，最常見是儲存空間不足）'));
      t.oncomplete = () => resolve(out && out.__req ? out.__req.result : out);
      t.onerror = () => fail('交易失敗');
      t.onabort = () => fail('交易被中止');
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

  /**
   * 診斷用：整個照片佇列的狀態，但**不讀出 blob 與 thumb**。
   *
   * 為什麼要用游標而不是 allPhotos()：那支是 getAll，會把每一張的 blob（約 1MB）
   * 與 thumb（整張 1920px 的 dataURL）全部讀進記憶體，幾十張就是好幾百 MB。
   *
   * 為什麼需要這支：每一次上傳失敗的原因其實都存進了 photo.error，
   * 但介面只顯示張數，所以那個字串一直死在裝置上 —— 2026-08-27 那次要靠猜。
   */
  function photoDiagnostics() {
    return open().then((db) => new Promise((resolve, reject) => {
      const out = [];
      const req = db.transaction('photoQueue', 'readonly').objectStore('photoQueue').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(out); return; }
        const p = c.value || {};
        out.push({
          id: p.id, name: p.name, status: p.status, recordId: p.recordId, month: p.month,
          where: (p.pathParts || []).slice(1).join('/'),
          tries: p.tries || 0, error: p.error || '',
          linkTries: p.linkTries || 0, netTries: p.netTries || 0, linkErr: p.linkErr || '',
          nextAt: p.nextAt || 0, linkNextAt: p.linkNextAt || 0,
          // blobSize 要能在 blob 被釋放後仍然看得到：完成的照片會把 blob 丟掉省空間，
          // 但診斷畫面若因此顯示「內容 0 KB」，會被誤讀成「照片內容不見了」。
          hasBlob: !!p.blob, blobSize: (p.blob && p.blob.size) || p.bytes || 0, fileId: p.fileId || '',
          reported: !!p.reported,
          // 「一直傳不上去、已停止密集重試」—— 診斷要標出來，否則跟「正在傳」長得一樣
          stalled: !!p.stalled,
        });
        c.continue();
      };
      req.onerror = () => reject(req.error || new Error('讀取佇列失敗'));
    }));
  }

  /**
   * 逐筆走訪照片佇列，每筆交給 fn 處理完才前進。傳 status 則只走該狀態的。
   *
   * 為什麼不是 allPhotos()：那支是 getAll，會把每一張的 blob 與 thumb 一次全部
   * 讀進記憶體 —— 而呼叫這支的目的正是要清掉那些東西，用 getAll 等於在
   * 「因為空間不夠而失敗」的裝置上先把記憶體吃爆一次。
   *
   * status 一定要傳：清理只關心 linked，但如果走訪全部，每一輪都會把 pending
   * 那些還帶著 ~900KB blob 的照片讀出來一次 —— 每 15 秒一次，正是我們要
   * 避免的記憶體壓力。用 byStatus 索引的 key 游標就只會碰到該狀態的鍵。
   *
   * 先用 key 游標收完鍵（只有鍵，不含內容），再逐筆 get；
   * 因為 IndexedDB 的交易在沒有待處理請求時就會自動結束，
   * 在游標中間 await 一個跨交易的寫入會讓游標失效。
   */
  function eachPhoto(fn, status) {
    return open().then((db) => new Promise((resolve, reject) => {
      const ids = [];
      const os = db.transaction('photoQueue', 'readonly').objectStore('photoQueue');
      const req = status === undefined
        ? os.openKeyCursor()
        : os.index('byStatus').openKeyCursor(IDBKeyRange.only(status));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(ids); return; }
        ids.push(c.primaryKey);
        c.continue();
      };
      req.onerror = () => reject(req.error || new Error('讀取佇列失敗'));
    })).then(async (ids) => {
      for (const id of ids) {
        try {
          const p = await get('photoQueue', id);
          if (p) await fn(p);
        } catch (e) { /* 單筆失敗不可中斷整輪：能清幾筆是幾筆 */ }
      }
    });
  }

  window.SqcDB = {
    // 照片佇列
    photoDiagnostics,
    eachPhoto,
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
