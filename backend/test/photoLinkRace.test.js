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

/** 載入 uploader.js，注入假的 SqcApi/SqcDB；recordExists 控制後端是否已有該筆紀錄 */
function loadUploader({ recordExists }) {
  const photos = new Map();
  const calls = [];
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    navigator: { onLine: true },
    Blob: class { constructor(parts) { this.parts = parts; } },
    fetch: async () => ({ ok: true, json: async () => ({ id: 'FILE_' + (calls.length + 1) }) }),
    document: { addEventListener: () => {}, visibilityState: 'visible' },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.SqcApi = {
    getDriveToken: async () => ({ token: 'tok' }),
    getUploadFolderId: async () => ({ folderId: 'folder1' }),
    attachPhotoLinks: async (month, recordId, links) => {
      calls.push({ month, recordId, links });
      // 模擬後端：紀錄還不存在時回 ok:false（envelope 層是成功的，所以不會 throw）
      return recordExists() ? { ok: true } : { ok: false, message: '找不到紀錄' };
    },
  };
  sandbox.SqcDB = {
    addPhoto: async (p) => { photos.set(p.id, { ...p }); },
    updatePhoto: async (p) => { photos.set(p.id, { ...p }); },
    allPhotos: async () => Array.from(photos.values()),
    pendingPhotos: async () => Array.from(photos.values()).filter((p) => p.status === 'pending'),
    photosOfRecord: async (rid) => Array.from(photos.values()).filter((p) => p.recordId === rid),
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'uploader.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'uploader.js' });
  return { uploader: sandbox.SqcUploader, photos, calls };
}

// enqueue() 內部會自行觸發一次未 await 的 pump()，且 pump 有 _running 互斥鎖，
// 直接連續呼叫會被鎖擋掉而讀到過早的狀態 → 等背景那輪跑完再驗證
const settle = () => new Promise((r) => setTimeout(r, 300));

(async () => {
  // ===== 情境1：照片比紀錄更早完成（後端回「找不到紀錄」）=====
  let exists = false;
  const { uploader, photos, calls } = loadUploader({ recordExists: () => exists });
  await uploader.enqueue({ blob: 'b', name: 'a.jpg', pathParts: ['115年08月', '1.店外海報', '缺失'], recordId: 'R1', month: '11508' });
  await settle();

  let all = Array.from(photos.values());
  assertEqual(all.length, 1, '應有1張照片');
  assertEqual(all[0].status, 'done', '紀錄還不存在時，照片應維持 done（不可標記 linked，否則連結永久遺失）');
  assertEqual(all[0].fileId, 'FILE_1', '照片本身應已上傳成功並取得 fileId');
  assertEqual(calls.length >= 1, true, '應已嘗試呼叫過 attachPhotoLinks');

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
  await b.uploader.enqueue({ blob: 'b', name: 'z.jpg', pathParts: ['115年08月', 'X'], recordId: 'GHOST', month: '11508' });
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

  console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
})();
