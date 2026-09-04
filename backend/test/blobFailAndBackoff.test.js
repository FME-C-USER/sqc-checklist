/**
 * 回歸測試：2026-08-28 現場三支手機同時出問題的三件事。
 *
 * 1. IndexedDB 存 Blob 失敗時，例外從 pump 漏出去變成 unhandledrejection，
 *    現場看到的是「系統發生未預期錯誤」而不是任何有用的訊息。
 *    （WebKit 在「把 Blob 存進 object store」這條路徑上會丟
 *      Error preparing Blob/File data to be stored in object store，
 *      而 updatePhoto 每次記重試次數都會把整個含 Blob 的物件重新寫回去。）
 * 2. 照片佇列的第一輪沒有套用退避 —— 失敗過的照片仍然每 15 秒被拿去打一次
 *    createUploadSessions，後端越忙這件事越傷。
 * 3. createUploadSessions 的逾時是預設的 12 秒 × 4 次，後端忙的時候等於
 *    連一次成功的機會都沒有。
 *
 * 執行方式：node backend/test/blobFailAndBackoff.test.js
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
const GS = fs.readFileSync(path.join(ROOT, 'backend', '程式碼.gs'), 'utf8');

/**
 * 載入 uploader.js，注入一個「updatePhoto 會丟例外」的 SqcDB。
 * 未捕捉的 rejection 記進 unhandled[]，用來證明例外沒有漏出去。
 */
function loadUploader({ updateThrows, photos }) {
  const unhandled = [];
  const sessionCalls = [];
  const store = new Map(photos.map((p) => [p.id, { ...p }]));
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    // uploader.js 的 PUT 現在有 AbortController 逾時（瀏覽器一定有，
    // 但 vm 沙箱預設沒有）—— 沒有它會讓 uploadOne 在第一行就 ReferenceError，
    // 而那會被誤讀成「上傳失敗」。
    AbortController,
    navigator: { onLine: true },
    Blob: class { constructor(parts) { this.parts = parts; this.size = 1; } },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'FID' }) }),
    document: { addEventListener: () => {}, visibilityState: 'visible' },
    location: { origin: 'https://example.test' },
    window: null,
    addEventListener: (k, fn) => { if (k === 'unhandledrejection') sandbox.__onRej = fn; },
  };
  sandbox.window = sandbox;
  sandbox.SqcApi = {
    createUploadSessions: async (items) => {
      sessionCalls.push(items.map((i) => i.name));
      return { sessions: items.map((it, i) => ({ ok: true, url: 'https://up.test/' + i })) };
    },
    attachPhotoLinks: async () => ({ ok: true }),
    recordExists: async () => ({ exists: false }),
    submitRecord: async () => ({ ok: true }),
  };
  sandbox.SqcDB = {
    countPhotos: async (st) => Array.from(store.values()).filter((p) => st === undefined || p.status === st).length,
    pendingRecords: async () => [],
    queueRecord: async () => {},
    delQueuedRecord: async () => {},
    addPhoto: async (p) => { store.set(p.id, { ...p }); },
    updatePhoto: async (p) => {
      if (updateThrows()) throw new Error('Error preparing Blob/File data to be stored in object store');
      store.set(p.id, { ...p });
    },
    allPhotos: async () => Array.from(store.values()),
    pendingPhotos: async () => Array.from(store.values()).filter((p) => p.status === 'pending'),
    photosOfRecord: async (rid) => Array.from(store.values()).filter((p) => p.recordId === rid),
  };
  vm.createContext(sandbox);
  process.on('unhandledRejection', (e) => unhandled.push(String((e && e.message) || e)));
  vm.runInContext(UP, sandbox, { filename: 'uploader.js' });
  return { uploader: sandbox.SqcUploader, store, unhandled, sessionCalls };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const PHOTO = (over) => ({
  id: 'p1', name: 'a.jpg', status: 'pending', recordId: 'R1', month: '11508',
  where: '1.招牌', blob: { size: 1000 }, tries: 0, ...over,
});

