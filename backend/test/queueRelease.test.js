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
  const updateFails = !!(opts && opts.updateAlwaysFails);
  const deleteFails = !!(opts && opts.deleteAlwaysFails);
  const store = new Map(photos.map((p) => [p.id, { ...p }]));
  const visited = [];      // 這一輪清理碰到了哪幾筆（驗證有沒有白讀 pending 的 blob）
  const visitedAll = [];   // 累計（驗證「清不動」時下一輪還會再試）
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    // uploader.js 的 PUT 現在有 AbortController 逾時（瀏覽器一定有，
    // 但 vm 沙箱預設沒有）—— 沒有它會讓 uploadOne 在第一行就 ReferenceError，
    // 而那會被誤讀成「上傳失敗」。
    AbortController,
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
    updatePhoto: async (p) => {
      // 模擬「空間已滿，任何寫入都被拒」——正是 released() 那條路徑會踩到的
      if (updateFails) throw new Error('Error preparing Blob/File data to be stored in object store');
      store.set(p.id, { ...p });
    },
    delPhoto: async (id) => {
      if (deleteFails) throw new Error('delete failed');
      store.delete(id);
    },
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
        visitedAll.push(id);
        await fn({ ...p });
      }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(UP, sandbox, { filename: 'uploader.js' });
  return { uploader: sandbox.SqcUploader, store, visited, visitedAll };
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

    /**
     * done 的行為已經改了（2026-09-03）：
     * flushLinksIfDone 原本要求「這一筆每一張都是 done 或 linked」才回寫連結，
     * 于是只要有一張 pending，其餘已在雲端的就永遠卡在 done。
     * 現在「有 fileId 的先寫回去」→ 連結寫成功→转 linked→才卸貨。
     * 所以這裡正確的期待是「已經轉成 linked 並卸貨」。
     */
    assertEqual(t.store.get('d').status, 'linked', '★ done 的連結要能單獨寫回（不可被同一筆的 pending 擋住）');
    assertEqual(!!t.store.get('d').blob, false, '連結寫成功了，卸貨是正確的');
    assertEqual(!!t.store.get('o').blob, true, '★ orphan（待人工處理）不可卸貨');
    // （'p' 在這個假環境裡會上傳成功而合理地轉成 linked，所以不能在這裡斷言它的 blob。
    //   「releaseFinished 不可碰未完成的照片」由下面的 t.visited === [] 與 3b 段負責。）
    // 清理只該碰 linked：走全部的話，每 15 秒就會把 pending 那些 ~900KB 的 blob
    // 讀出來一次，正是我們要避免的記憶體壓力
    assertEqual(t.visited, [], '★ 沒有 linked 時清理不該讀任何一筆');
  }

  /**
   * ===== 2b. ★ 寫不進去時要退回刪除，而且不可以自己關掉清理 =====
   *
   * 這是 2026-08-31 現場那支手機很可能的處境：儲存空間已滿 → 連「把 blob 拿掉
   * 再存回去」這個寫入都失敗 → 舊版邏輯把 freed===0 當成「沒東西要清」→
   * 清理功能第一輪就自我關閉 → 永遠卡住。
   */
  {
    const t = load([done('a'), done('b')], { updateAlwaysFails: true });
    await t.uploader.pump();
    await new Promise((r) => setTimeout(r, 30));
    assertEqual(t.store.size, 0, '★ 寫入失敗時要改用刪除，確實把空間騰出來');

    // 再確認「清不動」不會讓清理自我關閉：換一支永遠寫不進、也刪不掉的
    const t2 = load([done('a')], { updateAlwaysFails: true, deleteAlwaysFails: true });
    await t2.uploader.pump();
    await new Promise((r) => setTimeout(r, 30));
    const first = t2.visitedAll.length;
    await t2.uploader.pump();
    await new Promise((r) => setTimeout(r, 30));
    assertEqual(t2.visitedAll.length > first, true,
      '★ 清不動時下一輪還要再試 —— 不可以把 freed===0 當成「沒東西要清」而關掉');
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
    // 只放 orphan：done 會被 reconcileLinks 合理地寫連結並轉 linked，
    // 混在一起就分不出「是 releaseFinished 碰了它」還是「是連結寫成功了」。
    // orphan 不在 flushLinksIfDone 的範圍內，所以能孤立出這一道保險。
    const t = load([{ ...done('o'), status: 'orphan' }], { eachIgnoresStatus: true });
    await t.uploader.pump();
    await new Promise((r) => setTimeout(r, 30));
    assertEqual(t.visited.length, 1, '前提：這個情境下 eachPhoto 確實把非 linked 的也吐出來了');
    assertEqual(!!t.store.get('o').blob, true, '★ 即使索引沒過濾，orphan 仍不可被卸貨');
    assertEqual(t.store.get('o').status, 'orphan', '狀態也不可被改成 linked');
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
  /**
   * ★ 關掉清理的條件必須是「沒有東西要清」，不是「沒清成功」。
   *
   * 原本寫 if (!freed) —— 但 freed === 0 有兩種完全不同的意思：
   * 沒東西要清，或每一筆都清不動。混為一談的結果是「因為空間不足而清不動」的手機
   * 第一輪就把清理功能自己關掉，正是最需要它的那一支。
   */
  assertEqual(/if \(!candidates\) _sweepNeeded = false;/.test(UP), true,
    '★ 只有「真的沒東西要清」才關掉清理');
  assertEqual(/if \(!freed\) _sweepNeeded = false;/.test(UP), false,
    '★ 不可用「沒清成功」當關閉條件 —— 那會讓清不動的手機永遠不再嘗試');
  // put 失敗要退回 delete：騰出空間的動作本身需要空間，這是 catch-22
  assertEqual(/async function releaseOne\(p\) \{[\s\S]*?delPhoto\(p\.id\)/.test(UP), true,
    '★ 寫入失敗要退回整筆刪除（delete 不需要空間，一定成功）');

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
