// 回歸測試：照片設為「知道連結的人可檢視」
//   目的：報表（含客戶版）裡的照片連結，要讓沒有 Google 帳號的人也能開。
//   安全前提：fileId 是前端傳進來的，若不驗證歸屬，有心人可用這支 API 把擁有者帳號裡
//   任何檔案設成對外公開 —— 所以一律先確認檔案位於照片根資料夾底下。
//   容錯前提：公司 Workspace 政策可能禁止對外連結分享，setSharing 會丟例外；
//   此時絕不可中斷「連結回寫」（照片與紀錄的關聯比分享權限重要）。
// 執行方式：node backend/test/shareLinks.test.js
const path = require('path');
const vm = require('vm');
const fs = require('fs');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
const ROOT = '122nQjldImn5Zh5AUguxZF0YzobThgdc9';   // 與 程式碼.gs 的 DRIVE_ROOT_ID 相同
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// 資料夾樹：F_缺失 → F_題目 → F_月份 → ROOT ；F_別的地方 → 無父層（不在照片資料夾底下）
const folderParent = { 'F_缺失': 'F_題目', 'F_題目': 'F_月份', 'F_月份': ROOT, 'F_別的地方': null };
const files = {
  PHOTO1: { parent: 'F_缺失' },
  PHOTO2: { parent: 'F_缺失' },
  OUTSIDE: { parent: 'F_別的地方' },                 // 擁有者的其他文件
  POLICY_BLOCKED: { parent: 'F_缺失', blocked: true }, // 模擬 Workspace 禁止對外分享
};
const oneOrNone = (pid) => { let done = !pid; return { hasNext: () => !done, next: () => { done = true; return { getId: () => pid }; } }; };

function load() {
  const { ctx } = loadGasFile(GS_PATH);
  const shared = [];
  Object.keys(files).forEach(k => { delete files[k].sharedAs; });
  ctx.DriveApp = {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { VIEW: 'VIEW' },
    getFileById: (id) => {
      const f = files[String(id)];
      if (!f) throw new Error('File not found: ' + id);
      return {
        getParents: () => oneOrNone(f.parent),
        setSharing: (access, perm) => {
          if (f.blocked) throw new Error('此網域的共用設定不允許「知道連結的人」');
          f.sharedAs = access + '/' + perm;
          shared.push(String(id));
        },
      };
    },
    getFolderById: (id) => ({ getParents: () => oneOrNone(folderParent[id]) }),
  };
  const cache = {};
  ctx.CacheService = { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => (k in cache ? cache[k] : null), remove: (k) => { delete cache[k]; } }) };
  vm.runInContext(fs.readFileSync(GS_PATH, 'utf8'), ctx, { filename: GS_PATH });
  return { ctx, shared };
}

// ===== 1. 照片資料夾內的檔案才會被設定 =====
let t = load();
let r = t.ctx.shareLinkedPhotos({
  '115年08月/1.店外海報/缺失': [{ name: 'a.jpg', fileId: 'PHOTO1' }, { name: 'b.jpg', fileId: 'PHOTO2' }],
});
assertEqual(r, { ok: 2, failed: 0 }, '照片資料夾內的兩張都應設定成功');
assertEqual(t.shared, ['PHOTO1', 'PHOTO2'], '應逐檔設定');
assertEqual(files.PHOTO1.sharedAs, 'ANYONE_WITH_LINK/VIEW', '權限應為「知道連結的人可檢視」');

// ===== 2. 資料夾外的檔案一律不動（這是最重要的防護）=====
t = load();
r = t.ctx.shareLinkedPhotos({ k: [{ name: 'x', fileId: 'OUTSIDE' }] });
assertEqual(r, { ok: 0, failed: 1 }, '資料夾外的檔案應計為失敗');
assertEqual(t.shared, [], '資料夾外的檔案完全不可被設定成公開');
assertEqual(files.OUTSIDE.sharedAs, undefined, '該檔案的權限必須毫髮無傷');

// ===== 3. 政策禁止對外分享時，不可中斷其他照片的處理 =====
t = load();
r = t.ctx.shareLinkedPhotos({
  k: [{ name: 'a', fileId: 'PHOTO1' }, { name: 'p', fileId: 'POLICY_BLOCKED' }, { name: 'b', fileId: 'PHOTO2' }],
});
assertEqual(r, { ok: 2, failed: 1 }, '被政策擋下的那張算失敗，其餘仍要成功');
assertEqual(t.shared, ['PHOTO1', 'PHOTO2'], '政策失敗不可影響其他照片');

// ===== 4. 不存在的檔案、缺 fileId 的項目都不可讓整支掛掉 =====
t = load();
r = t.ctx.shareLinkedPhotos({
  k: [{ name: 'gone', fileId: 'NOT_EXIST' }, { name: 'noid' }, { name: 'a', fileId: 'PHOTO1' }],
});
assertEqual(r, { ok: 1, failed: 1 }, '不存在的算失敗、沒有 fileId 的直接略過（不計失敗）');
assertEqual(t.shared, ['PHOTO1'], '正常的那張仍要設定成功');

// ===== 5. 空輸入 =====
t = load();
assertEqual(t.ctx.shareLinkedPhotos({}), { ok: 0, failed: 0 }, '空物件不應出錯');
assertEqual(t.ctx.shareLinkedPhotos(null), { ok: 0, failed: 0 }, 'null 不應出錯');
assertEqual(t.shared, [], '空輸入不應對 Drive 做任何事');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
