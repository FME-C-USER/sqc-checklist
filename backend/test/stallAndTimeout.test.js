/**
 * 回歸測試：2026-09-03 傍晚「卡住一直不動好幾個小時，但查詢時資料與照片連結都在」。
 *
 * 四件事，各自獨立：
 *
 * 1. 逾時不可以說「送出失敗」
 *    後端做完了、Sheet 上有那筆，只是回應沒在 12 秒內回來。說成「失敗」的直接後果是
 *    同事再按一次送出，而每一次送出都要搶後端的腳本鎖 → 更多人逾時。
 *    這是唯一會自我加劇的一項，所以優先度最高。
 *
 * 2. pending 照片原本沒有出口
 *    三個佇列裡只有它沒有：紀錄補送有 REC_MAX_TRIES(30)→blocked，
 *    連結回寫有 LINK_MAX_TRIES(20)→orphan，而 pending 照片退避上限 60 秒，
 *    所以每分鐘試一次直到頁面關掉。REPORT_AFTER_TRIES 只「回報一筆事件」，不會停。
 *
 *    ★ 用旗標而不是新增狀態，是刻意的安全選擇：
 *      「清空整個佇列」算「幾張會永久遺失」時只認 status==='pending'（app.html）。
 *      新增一個狀態會被那段漏掉 → 確認訊息說「0 張會遺失」卻真的刪掉沒上傳的照片。
 *      維持 status 不變，所有安全消費端就繼續正確。
 *
 * 3. 上傳成功後要卸掉 blob
 *    原本寫 { ...p, status:'done', fileId }，blob 還在裡面 —— 幾百位元組的狀態變更
 *    要重寫整張 ~820KB 的照片，空間滿的手機於是永遠寫不進去。
 *    卸貨之後寫入變小、而且立刻釋放 ~820KB：從「每傳成功一張釋放 0」
 *    變成「每傳成功一張就為下一張騰出空間」。
 *
 * 4. retry 要用主鍵裡的時間戳記
 *    tries 寫不進去時永遠是 0 → 後端不查同檔名 → Drive 每輪多一份。
 *    主鍵 'ph_<ms>_<rand>' 的時間戳記不需要任何寫入就讀得到，且跨工作階段有效。
 *
 * 執行方式：node backend/test/stallAndTimeout.test.js
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
const DB = fs.readFileSync(path.join(ROOT, 'js', 'db.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
// 只去整行註解與 JSX 註解：一般的 // 規則會把 https:// 一起吃掉
const CODE = APP.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');
const UPCODE = UP.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** 載入 uploader.js，帶一個可控的假 Drive 與假 IndexedDB */
function load(photos, opts) {
  const o = opts || {};
  const store = new Map(photos.map((p) => [p.id, { ...p }]));
  const drive = [];
  const sessionItems = [];
  let quota = o.quota === undefined ? Infinity : o.quota;   // 剩餘可用位元組
  const writes = [];

  const sizeOf = (p) => JSON.stringify({ ...p, blob: undefined }).length
    + ((p.blob && p.blob.size) || 0);

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
      if (o.putFails) throw new Error('Load failed');
      drive.push(name);
      return { ok: true, status: 200, json: async () => ({ id: 'F' + drive.length }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.SqcApi = {
    createUploadSessions: async (items) => {
      if (o.sessionFails) throw new Error('伺服器逾時未回應（45 秒）');
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
    /**
     * 模擬真實的 IndexedDB 配額。
     *
     * ★ 關鍵：需要的空間是「新值的完整大小」，不是新舊的差額 ——
     * put 是整筆取代，交易提交之前舊值還佔著位子，兩份要同時存在。
     * 用差額算是錯的，而且會讓舊寫法（blob 原封存回去）看起來沒問題：
     * 差額幾乎是 0，測試就通過了，於是這個測試變成裝飾品。
     * 現場的事實是「同樣大小的紀錄重寫就是會失敗」，只有完整大小的模型對得上。
     *
     * 提交之後的淨效果才是差額，所以 quota 用差額調整。
     */
    updatePhoto: async (p) => {
      const old = store.get(p.id);
      const need = sizeOf(p);                       // 尖峰：新值要先放得下
      const net = need - (old ? sizeOf(old) : 0);   // 提交後的淨變化
      writes.push({ id: p.id, need, net });
      if (need > quota) throw new Error('Error preparing Blob/File data to be stored in object store');
      quota -= net;
      store.set(p.id, { ...p });
    },
    delPhoto: async (id) => { const p = store.get(id); if (p) quota += sizeOf(p); store.delete(id); },
    getPhoto: async (id) => { const p = store.get(id); return p ? { ...p } : null; },
    allPhotos: async () => Array.from(store.values()),
    pendingPhotos: async () => Array.from(store.values()).filter((p) => p.status === 'pending'),
    photosOfRecord: async (rid) => Array.from(store.values()).filter((p) => p.recordId === rid),
    photoDiagnostics: async () => Array.from(store.values()).map((p) => ({
      id: p.id, name: p.name, status: p.status, tries: p.tries || 0,
      error: p.error || '', reported: !!p.reported, blobSize: 0, stalled: !!p.stalled,
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
  return { uploader: sandbox.SqcUploader, store, drive, sessionItems, writes, quotaLeft: () => quota };
}

const BLOB = 820000;
// 主鍵裡的時間戳記要用「當下」，否則每一張都會被判定為陳舊（1700000000000 是 2023 年）
const T0 = Date.now();
const photo = (n, extra) => ({
  id: 'ph_' + (T0 + n) + '_a' + n, name: 'p' + n + '.jpg', status: 'pending',
  recordId: 'R1', month: '11509', pathParts: ['115年09月', '1.招牌'],
  blob: { size: BLOB }, tries: 0, where: '1.招牌', ...(extra || {}),
});
const settle = () => new Promise((r) => setTimeout(r, 40));

(async () => {
  /**
   * ===== 3. ★ 上傳成功後要卸貨：空間只夠「小寫入」時仍要能完成 =====
   * 配額刻意設成「遠小於一張照片、但足夠寫一筆中繼資料」——
   * 舊寫法（blob 原封存回去）在這裡必定失敗，新寫法必定成功。
   */
  {
    const t = load([photo(0)], { quota: 5000 });
    await t.uploader.pump();
    await settle();
    const p = t.store.get(t.store.keys().next().value);
    assertEqual(p.status, 'linked',
      '★ 空間只剩 5KB 也要能完成 —— 卸掉 blob 之後這次寫入只有幾百位元組');
    assertEqual(!!p.blob, false, '★ 完成後本機不可再握著 blob');
    assertEqual(t.quotaLeft() > BLOB, true,
      '★ 完成一張要「釋放」空間（實際剩 ' + t.quotaLeft() + '），下一張才有機會');
  }

  /**
   * ★ 自我修復：三張照片、配額只夠一張多一點。
   * 舊行為＝第一張寫不回去、永遠 pending、三張都卡住。
   * 新行為＝傳完一張就騰出空間給下一張，三張全部完成。
   */
  {
    const t = load([photo(0), photo(1), photo(2)], { quota: BLOB + 20000 });
    for (let i = 0; i < 4; i++) { await t.uploader.pump(); await settle(); }
    const done = Array.from(t.store.values()).filter((p) => p.status === 'linked').length;
    assertEqual(done, 3,
      '★ 配額只夠一張時，三張仍要全部完成（實際 ' + done + '）—— 每傳成功一張就為下一張騰出空間');
  }

  /**
   * ===== 2. ★ pending 照片的出口 =====
   * PUT 一直失敗：試到門檻要標記 stalled 並把重試間隔拉長，
   * 但 status 必須維持 pending（照片還在手機上、還是會遺失）。
   */
  {
    const t = load([photo(0)], { putFails: true });
    const id = 'ph_' + T0 + '_a0';
    for (let i = 0; i < 30; i++) {
      const p = t.store.get(id);
      // 直接把退避時間往前撥，模擬時間流逝（否則要真的等 60 秒）
      t.store.set(id, { ...p, nextAt: 0 });
      await t.uploader.pump();
      await settle();
      if (t.store.get(id).stalled) break;
    }
    const p = t.store.get(id);
    assertEqual(p.stalled, true, '★ 一直傳不上去要標記 stalled（原本永遠不會停）');
    assertEqual(p.status, 'pending',
      '★ status 必須維持 pending —— 改狀態會讓「清空整個佇列」漏算「幾張會永久遺失」');
    assertEqual(p.tries >= 12, true, '門檻是 STALL_AFTER_TRIES=12（實際 ' + p.tries + '）');
    assertEqual(p.nextAt - Date.now() > 300000, true,
      '★ 之後的重試間隔要拉長到十分鐘級，不可再每分鐘打一次後端');
    assertEqual(!!p.blob, true, '★ 絕對不可以把照片丟掉 —— 它還沒進雲端');

    // 使用者按「立即重試」＝情況變了，要重新給機會
    await t.uploader.pump({ force: true });
    await settle();
    assertEqual(t.store.get(id).stalled, false, '★ 按「立即重試」要清掉 stalled 並重新計次');
  }

  // 一切正常時不可以誤標
  {
    const t = load([photo(0)], {});
    await t.uploader.pump();
    await settle();
    const p = t.store.get('ph_' + T0 + '_a0');
    assertEqual(p.stalled, false, '正常完成的照片不可被標成 stalled');
    assertEqual(t.uploader.counts !== undefined, true, 'counts 仍然匯出');
  }

  /**
   * ===== 4. ★ retry 用主鍵時間戳記，不靠寫入 =====
   * 現場條件：一張很久以前排進來、tries 卻寫不進去（永遠 0）。
   */
  {
    const old = { ...photo(0), id: 'ph_1000_zz', tries: 0 };  // 主鍵時間 = 1970 年，遠早於 STALE_MS
    const t = load([old], {});
    await t.uploader.pump();
    await settle();
    assertEqual(t.sessionItems.flat().map((i) => i.retry), [true],
      '★ 排進來很久卻還沒傳完 → 必須請後端查同檔名，即使 tries 是 0');
  }
  {
    const t = load([photo(0)], {});   // 主鍵時間 = 剛剛
    await t.uploader.pump();
    await settle();
    assertEqual(t.sessionItems.flat().map((i) => i.retry), [false],
      '剛排進來的不查（正常手機不必付那 0.2~0.4 秒）');
  }

  // ===== 原始碼層面 =====
  assertEqual(/const STALL_AFTER_TRIES = 12;/.test(UP), true, 'STALL_AFTER_TRIES 常數存在');
  assertEqual(/function idTime\(id\)/.test(UP), true, 'idTime 從主鍵取時間戳記');
  assertEqual(/status: 'done', fileId, error: ''/.test(UPCODE), false,
    '★ 不可再把 blob 原封不動存回去（舊寫法）');
  assertEqual(/safeUpdate\(released\(\{ \.\.\.p, fileId \}, 'done'\)\)/.test(UP), true,
    '★ 要用 released() 卸貨');
  // 前提：確認上面那條 false 不是抓錯字串而假通過
  assertEqual(/status: 'done'/.test(UPCODE) || /'done'\)\)/.test(UPCODE), true,
    '前提：done 這條路徑還在');

  // 1. 逾時的訊息
  assertEqual(/err\.timedOut = aborted;/.test(API), true, '★ api.js 要把逾時標成可判斷的旗標');
  assertEqual(/submitRecord: 45000,/.test(API), true,
    '★ submitRecord 要進 RETRY_LONGER —— 它跟 attachPhotoLinks 一樣要拿腳本鎖');
  assertEqual(/const unsure = !!\(e && \(e\.transient \|\| e\.timedOut\)\);/.test(CODE), true,
    '★ 送出的 catch 要分辨「不確定」與「真的失敗」');
  assertEqual(/請不要重複按「送出評核」/.test(CODE), true,
    '★ 要明確叫使用者不要重複送出 —— 重送會加重鎖競爭，是這個訊息的主要危害');
  assertEqual(/伺服器沒有在時限內回應/.test(CODE), true, '逾時要說「沒有在時限內回應」而不是「失敗」');

  // 2. 畫面措辭
  assertEqual(/有照片一直傳不上去，請按「查看原因」/.test(CODE), true,
    '★ stalled 時橫幅要改口 —— 「請保持頁面開啟」是在請她等，而等不會有結果');
  assertEqual(/pendingUp\.pending - \(pendingUp\.stalled \|\| 0\)/.test(CODE), true,
    '★ stalled 是 pending 的子集，張數要相減不可相加');
  assertEqual(/stalled: !!p\.stalled,/.test(DB), true, '診斷要拿得到 stalled');
  assertEqual(/stalled: _stalledIds\.size,/.test(UP), true, 'counts() 要回報 stalled');

  console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
  process.exit(failed ? 1 : 0);
})();
