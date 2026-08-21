// 回歸測試：編輯紀錄時檢視/刪除既有照片
//   照片存在腳本擁有者的 Drive 資料夾，其他登入者沒有檢視權，所以縮圖與原圖一律由後端代取；
//   刪除只做「移入垃圾桶」(可還原)，不永久刪除。
//   另驗證照片檔名序號取「既有最大+1」——刪掉中間某張再新增若撞名，後端的冪等機制會
//   誤認為同一張而去認領舊檔，新照片就永遠傳不上去。
// 執行方式：node backend/test/photoView.test.js
const path = require('path');
const vm = require('vm');
const fs = require('fs');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
const APP_PATH = path.join(__dirname, '..', '..', 'app.html');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 假的 Drive 檔案 =====
//   thumb=null 模擬「沒有縮圖」(改用原圖)；big=true 模擬過大檔案
const files = {
  LIVE: { name: 'a.jpg', thumb: 'THUMB_A', bytes: 500000 },
  NOTHUMB: { name: 'b.jpg', thumb: null, bytes: 900000 },
  HUGE: { name: 'c.jpg', thumb: null, bytes: 9000000 },
  GONE: { name: 'd.jpg', thumb: 'THUMB_D', bytes: 100, trashed: true },
};
const blobOf = (text, n) => ({
  getContentType: () => 'image/jpeg',
  getBytes: () => ({ length: n, __text: text }),
});
const { ctx } = loadGasFile(GS_PATH);
ctx.DriveApp = {
  getFileById: (id) => {
    const f = files[id];
    if (!f) throw new Error('File not found: ' + id);
    return {
      getName: () => f.name,
      isTrashed: () => !!f.trashed,
      setTrashed: (v) => { f.trashed = !!v; },
      getThumbnail: () => { if (!f.thumb) throw new Error('no thumbnail'); return blobOf(f.thumb, 8000); },
      getBlob: () => blobOf('FULL_' + id, f.bytes),
    };
  },
  getFolderById: () => ({ getFilesByName: () => ({ hasNext: () => false }) }),
};
ctx.ScriptApp = { getOAuthToken: () => 'tok' };
ctx.Utilities.base64Encode = (b) => 'B64(' + (b && b.__text) + ')';
const cache = {};
ctx.CacheService = { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null }) };
ctx.ContentService = { createTextOutput: (s) => ({ __text: s, setMimeType: () => ({ __text: s }) }), MimeType: { JSON: 'json' } };
ctx.UrlFetchApp = { fetch: () => ({ getContentText: () => JSON.stringify({ MSG: '000 OK' }) }) };
vm.runInContext(fs.readFileSync(GS_PATH, 'utf8'), ctx, { filename: GS_PATH });

ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.ensureMonth('11508');
ctx.upsertRow('staff', null, { 部別: '一部', 課別: '北一課', 工號: '1', 姓名: '趙千皓', AD帳號: 'zhao', 角色: '' });
const token = ctx.login('zhao', 'pw').user.token;
const post = (action, payload, tk) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ action, token: tk, payload }) } }).__text);

// ===== 1. 縮圖 =====
const th = post('getPhotoThumbs', { fileIds: ['LIVE', 'NOTHUMB', 'HUGE', 'GONE', 'NOT_EXIST'] }, token);
assertEqual(th.ok, true, '取縮圖應成功回應');
assertEqual(th.result.thumbs.LIVE, 'data:image/jpeg;base64,B64(THUMB_A)', '有縮圖就用縮圖');
assertEqual(th.result.thumbs.NOTHUMB, 'data:image/jpeg;base64,B64(FULL_NOTHUMB)', '沒有縮圖時改用原圖（本系統照片已壓到1.2MB內）');
assertEqual(th.result.thumbs.HUGE, '', '過大的檔案不回傳，避免整包爆掉');
assertEqual(th.result.thumbs.GONE, '', '已在垃圾桶的照片不給圖（前端會標示）');
assertEqual(th.result.thumbs.NOT_EXIST, '', '檔案不存在時回空字串，不可讓整個請求失敗');

const many = post('getPhotoThumbs', { fileIds: Array.from({ length: 60 }, () => 'LIVE') }, token);
assertEqual(Object.keys(many.result.thumbs).length, 1, '重複的 fileId 只會有一個鍵');

