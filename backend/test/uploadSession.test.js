// 回歸測試：照片上傳不可把後端 OAuth 權杖交給瀏覽器（2026-08 資安檢測 High 項目）
//   舊做法 getDriveToken() 直接回傳 ScriptApp.getOAuthToken()，那把權杖的範圍是
//   drive + spreadsheets，等於腳本擁有者「整個雲端硬碟與所有試算表」的存取權，
//   任何登入者在瀏覽器開發者工具就能取得。
//   新做法：後端建立 Drive 可續傳上傳工作階段，只回傳「單檔上傳網址」。
// 執行方式：node backend/test/uploadSession.test.js
const path = require('path');
const vm = require('vm');
const fs = require('fs');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
const SECRET = 'ya29.SECRET_TOKEN_DO_NOT_LEAK';
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const { ctx } = loadGasFile(GS_PATH);

// ===== 假的 Google 服務 =====
let folderSeq = 0;
const makeFolder = (name) => ({
  __name: name,
  getId: () => 'folder_' + name,
  getFoldersByName: () => ({ hasNext: () => false, next: () => null }),
  createFolder: (n) => { folderSeq++; return makeFolder(n); },
});
ctx.DriveApp = { getFolderById: (id) => makeFolder('root:' + id) };
ctx.ScriptApp = { getOAuthToken: () => SECRET };

const cache = {};
ctx.CacheService = { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null }) };
ctx.ContentService = { createTextOutput: (s) => ({ __text: s, setMimeType: () => ({ __text: s }) }), MimeType: { JSON: 'json' } };

let sentRequests = [];      // 記錄後端送往 Drive 的請求，用來確認權杖只在伺服器端使用
let driveCode = 200;        // 可調整成 403 測失敗路徑
let locationAsArray = false;
ctx.UrlFetchApp = {
  fetch: () => ({ getContentText: () => JSON.stringify({ MSG: '000 OK' }) }),   // login 用
  fetchAll: (reqs) => {
    sentRequests = reqs;
    return reqs.map((r, i) => ({
      getResponseCode: () => driveCode,
      getAllHeaders: () => {
        if (driveCode >= 300) return {};
        const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION' + i;
        return locationAsArray ? { Location: [url] } : { Location: url };
      },
    }));
  },
};
vm.runInContext(fs.readFileSync(GS_PATH, 'utf8'), ctx, { filename: GS_PATH });

ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.ensureMonth('11508');
ctx.upsertRow('staff', null, { 部別: '一部', 課別: '北一課', 工號: '09812013', 姓名: '趙千皓', AD帳號: 'zhao', 角色: '' });
const user = ctx.login('zhao', 'pw');
const token = user.user.token;
const post = (action, payload, tk) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ action, token: tk, payload }) } }).__text);

// ===== 1. 舊的權杖端點必須完全移除 =====
const old = post('getDriveToken', {}, token);
assertEqual(old.ok, false, 'getDriveToken 路由必須已移除');
assertEqual(old.error.indexOf('未知動作') >= 0, true, '呼叫 getDriveToken 應回「未知動作」');
assertEqual(typeof ctx.getDriveToken, 'undefined', '程式碼中不應再存在 getDriveToken 函式');

// ===== 2. 新端點需登入才能用 =====
const anon = post('createUploadSessions', { items: [{ pathParts: ['115年08月'], name: 'a.jpg' }] }, '');
assertEqual(anon.ok, false, '未登入不可取得上傳網址');
assertEqual(anon.code, 'AUTH', '未登入應回 AUTH');

// ===== 3. 正常情況：一次取回整批網址 =====
const items = [
  { pathParts: ['115年08月', '1.店外海報', '缺失'], name: 'a.jpg' },
  { pathParts: ['115年08月', '1.店外海報', '缺失'], name: 'b.jpg' },
  { pathParts: ['115年08月', '2.店內海報'], name: 'c.jpg' },
];
const res = post('createUploadSessions', { items }, token);
assertEqual(res.ok, true, '登入後應可取得上傳網址');
assertEqual(res.result.sessions.length, 3, '回傳的網址數應與照片數相同');
assertEqual(res.result.sessions.every((s) => s.ok && /upload_id=SESSION\d/.test(s.url)), true, '每張都應拿到可續傳上傳網址');

// ===== 4. 最關鍵：回應內容任何角落都不得出現權杖 =====
assertEqual(JSON.stringify(res).indexOf(SECRET) === -1, true, '回傳給瀏覽器的內容不可含 OAuth 權杖');
assertEqual(JSON.stringify(res.result).indexOf('ya29.') === -1, true, '回傳內容不可含任何 Bearer 權杖字樣');

// ===== 5. 權杖只用在後端送往 Drive 的請求上 =====
assertEqual(sentRequests.length, 3, '後端應為每張照片各開一個工作階段');
assertEqual(sentRequests.every((r) => r.headers.Authorization === 'Bearer ' + SECRET), true, '權杖應只出現在後端送往 Drive 的標頭');
assertEqual(sentRequests.every((r) => r.url.indexOf('uploadType=resumable') >= 0), true, '應使用 resumable 上傳（單檔範圍）');
assertEqual(JSON.parse(sentRequests[0].payload).parents.length, 1, '應指定上傳目標資料夾');

// ===== 6. Location 以陣列形式回傳時也要取得到 =====
locationAsArray = true;
const arr = post('createUploadSessions', { items: [items[0]] }, token);
assertEqual(arr.result.sessions[0].ok, true, 'Location 為陣列時仍應解析成功');
assertEqual(/upload_id=SESSION0/.test(arr.result.sessions[0].url), true, '陣列形式應取第一個網址');
locationAsArray = false;

// ===== 7. Drive 回錯誤時要逐筆回報失敗，不可整個請求丟例外 =====
driveCode = 403;
const bad = post('createUploadSessions', { items: [items[0]] }, token);
assertEqual(bad.ok, true, 'Drive 失敗時 API 本身仍應正常回應（由前端逐筆重試）');
assertEqual(bad.result.sessions[0].ok, false, '該筆應標記為失敗');
assertEqual(bad.result.sessions[0].error.indexOf('403') >= 0, true, '應帶出 Drive 的狀態碼供排錯');
driveCode = 200;

// ===== 8. 一次開太多會被截斷（避免 UrlFetchApp 逾時）=====
const many = post('createUploadSessions', { items: Array.from({ length: 30 }, (_, i) => ({ pathParts: ['115年08月'], name: i + '.jpg' })) }, token);
assertEqual(many.result.sessions.length, 20, '單次最多開 20 個工作階段');

// ===== 9. 空清單不應呼叫 Drive =====
sentRequests = [];
const none = post('createUploadSessions', { items: [] }, token);
assertEqual(none.result.sessions, [], '空清單應回空陣列');
assertEqual(sentRequests.length, 0, '空清單不應對 Drive 發出任何請求');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
