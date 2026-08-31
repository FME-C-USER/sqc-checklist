/**
 * 回歸測試：照片佇列必須「只進也要出」。
 *
 * 2026-08-31 邱秀枝在同一支手機、同一個時段：Chrome 一直傳不上去、Safari 很順利。
 * 診斷畫面顯示 `Error preparing Blob/File data to be stored in object store`，
 * 而清單裡的錯誤全是 8/27 的化石 —— 因為佇列寫不進去，狀態永遠停在那一刻，
 * 今天一張都沒真的重試過。
 *
 * 根因不是「Chrome 不會存 Blob」，是配額被吃光：
 *   1. delPhoto 寫好了卻從來沒有任何地方呼叫 —— 佇列只進不出，
 *      每一張拍過的照片都永遠留著。
 *   2. 每筆同時存 blob（600~950KB）與 thumb ——
 *      而 thumb 竟然是「整張 1920px 的 JPEG 再轉 base64」，比 blob 還大，
 *      卻只被拿去畫一個 64×64 的方框。
 * 一支手機測幾天就是數百 MB；iOS 上第三方瀏覽器（WKWebView）的配額遠小於
 * Safari 本體，所以 Chrome 先撞牆。
 *
 * 執行方式：node backend/test/queueRelease.test.js
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
const DB = fs.readFileSync(path.join(ROOT, 'js', 'db.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

/**
 * 載入 uploader.js，注入假的 SqcDB。
 * opts.eachIgnoresStatus：讓假的 eachPhoto 不管 status 一律吐出來，
 * 用來模擬「索引壞了／實作被換掉」，驗證 uploader 自己那道保險擋不擋得住。
 */
