/**
 * 回歸測試：卡住的 PUT 不可以讓上傳器永久死掉。
 *
 * 2026-09-03 現場「一直無法完整上傳」的根因：直傳 Drive 的那個 fetch
 * 沒有 AbortController、沒有 signal、沒有任何逾時 —— 而 api.js 打後端的
 * 每一次呼叫都有。行動網路上只要有一個 PUT 卡住（連上了但不傳資料），
 * 那個 await 就永遠不會結束：
 *   它在 Promise.all(wave) 裡面 → 整波不完成 → pumpOnce 不返回
 *   → _running 永遠是 true → 之後每 15 秒的 setInterval 只會設一下 _again 就返回
 * 上傳器完全死掉，直到重新載入頁面。
 *
 * 現場症狀完全對得上，而且每一個都「沒有錯誤訊息」，所以極難查：
 *   ・「正在重試…」永遠灰著（_running 卡在 true）
 *   ・約 70 張照片 tries=0 且沒有任何錯誤（卡在第一波，後面的從未被列舉）
 *   ・沒有「整體錯誤」（因為沒有任何東西拋錯）
 *
 * 執行方式：node backend/test/putTimeout.test.js
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
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

/**
 * 載入 uploader.js，並把 PUT 逾時與看門狗改成很短，測試才跑得完。
 * hangNames：這些檔名的 PUT 永遠不回應（模擬「連上了但不傳資料」）。
 */
