/**
 * 回歸測試：隊首的壞照片不可以擋住後面的照片。
 *
 * 2026-09-03 現場實證：一位同事的佇列 98 筆（佔用 73 MB），其中約 30 張
 * 「還沒進雲端、tries=0、沒有任何錯誤訊息」—— 也就是**從來沒有被嘗試過**。
 * 另一位同事的隊首是 8/27 的照片，重試次數從 8/31 到 9/2 完全沒動過，
 * 錯誤訊息還停在「逾時未回應（12 秒）」（那是 8/31 之前的版本才會寫出的字串）。
 *
 * 成因是三件事湊在一起：
 *   1. pendingPhotos() 走 byStatus 索引的 getAll，依主鍵排序，
 *      而 id = 'ph_' + Date.now() + '_' + rand → 永遠是最舊的在最前面
 *   2. pend.slice(0, BATCH) 每輪只取最前面 6 張
 *   3. 那批裡只要有一張「連狀態都寫不回去」，就 break 掉整個 while 迴圈
 * → 一張壞照片永久霸佔隊首，後面幾十張永遠碰不到。
 * 那位同事刪掉紀錄重傳也沒用，因為刪紀錄不會移除隊首那張。
 *
 * 那個 break 是我 2026-08-31 為了修「無限迴圈」加的 —— 等於用永久阻塞
 * 換掉了無限迴圈。所以這支測試必須同時守住兩個方向：
 *   ・隊首壞掉時，後面的照片一定要被嘗試到（否則就是阻塞）
 *   ・不可以變成無限迴圈（否則就是回到 8/31 之前）
 *
 * 執行方式：node backend/test/headOfLine.test.js
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

/**
 * 載入 uploader.js。
 * badIds：這些照片的 updatePhoto 一律失敗（模擬「連狀態都寫不回去」）。
 * uploadFails：這些照片的 PUT 一律失敗。
 */