// ===== 2. 原圖（點擊放大）=====
const img = post('getPhotoImage', { fileId: 'LIVE' }, token);
assertEqual(img.result.ok, true, '取原圖應成功');
assertEqual(img.result.dataUrl, 'data:image/jpeg;base64,B64(FULL_LIVE)', '應回傳原圖內容');
assertEqual(img.result.name, 'a.jpg', '應帶出檔名供畫面顯示');
assertEqual(post('getPhotoImage', { fileId: 'HUGE' }, token).result, { ok: false, message: '檔案過大，請直接在 Drive 開啟' }, '過大檔案應明確拒絕');
assertEqual(post('getPhotoImage', { fileId: 'GONE' }, token).result, { ok: false, message: '這個檔案已被刪除' }, '已刪除的檔案應明確告知');
assertEqual(post('getPhotoImage', { fileId: 'NOT_EXIST' }, token).result.ok, false, '找不到檔案不可丟例外');

// ===== 3. 未登入不可看照片 =====
assertEqual(post('getPhotoThumbs', { fileIds: ['LIVE'] }, '').code, 'AUTH', '未登入不可取縮圖');
assertEqual(post('getPhotoImage', { fileId: 'LIVE' }, '').code, 'AUTH', '未登入不可取原圖');
assertEqual(post('trashPhotos', { fileIds: ['LIVE'] }, '').code, 'AUTH', '未登入不可刪照片');

// ===== 4. 刪除＝移入垃圾桶，且要留下異動紀錄 =====
const del = post('trashPhotos', { fileIds: ['LIVE', 'NOT_EXIST'], note: 'A店 2026-08-20' }, token);
assertEqual(del.result.trashed, 1, '存在的檔案應被處理');
assertEqual(del.result.failed, ['NOT_EXIST'], '不存在的檔案要回報，不可默默略過');
assertEqual(files.LIVE.trashed, true, '應移入垃圾桶（可還原），不是永久刪除');
const hit = (ctx.getChangeLog(10).rows || []).filter(r => String(r.action || '').indexOf('刪除照片') >= 0);
assertEqual(hit.length, 1, '刪除照片必須留下異動紀錄');
assertEqual(hit[0].user, '趙千皓', '操作人應記登入帳號者');
assertEqual(String(hit[0].note).indexOf('A店') >= 0, true, '異動紀錄應帶出店名日期供追查');
assertEqual(String(hit[0].note).indexOf('2 張') >= 0, true, '應記下這次處理幾張');

// ===== 5. 檔名序號：取「既有最大+1」，不是陣列長度+1 =====
//   從 app.html 取出 nextPhotoIdx 單獨驗證（避免整支 SPA 依賴）
const appSrc = fs.readFileSync(APP_PATH, 'utf8');
const m = /function nextPhotoIdx\(list\) \{[\s\S]*?\n    \}/.exec(appSrc);
assertEqual(!!m, true, '應能在 app.html 找到 nextPhotoIdx');
const sandbox = { Math, parseInt };
vm.createContext(sandbox);
vm.runInContext(m[0] + '; this.fn = nextPhotoIdx;', sandbox);
const nextPhotoIdx = sandbox.fn;
assertEqual(nextPhotoIdx([]), 1, '沒有照片時從 1 開始');
assertEqual(nextPhotoIdx(undefined), 1, '未定義時也要能算');
assertEqual(nextPhotoIdx(['S_2026-08-20_X_1.jpg', 'S_2026-08-20_X_2.jpg']), 3, '兩張時下一個是 3');
// 關鍵案例：刪掉第1張後陣列長度是1，若用長度+1會算出 2 → 與仍存在的 _2 撞名
assertEqual(nextPhotoIdx(['S_2026-08-20_X_2.jpg']), 3, '刪掉中間某張後不可算出與現存檔案相同的序號');
assertEqual(nextPhotoIdx([{ name: 'S_2026-08-20_X_5.jpg', fileId: 'F' }]), 6, '{name,fileId} 形式也要能解析');
assertEqual(nextPhotoIdx(['奇怪的檔名.png']), 1, '無法解析序號時退回 1');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