function load(photos, opts) {
  const o = opts || {};
  const hang = new Set(o.hangNames || []);
  const store = new Map(photos.map((p) => [p.id, { ...p }]));
  const sessionAsked = [];
  const aborted = [];

  const src = UP
    .replace('const PUT_TIMEOUT_MS = 60000;', 'const PUT_TIMEOUT_MS = 120;')
    .replace('const PUMP_MAX_MS = 600000;', 'const PUMP_MAX_MS = 3000;');

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    AbortController,
    navigator: { onLine: true },
    Blob: class { constructor(parts) { this.parts = parts; this.size = 1; } },
    document: { addEventListener: () => {}, visibilityState: 'visible' },
    location: { origin: 'https://example.test' },
    window: null,
    addEventListener: () => {},
    fetch: (url, init) => {
      const name = String(url).split('#')[1] || '';
      if (!hang.has(name)) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'F_' + name }) });
      }
      // 永遠不 resolve —— 只有 signal 的 abort 能結束它，這正是真實情況
      return new Promise((_, reject) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => {
            aborted.push(name);
            const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
          });
        }
      });
    },
  };
  sandbox.window = sandbox;
  sandbox.SqcApi = {
    createUploadSessions: async (items) => {
      sessionAsked.push(items.map((i) => i.name));
      return { sessions: items.map((it) => ({ ok: true, url: 'https://up.test/x#' + it.name })) };
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
    updatePhoto: async (p) => { store.set(p.id, { ...p }); },
    delPhoto: async (id) => { store.delete(id); },
    getPhoto: async (id) => { const p = store.get(id); return p ? { ...p } : null; },
    allPhotos: async () => Array.from(store.values()),
    pendingPhotos: async () => Array.from(store.values())
      .filter((p) => p.status === 'pending')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
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
  vm.runInContext(src, sandbox, { filename: 'uploader.js' });
  return { uploader: sandbox.SqcUploader, store, sessionAsked, aborted };
}

const photo = (n) => ({
  id: 'ph_' + String(1000 + n), name: 'p' + n + '.jpg', status: 'pending',
  recordId: 'R1', month: '11509', pathParts: ['115年09月', '1.招牌'],
  blob: { size: 900000 }, tries: 0, where: '1.招牌',
});

(async () => {
  // ===== 1. ★ 卡住的 PUT 一定要被中止，而且 pump 一定要結束 =====
  {
    const t = load([photo(0), photo(1), photo(2)], { hangNames: ['p0.jpg'] });
    const outcome = await Promise.race([
      t.uploader.pump().then(() => 'finished'),
      new Promise((r) => setTimeout(() => r('hung'), 5000)),
    ]);
    assertEqual(outcome, 'finished',
      '★ 一個 PUT 卡住時 pump 仍要結束 —— 卡死的話 _running 永遠是 true，上傳器死到重新載入為止');
    assertEqual(t.aborted, ['p0.jpg'], '★ 卡住的那一張要被 abort（沒有 signal 就永遠中止不了）');
  }

  // ===== 2. ★ 逾時要被當成「可重試的失敗」，而且訊息要看得懂 =====
  {
    const t = load([photo(0)], { hangNames: ['p0.jpg'] });
    await t.uploader.pump();
    await new Promise((r) => setTimeout(r, 60));
    const p = t.store.get('ph_1000');
    assertEqual(p.status, 'pending', '逾時後仍留在佇列等下一輪');
    assertEqual(p.tries, 1, '★ 要記次（現場那 70 張的 tries=0 就是因為連 catch 都沒走到）');
    assertEqual(/上傳逾時/.test(p.error || ''), true, '★ 要寫成看得懂的訊息，不可只留 AbortError');
    assertEqual(/AbortError/.test(p.error || ''), false, '現場看到 AbortError 完全不知道那是什麼');
    assertEqual((p.nextAt || 0) > Date.now(), true, '要有退避，不可下一輪立刻again');
  }

  // ===== 3. ★ 卡住那一張不可以擋住後面的（兩個 bug 疊在一起才是現場的樣子）=====
  {
    const photos = [];
    for (let i = 0; i < 12; i++) photos.push(photo(i));
    const t = load(photos, { hangNames: ['p0.jpg'] });
    await t.uploader.pump();
    await new Promise((r) => setTimeout(r, 80));
    const asked = t.sessionAsked.flat();
    assertEqual(asked.length >= 12, true,
      '★ 12 張都要被嘗試到（實際 ' + asked.length + '）—— 卡住那張不可以擋住後面');
    const linked = Array.from(t.store.values()).filter((p) => p.status === 'linked').length;
    assertEqual(linked, 11, '★ 其餘 11 張都要傳完並寫回連結');
    assertEqual(t.store.get('ph_1000').status, 'pending', '卡住那張留著重試，不可刪');
  }

  // ===== 4. 沒卡住的情況不可以被誤傷 =====
  {
    const t = load([photo(0), photo(1)], {});
    await t.uploader.pump();
    await new Promise((r) => setTimeout(r, 60));
    assertEqual(t.aborted, [], '正常上傳不可以被 abort');
    assertEqual(Array.from(t.store.values()).every((p) => p.status === 'linked'), true, '兩張都要完成');
  }

  // ===== 5. 原始碼層面 =====
  assertEqual(/signal: ctrl\.signal,/.test(UP), true, '★ PUT 一定要帶 signal');
  assertEqual(/const timer = setTimeout\(\(\) => ctrl\.abort\(\), PUT_TIMEOUT_MS\);/.test(UP), true,
    '★ 一定要有計時器去 abort');
  assertEqual(/const data = await res\.json\(\);/.test(UP), true, '前提：仍要讀回應內容');
  {
    // 計時器必須涵蓋讀取回應：連線掛在讀 body 的階段一樣是卡住
    const i = UP.indexOf('const timer = setTimeout(() => ctrl.abort(), PUT_TIMEOUT_MS);');
    const seg = UP.slice(i, UP.indexOf('clearTimeout(timer);', i));
    assertEqual(/await res\.json\(\)/.test(seg), true,
      '★ res.json() 要在 clearTimeout 之前 —— 否則卡在讀 body 那一段仍然無界');
  }
  assertEqual(/function withWatchdog\(promise, ms, message\)/.test(UP), true, '要有看門狗');
  assertEqual(/phase\('上傳中：'/.test(UP), true, '★ 要能看出卡在哪一步（現場只有一個灰掉的按鈕，毫無線索）');
  assertEqual(/目前狀態：\{pendingUp\.busy \? \(pendingUp\.phase \|\| '進行中…'\) : '閒置'\}/.test(APP), true,
    '★ 診斷視窗要把它顯示出來');

  console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
  process.exit(failed ? 1 : 0);
})();