(async () => {
  // ===== 1. IndexedDB 寫入失敗不可變成「系統發生未預期錯誤」 =====
  {
    const t = loadUploader({ updateThrows: () => true, photos: [PHOTO()] });
    let threw = '';
    try { await t.uploader.pump(); } catch (e) { threw = String(e.message || e); }
    await settle();
    assertEqual(threw, '', '★ IndexedDB 存 Blob 失敗時 pump 不可丟出例外（否則全域錯誤視窗會蓋掉真正的原因）');
    assertEqual(t.unhandled, [], '★ 也不可留下未捕捉的 rejection（setInterval 呼叫的 pump 沒有人 await）');
    // 原因仍然要有地方看得到，不能就這樣消失
    const c = await t.uploader.counts();
    assertEqual(/Blob/.test(c.lastError || ''), true, '整輪失敗的原因要能從 counts() 取得');
    assertEqual(/儲存空間不足/.test(c.lastError || ''), true, '要用現場看得懂的話說明，不能只丟英文原文');
    // ★ 光是回傳還不夠 —— 一定要有地方把它畫出來，否則等於沒做
    assertEqual(/\{pendingUp && pendingUp\.lastError && \(/.test(APP), true,
      '★ 診斷視窗要顯示整體錯誤（這種失敗不屬於任何單一張照片，沒畫出來就完全看不到）');
    assertEqual(/<b>整體錯誤：<\/b>\{pendingUp\.lastError\}/.test(APP), true, '要標示得出來這是整體性的錯誤');
    // pendingUp 來自 counts()（有 lastError）；postStat 來自 countsOfRecord()（沒有），不可搞混
    assertEqual(/\{postStat && postStat\.lastError/.test(APP), false,
      'lastError 只在 counts() 裡，用 postStat 會永遠是 undefined');
  }

  // ===== 2. 照片佇列第一輪要套用退避 =====
  {
    // 一張還在退避中（nextAt 在未來）、一張到期
    const t = loadUploader({
      updateThrows: () => false,
      photos: [
        PHOTO({ id: 'wait', name: 'wait.jpg', nextAt: Date.now() + 60000, tries: 5 }),
        PHOTO({ id: 'due', name: 'due.jpg', nextAt: Date.now() - 1000, tries: 5 }),
      ],
    });
    await t.uploader.pump();
    await settle();
    const asked = t.sessionCalls.flat();
    assertEqual(asked.indexOf('due.jpg') >= 0, true, '退避時間已到的要送去要上傳網址');
    assertEqual(asked.indexOf('wait.jpg') >= 0, false,
      '★ 還在退避中的不可送 —— 否則每 15 秒必打一次 createUploadSessions，後端越忙越傷');
  }

  // 原始碼層面確認過濾條件真的加在第一輪（行為測試只能證明有過濾，證明不了寫在哪）
  // 條件已抽成共用的 due()：迴圈頭尾都用同一份，避免只改一處而漏掉另一處。
  assertEqual(/const due = \(p\) => !_skip\.has\(p\.id\) && \(!p\.nextAt \|\| p\.nextAt <= Date\.now\(\)\);/.test(UP),
    true, '★ due() 要同時排除退避中與跳過名單');
  // 比對「有幾處過了 due()」而不是「字面長相」：2026-09-03 迴圈開頭改成先把清單存進
  // 變數（要順便推導 stalled 張數），字面就變了，但頭尾都過 due() 這個意圖沒變。
  assertEqual((UP.match(/\.filter\(due\)/g) || []).length, 2,
    '★ 迴圈開頭與每圈結尾都要用同一份 due()（只改一處會讓另一處繼續取到不該取的）');

  // ===== 3. 三個寫回佇列的地方都要走 safeUpdate =====
  assertEqual(/async function safeUpdate\(photo\)/.test(UP), true, '要有吞掉寫入失敗的包裝');
  // 2026-09-03 起這一筆改成先 released() 卸掉 blob 再寫（幾百位元組而不是 ~820KB），
  // 但它一樣必須走 safeUpdate —— 寫不進去時要能收斂到跳過名單，不可以拋出去。
  assertEqual(/await safeUpdate\(released\(\{ \.\.\.p, fileId \}, 'done'\)\)/.test(UP), true,
    '上傳成功後的狀態寫回要包起來（而且要卸掉 blob）');
  // 兩處記次都加上了 stalled 判定，寫法變成多行，所以比對跨行的形狀
  assertEqual((UP.match(/safeUpdate\(\{\s*\.\.\.p, tries, stalled,/g) || []).length, 2,
    '取不到上傳網址、單張上傳失敗兩個記次的地方都要包起來');
  assertEqual(/\n      const fileId = await uploadOne\(p, sessions\[off \+ k\]\);\n              await window\.SqcDB\.updatePhoto/.test(UP), false,
    '上傳路徑上不可再有裸的 updatePhoto');

  // ===== 4. createUploadSessions 要有足夠的逾時 =====
  assertEqual(/createUploadSessions: 45000/.test(API), true,
    '★ createUploadSessions 要進 RETRY_LONGER；預設 12 秒 × 4 次讓 2026-08-27 那批照片連一次機會都沒有');

  // ===== 5. 待送佇列的確認要用只讀一欄的路由 =====
  assertEqual(/window\.SqcApi\.recordExists\(q\.month, q\.id\)/.test(UP), true, '重送前用 recordExists 確認');
  assertEqual(/window\.SqcApi\.queryRecords\(q\.month/.test(UP), false,
    '★ 不可再用 queryRecords —— 它的後端實作會讀整張活頁');
  assertEqual(/function recordExists\(month, id\)/.test(GS), true, '後端要有這支');
  assertEqual(/recordExists: function \(\) \{ return recordExists\(p\.month, p\.id\); \}/.test(GS), true, '要掛進路由表');
  assertEqual(/getDataRange/.test(GS.slice(GS.indexOf('function recordExists'), GS.indexOf('function getInspectedCodes'))), false,
    '★ recordExists 不可讀整張表，否則就失去意義了');
  assertEqual(/LockService/.test(GS.slice(GS.indexOf('function recordExists'), GS.indexOf('function getInspectedCodes'))), false,
    'recordExists 不拿鎖：只讀一欄做判斷，且 submitRecord 本身等冪');

  // ===== 6. 「後端未回傳資料」不可再叫人去重新部署 =====
  //   只掃真正會丟給使用者的那幾行，不掃整個檔 ——
  //   註解裡本來就會引用舊訊息來說明為什麼要改，掃整個檔會被自己的註解命中。
  {
    const thrown = (API.match(/throw new Error\((?:[^)]|\)(?!;))*\);/g) || []).join('\n');
    assertEqual(/請確認 Apps Script 已重新部署新版本/.test(thrown), false,
      '★ 這句話在 2026-08-28 讓大家去查一個其實正常的部署；後端忙碌才是比較常見的原因');
    assertEqual(/後端回應不完整（動作：/.test(thrown), true, '要先講負載，部署只是次要可能');
  }

  // ===== 7. 內建瀏覽器要擋 =====
  assertEqual(/const IN_APP_BROWSER = \(function \(\)/.test(APP), true, '要偵測 App 內建瀏覽器');
  assertEqual(/\{IN_APP_BROWSER && \(/.test(APP), true, '偵測到要顯示警告');
  assertEqual(/待上傳的照片會直接消失/.test(APP), true, '要講清楚後果，不然沒人會換瀏覽器');
  // 用真實的 UA 字串驗判斷式，不是驗我自己寫的正則
  {
    const fn = new Function('navigator', 'return ' + APP.slice(APP.indexOf('(function () {\n      const ua = navigator.userAgent'), APP.indexOf("return '';\n    })();") + 20));
    const UAS = {
      'LINE': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.9.0',
      'Facebook': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/460.0.0]',
      'Instagram': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 320.0.0',
    };
    Object.keys(UAS).forEach((k) => assertEqual(fn({ userAgent: UAS[k] }), k, k + ' 內建瀏覽器要認得出來'));
    // 誤判成本很高：Safari 與 Chrome 被擋住的話，能正常用的人會被叫去換瀏覽器
    assertEqual(fn({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' }), '',
      '★ Safari 不可誤判');
    assertEqual(fn({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1' }), '',
      '★ Chrome 不可誤判');
  }

  // ===== 8. 開場快取的後端版本不可拿去比對 =====
  assertEqual(/const cachedVer = bootWarn \|\| gasStale;/.test(APP), true,
    '★ 開場那一趟還沒回來時顯示的是快取版本，不可掛「需 xxx 以上」叫人去重貼');

  console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
  process.exit(failed ? 1 : 0);
})();
