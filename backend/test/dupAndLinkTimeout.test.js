/**
 * 回歸測試：兩件在 2026-09-03 現場觀察到的事。
 *
 * 一、Drive 裡同一張照片有 8 份以上（時間戳每兩分鐘一個）
 *   retry 旗標原本只看 p.tries，而 tries 是寫進 IndexedDB 的 ——
 *   空間不足時寫不進去、永遠是 0 → retry 永遠 false → 後端每次都當成首次上傳、
 *   不查同檔名 → 又在 Drive 建一個新檔。
 *   同一個工作階段內有 _skip 跳過名單擋著（案例 1），重開 App 則靠主鍵裡的
 *   時間戳記認出「這張排很久了」（案例 1b）—— 那個訊號不需要任何寫入，
 *   所以空間滿的手機也拿得到，而且跨工作階段有效。
 *   曾經用記憶體集合補這個洞，那是無效的：記憶體隨工作階段一起消失。
 *
 * 二、「已上傳、等寫入連結」永遠不消失，但轉出的報表其實已經有連結
 *   attachPhotoLinks 要拿後端的腳本鎖（waitLock 20 秒），12 秒結構上不夠。
 *   後端寫進去了，回應卻沒在 12 秒內回到手機 → 手機當成失敗。
 *   而逾時屬於「非 countable」失敗，不計入 LINK_MAX_TRIES 的放棄門檻 ——
 *   於是每 5 分鐘重試一次、永遠不會結束：橫幅一直掛著，後端也一直白做。
 *   附帶副作用：診斷上出現「完成　已釋放」下面還跟著「回寫連結錯誤」。
 *
 * 執行方式：node backend/test/dupAndLinkTimeout.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const ROOT = path.join(__dirname, '..', '..');
const UP = fs.readFileSync(path.join(ROOT, 'js', 'uploader.js'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

/**
 * 載入 uploader.js，並模擬一個「會記得檔名」的 Drive。
 * writeFails：所有 updatePhoto 都失敗（＝現場那支空間已滿的手機）。
 */