function load(photos, opts) {
  const o = opts || {};
  const badIds = new Set(o.badIds || []);
  const uploadFails = new Set(o.uploadFails || []);
  const store = new Map(photos.map((p) => [p.id, { ...p }]));
  const sessionAsked = [];   // 每一輪向後端要了哪些檔名（＝真的被嘗試的那些）
  const puts = [];
  let writes = 0;

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    // uploader.js 的 PUT 現在有 AbortController 逾時（瀏覽器一定有，
    // 但 vm 沙箱預設沒有）—— 沒有它會讓 uploadOne 在第一行就 ReferenceError，
    // 而那會被誤讀成「上傳失敗」。
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
      if (uploadFails.has(name)) throw new Error('Load failed');
      return { ok: true, status: 200, json: async () => ({ id: 'F_' + name }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.SqcApi = {
    // 用 url 的 hash 帶檔名，讓假的 fetch 知道這次是哪一張
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
    updatePhoto: async (p) => {
      writes++;
      if (badIds.has(p.id)) throw new Error('Error preparing Blob/File data to be stored in object store');
      store.set(p.id, { ...p });
    },
    delPhoto: async (id) => { store.delete(id); },
    getPhoto: async (id) => { const p = store.get(id); return p ? { ...p } : null; },
    allPhotos: async () => Array.from(store.values()),
    // ★ 真實行為：依主鍵（id）排序，最舊的在最前面 —— 這正是隊首阻塞的前提
    pendingPhotos: async () => Array.from(store.values())
      .filter((p) => p.status === 'pending')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    photosOfRecord: async (rid) => Array.from(store.values()).filter((p) => p.recordId === rid),
    photoDiagnostics: async () => Array.from(store.values()).map((p) => ({
      id: p.id, name: p.name, status: p.status, recordId: p.recordId,
      tries: p.tries || 0, error: p.error || '', reported: !!p.reported,
      blobSize: (p.blob && p.blob.size) || 0,
    })),
    eachPhoto: async (fn, status) => {
      for (const id of Array.from(store.keys())) {
        const p = store.get(id);
        if (!p) continue;
        if (status !== undefined && p.status !== status) continue;
        await fn({ ...p });
      }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(UP, sandbox, { filename: 'uploader.js' });
  return { uploader: sandbox.SqcUploader, store, sessionAsked, puts, writes: () => writes };
}

// id 用固定寬度的序號，字典序＝加入順序（真實情況是 'ph_'+時間戳，同樣性質）
const photo = (n, over) => ({
  id: 'ph_' + String(1000 + n), name: 'p' + n + '.jpg', status: 'pending',
  recordId: 'R' + Math.floor(n / 6), month: '11509', pathParts: ['115年09月', '1.招牌'],
  blob: { size: 900000 }, tries: 0, ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 40));

(async () => {
  // ===== 1. ★ 隊首一張「狀態寫不回去」的照片，不可擋住後面 30 張 =====
  {
    const photos = [];
    for (let i = 0; i < 31; i++) photos.push(photo(i));
    const headId = photos[0].id;
    // 隊首那張：上傳失敗、而且連狀態都寫不回去（現場那張 Load failed 的紙本照片）
    const t = load(photos, { badIds: [headId], uploadFails: ['p0.jpg'] });

    await t.uploader.pump();
    await settle();

    const asked = t.sessionAsked.flat();
    assertEqual(asked.indexOf('p0.jpg') >= 0, true, '前提：隊首那張確實被嘗試了');
    assertEqual(asked.length >= 31, true,
      '★ 後面 30 張都必須被嘗試到（實際 ' + asked.length + ' 張）—— 這就是現場那 30 張「從來沒被嘗試過」的成因');

    const linked = Array.from(t.store.values()).filter((p) => p.status === 'linked').length;
    assertEqual(linked, 30, '★ 除了壞掉那張，其餘 30 張都要傳完並寫回連結');
    assertEqual(t.store.get(headId).status, 'pending', '壞掉那張仍留在佇列，狀態沒被改掉');
    assertEqual(!!t.store.get(headId).blob, true, '★ 絕對不可以把它刪掉或清掉內容 —— 照片拍不回來');

    // 它要被記進跳過名單，而且原因要看得到
    const skip = t.uploader.skipped();
    assertEqual(Object.keys(skip), [headId], '★ 壞掉那張要進跳過名單');
    assertEqual(/Blob/.test(skip[headId] || ''), true, '要保留原因，診斷視窗才顯示得出來');
  }

  /**
   * ===== 1b. ★ 儲存層整體寫不進去時，後面的仍然要被嘗試到 =====
   *
   * 這才是現場的條件：診斷畫面上那行「整體錯誤」代表寫入失敗是整層的、不是單張的。
   * 而 safeUpdate 成功時會把 _storeBroken 清掉，所以同一批只要有一張寫成功，
   * 舊的 break 就不會觸發 —— 反而是「整批都寫不進去」這種最嚴重的情況
   * 才會把後面全部擋住。（我第一版的測試只讓一張寫入失敗，因此漏掉了這個情境。）
   *
   * 修好之後的行為：全部嘗試一次、全部進跳過名單，之後的 pump 就不再浪費流量。
   * 舊行為是每輪白白重傳前 6 張、永遠不停，而後面 25 張永遠碰不到。
   */
  {
    const photos = [];
    for (let i = 0; i < 31; i++) photos.push(photo(i));
    const t = load(photos, { badIds: photos.map((p) => p.id) });   // 所有寫入都失敗

    await t.uploader.pump();
    await settle();

    const asked = t.sessionAsked.flat();
    assertEqual(asked.length, 31,
      '★ 整層寫不進去時，31 張都要被嘗試到（舊行為只會試前 6 張就 break）；實際 ' + asked.length + ' 張');
    assertEqual(Object.keys(t.uploader.skipped()).length, 31, '全部進跳過名單');
    assertEqual(t.store.size, 31, '一張都不可以少');

    // 下一輪不可以再浪費流量（舊行為是每 15 秒重傳同樣那 6 張）
    const before = t.sessionAsked.flat().length;
    await t.uploader.pump();
    await settle();
    assertEqual(t.sessionAsked.flat().length, before,
      '★ 下一輪不再重試已跳過的 —— 舊行為永遠在白白重傳同樣那 6 張');
  }

  // ===== 2. ★ 不可以變成無限迴圈（這是我當初加 break 的原因）=====
  {
    // 三張都寫不回狀態：迴圈必須靠跳過名單收斂，而不是靠 break
    const photos = [photo(0), photo(1), photo(2)];
    const t = load(photos, {
      badIds: photos.map((p) => p.id),
      uploadFails: ['p0.jpg', 'p1.jpg', 'p2.jpg'],
    });
    const done = await Promise.race([
      t.uploader.pump().then(() => 'finished'),
      new Promise((r) => setTimeout(() => r('timeout'), 4000)),
    ]);
    assertEqual(done, 'finished', '★ 全部寫不回狀態時 pump 仍要結束（不可無限迴圈）');
    assertEqual(Object.keys(t.uploader.skipped()).length, 3, '三張都要進跳過名單');
    assertEqual(t.store.size, 3, '三張都還在，一張都不可以少');
  }

  // ===== 3. 跳過名單只在本次工作階段有效 =====
  {
    const photos = [photo(0), photo(1)];
    const t = load(photos, { badIds: [photos[0].id], uploadFails: ['p0.jpg'] });
    await t.uploader.pump();
    await settle();
    const asked1 = t.sessionAsked.flat().filter((n) => n === 'p0.jpg').length;
    await t.uploader.pump();
    await settle();
    const asked2 = t.sessionAsked.flat().filter((n) => n === 'p0.jpg').length;
    assertEqual(asked2, asked1, '同一個工作階段內不再重複嘗試被跳過的那張（省電、省流量）');

    // 換一個工作階段（重新載入 uploader）→ 要重新給它一次機會
    const t2 = load(Array.from(t.store.values()), { badIds: [photos[0].id], uploadFails: ['p0.jpg'] });
    await t2.uploader.pump();
    await settle();
    assertEqual(t2.sessionAsked.flat().indexOf('p0.jpg') >= 0, true,
      '★ 下次開 App 要再試一次 —— 當時環境好轉就會成功，不可以永久放棄');
  }

  // ===== 4. ★ 一張傳不上去，不可以擋住同一筆其餘照片的連結回寫 =====
  {
    // 同一個 recordId：一張 pending 且上傳失敗，兩張正常
    const bad = { ...photo(0), recordId: 'R1' };
    const ok1 = { ...photo(1), recordId: 'R1' };
    const ok2 = { ...photo(2), recordId: 'R1' };
    const t = load([bad, ok1, ok2], { uploadFails: ['p0.jpg'] });
    await t.uploader.pump();
    await settle();
    assertEqual(t.store.get(ok1.id).status, 'linked',
      '★ 其餘照片的連結要寫得回去（現場有一筆是 6 張已在雲端卻一直停在待寫連結）');
    assertEqual(t.store.get(ok2.id).status, 'linked', '同上');
    assertEqual(t.store.get(bad.id).status, 'pending', '失敗那張繼續留在佇列重試');
    assertEqual((t.store.get(bad.id).tries || 0) > 0, true, '而且要記次退避');
  }

  // ===== 5. 原始碼層面：兩個必須成立的條件 =====
  /**
   * 「不可再出現某段舊寫法」一定要先去掉註解 —— 說明「原本錯在哪」的註解本身
   * 就會引用那段舊寫法，不去掉就會命中自己的註解，看起來像永遠沒修好。
   * （今天已經因此誤判四次，這是同一個坑。）
   */
  const code = UP
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
  assertEqual(/if \(_storeBroken\) \{ emit\(\); break; \}/.test(code), false,
    '★ 不可再有「寫不回狀態就 break 整個迴圈」—— 那正是隊首阻塞的直接成因');
  // 前提：確認去註解沒把程式碼一起刪掉（否則上面那條會假通過）
  assertEqual(/_storeBroken/.test(code), true, '前提：_storeBroken 本身還在（只是不再用來 break）');
  assertEqual(/if \(_storeBroken\) \{ emit\(\); break; \}/.test(UP), true,
    '前提：原始碼的註解裡確實還引用著那行舊寫法，證明上面那條靠的是去註解');
  assertEqual(/if \(!ok\) _skip\.set\(p\.id, _storeBroken/.test(UP), true,
    '★ 寫不回狀態要進跳過名單（迴圈靠這個收斂）');
  assertEqual(/if \(list\.some\(\(p\) => p\.status !== 'done' && p\.status !== 'linked'\)\) return;/.test(UP), false,
    '★ 不可再要求「整筆都完成」才回寫連結');
  assertEqual(/async function reportSkipped\(\)/.test(UP), true,
    '★ 被跳過的要另外回報 —— reportStuck 的門檻是 tries>=10，而這些的 tries 永遠累加不上去');
  assertEqual(/const skipped = \(\) =>/.test(UP), true, '要對外公開跳過名單，診斷視窗才顯示得出來');

  console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
  process.exit(failed ? 1 : 0);
})();
