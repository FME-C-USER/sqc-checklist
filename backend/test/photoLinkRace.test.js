// 回歸測試：照片上傳完成得比「紀錄送出」更早時，連結回寫不可被誤標為完成
//   照片是在 submitRecord 之前就開始背景上傳的，所以 attachPhotoLinks 可能在紀錄還不存在時就被呼叫，
//   後端會回 { ok:false, message:'找不到紀錄' }。此時必須維持 done 等下輪重送，
//   若誤標成 linked，該筆紀錄的照片連結就永久遺失（報表永遠看不到連結）。
// 執行方式：node backend/test/photoLinkRace.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

/**
 * 載入 uploader.js，注入假的 SqcApi/SqcDB。
 *   recordExists   —— 控制 attachPhotoLinks 時後端是否已有該筆紀錄（連結回寫用）
 *   recordOnServer —— 控制 API 的 recordExists 路由；不傳 = 模擬舊後端沒有這支
 */
function loadUploader({ recordExists, sessionFails, existingIds, linkNetworkFails, queryRecords, submitRecord, recordOnServer }) {
  sessionFails = sessionFails || (() => false);
  existingIds = existingIds || (() => ({}));
  linkNetworkFails = linkNetworkFails || (() => false);
  const photos = new Map();
  const calls = [];
  const uploads = [];
  const sessionArgs = [];
  const queryCalls = [];
  const existsCalls = [];
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    navigator: { onLine: true },
    Blob: class { constructor(parts) { this.parts = parts; } },
    fetch: async (url, init) => {
      uploads.push({ url, init });   // 供驗證：瀏覽器端不可帶 Authorization 標頭
      return { ok: true, json: async () => ({ id: 'FILE_' + uploads.length }) };
    },
    document: { addEventListener: () => {}, visibilityState: 'visible' },
    location: { origin: 'https://fme-c-user.github.io' },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.SqcApi = {
    // 後端只回單檔上傳網址，不再回傳 OAuth 權杖
    queryRecords: async (month, filter) => {
      queryCalls.push({ month, filter });
      return queryRecords ? queryRecords(month, filter) : { records: [] };
    },
    /**
     * 只讀「紀錄ID」一欄的輕量確認。傳 recordOnServer=null 表示模擬「後端還是舊版、沒有這支」。
     * 待送佇列在重送前用它取代 queryRecords —— queryRecords 會讀整張活頁，
     * 送出逾時的人越多、待送佇列越多，全表讀取就越頻繁，後端被自己的重試拖垮。
     */
    recordExists: async (month, id) => {
      if (!recordOnServer) throw new Error('未知動作：recordExists');
      existsCalls.push({ month, id });
      return { exists: recordOnServer(id) };
    },
    submitRecord: async (rec) => (submitRecord ? submitRecord(rec) : { ok: true }),
    createUploadSessions: async (items, origin) => {
      sessionArgs.push({ items, origin });
      if (sessionFails()) throw new Error('未知動作：createUploadSessions');   // 模擬後端尚未部署新版
      return {
        sessions: items.map((it, i) => (existingIds()[it.name]
          ? { ok: true, existing: true, fileId: existingIds()[it.name] }        // 後端說這張已經在 Drive 裡了
          : { ok: true, url: 'https://upload.example/session/' + i + '?name=' + it.name })),
      };
    },
    attachPhotoLinks: async (month, recordId, links) => {
      calls.push({ month, recordId, links });
      if (linkNetworkFails()) throw new Error('網路連線中斷，請稍後再試');
      // 模擬後端：紀錄還不存在時回 ok:false（envelope 層是成功的，所以不會 throw）
      return recordExists() ? { ok: true } : { ok: false, message: '找不到紀錄' };
    },
  };
  const recordQueue = new Map();
  sandbox.SqcDB = {
    countPhotos: async (st) => Array.from(photos.values()).filter((p) => st === undefined || p.status === st).length,
    queueRecord: async (r) => { recordQueue.set(r.id, { ...r }); },
    delQueuedRecord: async (id) => { recordQueue.delete(id); },
    pendingRecords: async () => Array.from(recordQueue.values()).filter((r) => r.status === 'pending'),
    addPhoto: async (p) => { photos.set(p.id, { ...p }); },
    updatePhoto: async (p) => { photos.set(p.id, { ...p }); },
    allPhotos: async () => Array.from(photos.values()),
    pendingPhotos: async () => Array.from(photos.values()).filter((p) => p.status === 'pending'),
    photosOfRecord: async (rid) => Array.from(photos.values()).filter((p) => p.recordId === rid),
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'uploader.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'uploader.js' });
  return { uploader: sandbox.SqcUploader, photos, calls, uploads, sessionArgs, recordQueue, api: sandbox.SqcApi, queryCalls, existsCalls };
}

// enqueue() 內部會自行觸發一次未 await 的 pump()，且 pump 有 _running 互斥鎖，
// 直接連續呼叫會被鎖擋掉而讀到過早的狀態 → 等背景那輪跑完再驗證
const settle = () => new Promise((r) => setTimeout(r, 300));

(async () => {
  // ===== 情境1：照片比紀錄更早完成（後端回「找不到紀錄」）=====
  let exists = false;
  const { uploader, photos, calls, uploads, sessionArgs } = loadUploader({ recordExists: () => exists });
  await uploader.enqueue({ blob: new Blob(['b']), name: 'a.jpg', pathParts: ['115年08月', '1.店外海報', '缺失'], recordId: 'R1', month: '11508' });
  await settle();

  let all = Array.from(photos.values());
  assertEqual(all.length, 1, '應有1張照片');
  assertEqual(all[0].status, 'done', '紀錄還不存在時，照片應維持 done（不可標記 linked，否則連結永久遺失）');
  assertEqual(all[0].fileId, 'FILE_1', '照片本身應已上傳成功並取得 fileId');
  assertEqual(calls.length >= 1, true, '應已嘗試呼叫過 attachPhotoLinks');

  // ===== 資安：照片是 PUT 到後端給的工作階段網址，瀏覽器端不得持有任何權杖 =====
  assertEqual(uploads.length, 1, '應對 Drive 發出1次上傳請求');
  assertEqual(uploads[0].init.method, 'PUT', '可續傳上傳應以 PUT 寫入');
  assertEqual(uploads[0].url.indexOf('https://upload.example/session/') === 0, true, '應上傳到後端指定的工作階段網址');
  const hdrs = Object.keys(uploads[0].init.headers || {}).map((k) => k.toLowerCase());
  assertEqual(hdrs.indexOf('authorization') === -1, true, '瀏覽器端不可帶 Authorization 標頭（權杖不得外流）');
  assertEqual(JSON.stringify(uploads[0].init).toLowerCase().indexOf('bearer') === -1, true, '上傳請求任何欄位都不應出現 Bearer 權杖');

  // ===== 情境2：紀錄送出完成後，下一輪 pump 應自動補寫連結成功 =====
  // 回寫失敗會設退避時間(首次1.5秒)，等過了退避才會真的重送
  exists = true;
  await new Promise((r) => setTimeout(r, 1700));
  await uploader.pump();
  await settle();
  all = Array.from(photos.values());
  assertEqual(all[0].status, 'linked', '紀錄存在後，下一輪應成功回寫並標記 linked');
  const last = calls[calls.length - 1];
  assertEqual(last.recordId, 'R1', '重送的紀錄ID應正確');
  assertEqual(last.month, '11508', '重送的月份應正確（月份需隨照片一起帶著）');
  assertEqual(last.links['115年08月/1.店外海報/缺失'], [{ name: 'a.jpg', fileId: 'FILE_1' }], '回寫的連結內容應正確');

  // ===== 情境3：已 linked 的照片不應再重複回寫 =====
  const before = calls.length;
  await uploader.pump();
  await settle();
  assertEqual(calls.length, before, '已回寫過的照片不應重複呼叫 attachPhotoLinks');

  // ===== 情境4：紀錄永遠不存在(例如送出失敗)時要放棄，不可無限每輪重送佔用後端 =====
  const b = loadUploader({ recordExists: () => false });
  await b.uploader.enqueue({ blob: new Blob(['b']), name: 'z.jpg', pathParts: ['115年08月', 'X'], recordId: 'GHOST', month: '11508' });
  await settle();
  for (let i = 0; i < 30; i++) {                     // 反覆觸發遠超過放棄上限的次數
    const p = Array.from(b.photos.values())[0];
    b.photos.set(p.id, { ...p, linkNextAt: 0 });     // 先清掉退避時間，直接測「放棄上限」邏輯
    await b.uploader.pump();
    await new Promise((r) => setTimeout(r, 20));
  }
  const ghost = Array.from(b.photos.values())[0];
  assertEqual(ghost.status, 'orphan', '重試達上限後應標記 orphan 並停止重送');
  assertEqual(b.calls.length <= 20, true, `重送次數應被上限擋住(實際 ${b.calls.length} 次)`);

  // ===== 情境5：後端還沒部署新版(取不到上傳網址)時，照片必須留在佇列等重試，不可遺失 =====
  //   前端與後端無法同時更新，中間必然有空窗；這段期間照片只能延後上傳，絕不能被丟掉。
  let apiBroken = true;
  const c = loadUploader({ recordExists: () => true, sessionFails: () => apiBroken });
  await c.uploader.enqueue({ blob: new Blob(['b']), name: 'gap.jpg', pathParts: ['115年08月', 'Y'], recordId: 'R9', month: '11508' });
  await settle();
  let gap = Array.from(c.photos.values())[0];
  assertEqual(gap.status, 'pending', '取不到上傳網址時照片應維持 pending（留在佇列裡）');
  assertEqual(gap.tries, 1, '應記一次失敗次數以便退避');
  assertEqual(gap.nextAt > Date.now(), true, '應設下次重試時間，不可密集重打後端');
  assertEqual(c.uploads.length, 0, '沒有上傳網址時不應對 Drive 發出任何請求');

  apiBroken = false;                                   // 後端部署完成
  c.photos.set(gap.id, { ...gap, nextAt: 0 });         // 略過退避等待，直接驗證恢復行為
  await c.uploader.pump();
  await settle();
  gap = Array.from(c.photos.values())[0];
  assertEqual(gap.fileId, 'FILE_1', '後端恢復後同一張照片應成功上傳（沒有遺失）');
  assertEqual(gap.status, 'linked', '恢復後連結也應成功回寫');

  // ===== 情境6：後端回報「這張已在 Drive」時，不可再上傳一次（否則重試會產生重複檔案）=====
  //   2026-08-20 的 CORS 失敗就是這種情形：Drive 已寫入成功(200)，但瀏覽器讀不到回應而重試。
  const d = loadUploader({ recordExists: () => true, existingIds: () => ({ 'dup.jpg': 'ALREADY_IN_DRIVE' }) });
  await d.uploader.enqueue({ blob: new Blob(['b']), name: 'dup.jpg', pathParts: ['115年08月', 'Z'], recordId: 'R7', month: '11508' });
  await settle();
  const dup = Array.from(d.photos.values())[0];
  assertEqual(d.uploads.length, 0, '已存在的照片不應再對 Drive 發出上傳請求');
  assertEqual(dup.fileId, 'ALREADY_IN_DRIVE', '應直接認領 Drive 上既有的檔案');
  assertEqual(dup.status, 'linked', '認領後仍要正常回寫連結');
  assertEqual(d.sessionArgs[0].origin, 'https://fme-c-user.github.io', '必須把自己的 origin 送給後端（Drive 的 CORS 要求）');

  // ===== 情境7：網路錯誤不可計入「放棄」次數 =====
  //   門市現場網路不良是常態。若把網路失敗也算進 20 次上限，連續不良約 5 分鐘就會永久放棄回寫，
  //   照片在 Drive 但報表永遠點不到（2026-08-20 檢視時發現的缺口）。
  let netDown = true;
  const e = loadUploader({ recordExists: () => true, linkNetworkFails: () => netDown });
  await e.uploader.enqueue({ blob: new Blob(['b']), name: 'net.jpg', pathParts: ['115年08月', 'N'], recordId: 'R5', month: '11508' });
  await settle();
  for (let i = 0; i < 40; i++) {                       // 遠超過 20 次上限
    const p = Array.from(e.photos.values())[0];
    e.photos.set(p.id, { ...p, linkNextAt: 0 });
    await e.uploader.pump();
    await new Promise((r) => setTimeout(r, 10));
  }
  let net = Array.from(e.photos.values())[0];
  assertEqual(net.status, 'done', '網路錯誤重試 40 次後仍不可變成 orphan（要一直等網路恢復）');
  assertEqual(net.linkTries || 0, 0, '網路錯誤不可累加「紀錄不存在」的放棄計數');
  assertEqual(net.netTries > 0, true, '網路錯誤應另計數，用來拉長退避');
  assertEqual(net.linkNextAt > Date.now(), true, '網路不良時應等久一點再試，不可空轉');

  netDown = false;                                     // 網路恢復
  net = Array.from(e.photos.values())[0];
  e.photos.set(net.id, { ...net, linkNextAt: 0 });
  await e.uploader.pump();
  await settle();
  assertEqual(Array.from(e.photos.values())[0].status, 'linked', '網路恢復後應成功補寫連結');

  // ===== 情境8：送出失敗的紀錄要自動重送，且不可變成兩筆 =====
  const submitted = [];
  let onServer = false;
  const QREC = { id: 'RQ1', status: 'pending', month: '11508', tries: 0, record: { id: 'RQ1', time: '2026-08-20 10:00' } };
  const f = loadUploader({
    recordExists: () => true,
    recordOnServer: (id) => onServer && id === 'RQ1',
    queryRecords: async () => ({ records: onServer ? [{ id: 'RQ1' }] : [] }),
    submitRecord: async (rec) => { submitted.push(rec); onServer = true; return { ok: true }; },
  });
  await f.api.__noop;
  // 模擬 app.html 在送出前排入佇列、但送出當下失敗
  await f.recordQueue.set('RQ1', { ...QREC });
  await f.uploader.pumpRecords();
  assertEqual(submitted.length, 1, '待送佇列裡的紀錄應被自動重送');
  assertEqual(f.recordQueue.size, 0, '重送成功後應從佇列移除');

  // 已經在後端存在時不可再送一次（避免白白佔用後端的鎖）
  submitted.length = 0;
  onServer = true;
  f.recordQueue.set('RQ1', { ...QREC });
  await f.uploader.pumpRecords();
  assertEqual(submitted.length, 0, '後端已有同一筆(相同紀錄ID)時不可重複送出');
  assertEqual(f.recordQueue.size, 0, '確認已存在後應把佇列清掉');

  /**
   * ★ 確認這件事必須用只讀一欄的 recordExists，不可以再用 queryRecords。
   *
   * queryRecords 的後端實作第一行就是讀整張活頁，from/to 是讀完才過濾的 ——
   * 送出逾時的人越多、待送佇列越多、全表讀取就越頻繁，後端被自己的重試機制拖垮，
   * 於是更多人逾時。2026-08-28 現場多人同時卡住就是這個正回饋迴圈。
   */
  assertEqual(f.existsCalls.length, 2, '每次重送前都要先用 recordExists 確認');
  assertEqual(f.existsCalls[0].id, 'RQ1', '要帶紀錄ID 過去');
  assertEqual(f.queryCalls.length, 0, '★ 不可再用 queryRecords 做這個確認（那會讀整張活頁）');

  /**
   * 後端還是舊版、沒有 recordExists 這支時：跳過確認直接送。
   * 這樣安全，因為 submitRecord 本身是等冪的 —— 同一個紀錄ID 只會回 {resent:true}，
   * 不會寫成第二列（見 程式碼.gs 的 sameId 判斷）。確認只是省一次寫入嘗試，
   * 不是正確性的必要條件；不可以因為確認失敗就把紀錄卡在佇列裡送不出去。
   */
  const oldSubmitted = [];
  const h = loadUploader({
    recordExists: () => true,
    // 不傳 recordOnServer → API 的 recordExists 會丟「未知動作」
    submitRecord: async (rec) => { oldSubmitted.push(rec); return { ok: true, resent: true }; },
  });
  h.recordQueue.set('RQ3', { id: 'RQ3', status: 'pending', month: '11508', tries: 0, record: { id: 'RQ3', time: '2026-08-20 10:00' } });
  await h.uploader.pumpRecords();
  assertEqual(oldSubmitted.length, 1, '舊後端沒有 recordExists 時要照送，不可卡住');
  assertEqual(h.queryCalls.length, 0, '舊後端也不可退回去讀整張活頁');
  assertEqual(h.recordQueue.size, 0, '送出成功後要從佇列移除');

  // 後端明確拒絕(例如同店本月已有紀錄) → 標記 blocked，不再無限重送
  const g = loadUploader({
    recordExists: () => true,
    recordOnServer: () => false,
    queryRecords: async () => ({ records: [] }),
    submitRecord: async () => ({ ok: false, message: '同店本月已有紀錄' }),
  });
  g.recordQueue.set('RQ2', { id: 'RQ2', status: 'pending', month: '11508', tries: 0, record: { id: 'RQ2', time: '2026-08-20 10:00' } });
  await g.uploader.pumpRecords();
  assertEqual(g.recordQueue.get('RQ2').status, 'blocked', '後端明確拒絕時應標記 blocked，不再重送');
  assertEqual(g.recordQueue.get('RQ2').err.indexOf('同店') >= 0, true, '應保留後端的拒絕原因供人工判斷');

  console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
})();