function load(photos, opts) {
  const o = opts || {};
  const store = new Map(photos.map((p) => [p.id, { ...p }]));
  const drive = [];            // Drive 上實際存在的檔名（重複會多一筆）
  const sessionItems = [];     // 每次 createUploadSessions 收到的 items
  const puts = [];

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    AbortController,
    navigator: { onLine: true },
    Blob: class { constructor(parts) { this.parts = parts; this.size = 1; } },
    document: { addEventListener: () => {}, visibilityState: 'visible' },
    location: { origin: 'https://example.test' },
    window: null,
    addEventListener: () => {},
    fetch: async (url) => {
      const name = String(url).split('#')[1] || '';
      puts.push(name);
      drive.push(name);        // 每一次 PUT 都在 Drive 產生一個檔案
      return { ok: true, status: 200, json: async () => ({ id: 'F' + drive.length }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.SqcApi = {
    /** 模擬後端：retry 為真才查同檔名；查到就直接認領，不開新的上傳網址 */
    createUploadSessions: async (items) => {
      sessionItems.push(items.map((i) => ({ name: i.name, retry: i.retry })));
      return {
        sessions: items.map((it) => {
          if (it.retry) {
            const idx = drive.indexOf(it.name);
            if (idx >= 0) return { ok: true, existing: true, fileId: 'F' + (idx + 1) };
          }
          return { ok: true, url: 'https://up.test/x#' + it.name };
        }),
      };
    },
    attachPhotoLinks: async () => ({ ok: true }),
    sharePhotoLinks: async () => ({ ok: true }),
    recordExists: async () => ({ exists: false }),
    submitRecord: async () => ({ ok: true }),
    logEvent: async () => ({ ok: true }),
  };
  sandbox.SqcDB = {
    countPhotos: async (st) => Array.from(store.values()).filter((p) => st === undefined || p.status === st).length,
    pendingRecords: async () => [],
    queueRecord: async () => {}, delQueuedRecord: async () => {},
    addPhoto: async (p) => { store.set(p.id, { ...p }); },
    updatePhoto: async (p) => {
      if (o.writeFails) throw new Error('Error preparing Blob/File data to be stored in object store');
      store.set(p.id, { ...p });
    },
    delPhoto: async (id) => { store.delete(id); },
    getPhoto: async (id) => { const p = store.get(id); return p ? { ...p } : null; },
    allPhotos: async () => Array.from(store.values()),
    pendingPhotos: async () => Array.from(store.values()).filter((p) => p.status === 'pending'),
    photosOfRecord: async (rid) => Array.from(store.values()).filter((p) => p.recordId === rid),
    photoDiagnostics: async () => Array.from(store.values()).map((p) => ({
      id: p.id, name: p.name, status: p.status, tries: p.tries || 0,
      error: p.error || '', reported: !!p.reported, blobSize: 0,
    })),
    eachPhoto: async (fn, status) => {
      for (const id of Array.from(store.keys())) {
        const p = store.get(id);
        if (p && (status === undefined || p.status === status)) await fn({ ...p });
      }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(UP, sandbox, { filename: 'uploader.js' });
  return { uploader: sandbox.SqcUploader, store, drive, sessionItems, puts };
}

// 主鍵裡的時間戳記決定 retry 要不要查同檔名，所以一定要用「當下」——
// 寫成 'ph_1000' 是 1970 年，會被正確地判定為陳舊，測不到「首次上傳」那條。
const T0 = Date.now();
const photo = (n) => ({
  id: 'ph_' + (T0 + n) + '_a' + n, name: 'p' + n + '.jpg', status: 'pending',
  recordId: 'R1', month: '11509', pathParts: ['115年09月', '1.招牌'],
  blob: { size: 900000 }, tries: 0, where: '1.招牌',
});
const settle = () => new Promise((r) => setTimeout(r, 40));

(async () => {
  /**
   * ===== 1. ★ 狀態寫不回去時，不可以每一輪都在 Drive 建新檔 =====
   * 這是現場「同一張照片 8 份」的直接情境。
   */
  {
    const t = load([photo(0)], { writeFails: true });
    for (let i = 0; i < 4; i++) { await t.uploader.pump(); await settle(); }

    /**
     * 同一個工作階段內是安全的，但功勞不在 retry 旗標 ——
     * 是 _skip 跳過名單：狀態寫不回去的照片本輪之後就不再被取用，
     * 所以連第二次 sessionsFor 都不會發生（下面那條斷言可證）。
     */
    assertEqual(t.drive.length, 1, '同一個工作階段內 Drive 上只有 1 份');
    assertEqual(t.puts.length, 1, '同一個工作階段內只 PUT 一次');
    assertEqual(t.sessionItems.length, 1,
      '★ 寫入失敗的照片會進跳過名單，本階段不會再向後端索取第二次上傳網址');
    assertEqual(t.sessionItems.flat().map((i) => i.retry), [false],
      '第一次本來就不可能已存在，不查（省 0.2~0.4 秒）');
  }

  /**
   * ===== 1b. ★ 跨工作階段也不可以重複（2026-09-03 傍晚補上）=====
   * 重新載入 uploader＝使用者關掉 App 再開，跳過名單與任何記憶體狀態都清空，
   * 而 tries 因為寫不進 IndexedDB 仍是 0。這裡原本是「已知缺口」，
   * 份數 ≈ 開啟 App 的次數，就是現場同一張 8 份的真正機制。
   *
   * 補法不是在記憶體裡記「已試過」（那隨工作階段一起消失，補不到這個洞），
   * 而是讀主鍵裡的時間戳記：'ph_<ms>_<rand>' 的 ms 是 addPhoto 當下決定的，
   * 不需要任何寫入，而且跨工作階段永遠讀得到。
   */
  {
    // 這一張是 20 分鐘前排進佇列的（超過 STALE_MS 的 10 分鐘）
    const shared = [{ ...photo(0), id: 'ph_' + (T0 - 1200000) + '_old' }];
    const s1 = load(shared, { writeFails: true });
    await s1.uploader.pump(); await settle();
    // 第二個工作階段共用同一個 Drive（用第一階段留下的檔名清單）
    const s2 = load(shared, { writeFails: true });
    s2.drive.push(...s1.drive);
    await s2.uploader.pump(); await settle();

    assertEqual(s2.drive.length, 1,
      '★ 重開 App 後不可以再建一個新檔（實際 ' + s2.drive.length + '）—— 這是現場同一張 8 份的來源');
    assertEqual(s2.sessionItems.flat().map((i) => i.retry), [true],
      '★ 新工作階段要靠主鍵的時間戳記認出「這張排很久了」，不能依賴寫得進去才算的 tries');
  }

  // ===== 2. 一切正常時不可以多花那次查詢 =====
  {
    const t = load([photo(0)], {});
    await t.uploader.pump();
    await settle();
    assertEqual(t.sessionItems.flat().map((i) => i.retry), [false], '首次上傳不查同檔名');
    assertEqual(t.store.get('ph_' + T0 + '_a0').status, 'linked', '正常流程要跑完');
    assertEqual(t.drive.length, 1, 'Drive 上一份');
  }

  // ===== 3. ★ 轉成完成時要把失敗紀錄清掉 =====
  {
    const t = load([{ ...photo(0), error: '舊的上傳錯誤', linkErr: '舊的回寫錯誤', linkTries: 3, netTries: 5 }], {});
    await t.uploader.pump();
    await settle();
    const p = t.store.get('ph_' + T0 + '_a0');
    assertEqual(p.status, 'linked', '前提：已完成');
    assertEqual(p.error, '', '★ 完成後不可留著舊的上傳錯誤');
    assertEqual(p.linkErr, '', '★ 完成後不可留著舊的回寫錯誤');
    assertEqual(p.linkTries, 0, '次數也要歸零');
    assertEqual(p.netTries, 0, '次數也要歸零');
  }

  // ===== 4. 原始碼層面 =====
  assertEqual(/attachPhotoLinks: 45000,/.test(API), true,
    '★ attachPhotoLinks 要進 RETRY_LONGER —— 它要拿鎖，12 秒結構上不夠');
  assertEqual(/if \(status === 'linked'\) \{[\s\S]*?out\.linkErr = '';/.test(UP), true,
    '★ released() 轉 linked 時要清掉錯誤欄位');

  /**
   * ★ 顯示端也要擋。
   * 「在 released() 加上清除之前就已經完成」的照片不會再走一次 released()，
   * 舊訊息會永遠留在 IndexedDB 裡 —— 所以畫面必須自己過濾，
   * 否則會一直出現「完成 … 回寫連結錯誤：伺服器忙碌中」而讓人以為還有問題。
   */
  assertEqual(/\{p\.status !== 'linked' && p\.error && \(/.test(APP), true,
    '★ 已完成的不顯示上傳錯誤');
  assertEqual(/\{p\.status !== 'linked' && p\.linkErr && \(/.test(APP), true,
    '★ 已完成的不顯示回寫錯誤');
  assertEqual(/已重試 \{\(p\.linkTries \|\| 0\) \+ \(p\.netTries \|\| 0\)\} 次/.test(APP), true,
    '★ 次數要把兩個計數器加起來 —— 逾時累加的是 netTries，只印 linkTries 會顯示成「（0 次）」');
  assertEqual(/（\{p\.linkTries\} 次）/.test(APP), false, '不可再只印 linkTries');

  console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
  process.exit(failed ? 1 : 0);
})();