function load(photos, opts) {
  const ignoreStatus = !!(opts && opts.eachIgnoresStatus);
  const store = new Map(photos.map((p) => [p.id, { ...p }]));
  const visited = [];   // 清理實際碰到了哪幾筆（驗證有沒有白讀 pending 的 blob）
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    navigator: { onLine: true },
    Blob: class { constructor(parts) { this.parts = parts; this.size = 1; } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ id: 'FID' }) }),
    document: { addEventListener: () => {}, visibilityState: 'visible' },
    location: { origin: 'https://example.test' },
    window: null,
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.SqcApi = {
    createUploadSessions: async (items) => ({ sessions: items.map((_, i) => ({ ok: true, url: 'u' + i })) }),
    attachPhotoLinks: async () => ({ ok: true }),
    sharePhotoLinks: async () => ({ ok: true }),
    recordExists: async () => ({ exists: false }),
    submitRecord: async () => ({ ok: true }),
  };
  sandbox.SqcDB = {
    countPhotos: async (st) => Array.from(store.values()).filter((p) => st === undefined || p.status === st).length,
    pendingRecords: async () => [],
    queueRecord: async () => {}, delQueuedRecord: async () => {},
    addPhoto: async (p) => { store.set(p.id, { ...p }); },
    updatePhoto: async (p) => { store.set(p.id, { ...p }); },
    getPhoto: async (id) => { const p = store.get(id); return p ? { ...p } : null; },
    allPhotos: async () => Array.from(store.values()),
    pendingPhotos: async () => Array.from(store.values()).filter((p) => p.status === 'pending'),
    photosOfRecord: async (rid) => Array.from(store.values()).filter((p) => p.recordId === rid),
    // 真實的 eachPhoto 用 byStatus 索引過濾；假的也要照做，否則測到的不是真實契約
    eachPhoto: async (fn, status) => {
      visited.length = 0;
      for (const id of Array.from(store.keys())) {
        const p = store.get(id);
        if (!p) continue;
        if (!ignoreStatus && status !== undefined && p.status !== status) continue;
        visited.push(id);
        await fn({ ...p });
      }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(UP, sandbox, { filename: 'uploader.js' });
  return { uploader: sandbox.SqcUploader, store, visited };
}

/** 佇列目前佔多少位元組（blob + thumb 字串） */
const bytesOf = (store) => Array.from(store.values()).reduce(
  (s, p) => s + ((p.blob && p.blob.size) || 0) + ((p.thumb && p.thumb.length) || 0), 0);

const BIG_THUMB = 'data:image/jpeg;base64,' + 'A'.repeat(900000);   // 模擬 1920px 的 dataURL
const done = (id) => ({
  id, name: id + '.jpg', status: 'linked', recordId: 'R1', month: '11508',
  pathParts: ['115年08月', '1.招牌'], fileId: 'F_' + id,
  blob: { size: 950000 }, thumb: BIG_THUMB,
});

(async () => {
  // ===== 1. ★ 已完成的照片要被卸貨 =====
  {
    const t = load([done('a'), done('b'), done('c')]);
    const before = bytesOf(t.store);
    assertEqual(before > 5000000, true, '前提：三張完成照片原本佔超過 5MB');

    await t.uploader.pump();
    await new Promise((r) => setTimeout(r, 30));

    assertEqual(bytesOf(t.store), 0, '★ 已完成（linked）的照片不可再留著 blob 與 thumb');
    assertEqual(t.store.size, 3, '但整筆要留著 —— 統計、診斷、countsOfRecord 都還要用');
    assertEqual(Array.from(t.store.values()).every((p) => p.status === 'linked'), true, '狀態不變');
    assertEqual(Array.from(t.store.values()).every((p) => p.fileId), true, '雲端檔案 id 要留著');
    assertEqual(t.store.get('a').bytes, 950000, '★ 要記下原本多大，診斷才不會顯示成「內容 0 KB」');
  }

  // ===== 2. ★ 還沒完成的絕對不可以被清掉 =====
  //   清錯的代價是照片永久遺失、而且缺失當下已被改善、拍不回來。
  {
    const keep = [
      { ...done('p'), status: 'pending', fileId: '' },
      { ...done('d'), status: 'done' },
      { ...done('o'), status: 'orphan' },
    ];
    const t = load(keep);
    await t.uploader.pump();
    await new Promise((r) => setTimeout(r, 30));

    assertEqual(!!t.store.get('d').blob, true, '★ done（已上傳、只差連結）不可卸貨');
    assertEqual(!!t.store.get('o').blob, true, '★ orphan（待人工處理）不可卸貨');
    // 清理只該碰 linked：走全部的話，每 15 秒就會把 pending 那些 ~900KB 的 blob
    // 讀出來一次，正是我們要避免的記憶體壓力
    assertEqual(t.visited, [], '★ 沒有 linked 時清理不該讀任何一筆');
  }

  // ===== 3. 卸過貨的不要一直重寫 =====
  {
    const t = load([{ ...done('a'), blob: null, thumb: '', bytes: 950000 }]);
    let writes = 0;
    const orig = t.store.set.bind(t.store);
    t.store.set = (k, v) => { writes++; return orig(k, v); };
    await t.uploader.pump();
    await new Promise((r) => setTimeout(r, 30));
    assertEqual(writes, 0, '已經卸過貨的不該再寫一次（每次 pump 都重寫等於白費配額與時間）');
  }

  /**
   * ===== 3b. ★ 雙重保險：索引萬一沒過濾好，仍不可卸掉未完成的照片 =====
   *
   * releaseFinished 已經用 byStatus 索引只取 linked，但這裡刻意讓 eachPhoto
   * 把所有狀態都吐出來（模擬索引過時或實作被換掉），驗證 uploader 自己那道
   * `if (p.status !== 'linked') return;` 擋不擋得住。
   * 為什麼值得多一道：卸錯貨等於照片永久遺失，而缺失當下已經被改善、拍不回來。
   */
  {
    const t = load([
      { ...done('o'), status: 'orphan' },
      { ...done('d'), status: 'done' },
    ], { eachIgnoresStatus: true });
    await t.uploader.pump();
    await new Promise((r) => setTimeout(r, 30));
    assertEqual(t.visited.length, 2, '前提：這個情境下 eachPhoto 確實把非 linked 的也吐出來了');
    assertEqual(!!t.store.get('o').blob, true, '★ 即使索引沒過濾，orphan 仍不可被卸貨');
    assertEqual(!!t.store.get('d').blob, true, '★ 即使索引沒過濾，done 仍不可被卸貨');
  }
})().then(() => {
  // ===== 4. 原始碼層面：確認機制真的接上去了 =====
  assertEqual(/function released\(photo, status\)/.test(UP), true, '要有卸貨函式');
  assertEqual(/delete out\.blob;/.test(UP) && /delete out\.thumb;/.test(UP), true, '兩份都要丟掉');
  assertEqual(/await releaseFinished\(\)\.catch\(\(\) => 0\);/.test(UP), true,
    '★ 每輪 pump 開頭要先清一次 —— 只改新照片沒用，現場手機上已經堆了好幾天');
  assertEqual(UP.indexOf('await releaseFinished()') < UP.indexOf('await pumpRecords()'), true,
    '要先騰出空間再做事：佇列滿到寫不進去的話，後面每一步都會失敗');

  // 清理必須用游標逐筆，不可用 getAll —— 那會把要清掉的東西先全部讀進記憶體
  {
    const fn = /function eachPhoto\(fn, status\)[\s\S]*?\n  \}/.exec(DB);
    assertEqual(!!fn, true, '應能取出 eachPhoto');
    assertEqual(/getAll/.test(fn[0]), false, '★ eachPhoto 內不可出現 getAll');
    assertEqual(/openKeyCursor/.test(fn[0]), true, '★ 要用 key 游標（只讀鍵，不讀內容）');
    assertEqual(/index\('byStatus'\)\.openKeyCursor\(IDBKeyRange\.only\(status\)\)/.test(fn[0]), true,
      '★ 要用 byStatus 索引過濾 —— 走全部的話每 15 秒會把 pending 的 blob 全讀一次');
  }
  assertEqual(/if \(p\.status !== 'linked'\) return;/.test(UP), true,
    '★ uploader 自己也要再確認狀態：卸錯貨等於照片永久遺失，不能只靠索引');
  assertEqual(/if \(!freed\) _sweepNeeded = false;/.test(UP), true,
    '舊資料清完後不必再掃 —— 新照片在變成 linked 的當下就卸貨了');

  // ===== 5. 縮圖要真的是縮圖 =====
  assertEqual(/const THUMB_EDGE = 320/.test(APP) || /THUMB_EDGE = 320/.test(APP), true, '要有縮圖尺寸上限');
  assertEqual(/drawScaled\(canvas, THUMB_EDGE\)\.toDataURL\('image\/jpeg', THUMB_Q\)/.test(APP), true,
    '★ 縮圖要從縮小後的畫布產生');
  assertEqual(/const thumb = canvas\.toDataURL\('image\/jpeg', THUMB_Q\);/.test(APP), false,
    '★ 不可再直接把 1920px 畫布轉 dataURL（那等於存了第二份原圖，還比原圖大）');
  assertEqual(/function drawScaled\(img, edge\)/.test(APP), true, 'drawScaled 要能指定尺寸');

  console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
  process.exit(failed ? 1 : 0);
});
