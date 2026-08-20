// 回歸測試：重複照片清理工具（會刪檔案，所以行為必須先驗過）
//   背景：2026-08-20 照片直傳被 CORS 擋掉，但 Drive 已寫入成功(200)，前端每 15~60 秒
//         重試一次 → 同一張照片在同資料夾被寫了很多份。
//   要求：預設只掃描不刪；實際刪除時每組同名檔案只保留「建立時間最早」的一份，
//         其餘移到垃圾桶(可還原)；不同資料夾的同名檔案不算重複。
// 執行方式：node backend/test/dupPhotos.test.js
const path = require('path');
const vm = require('vm');
const fs = require('fs');

const SETUP_PATH = path.join(__dirname, '..', 'setup.gs');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

/** 建一棵假的 Drive 樹；tree = { __files: [{name, created}], 子資料夾名: {...} } */
function makeDrive(tree) {
  const trashed = [];
  const mkFile = (f, owner) => ({
    getName: () => f.name,
    getDateCreated: () => new Date(f.created),
    setTrashed: (v) => { if (v) { f.trashed = true; trashed.push(owner + '/' + f.name + '@' + f.created); } },
    __raw: f,
  });
  const mkFolder = (name, node) => {
    const files = (node.__files || []).filter((f) => !f.trashed);
    const subNames = Object.keys(node).filter((k) => k !== '__files');
    return {
      getName: () => name,
      getFiles: () => { let i = 0; return { hasNext: () => i < files.length, next: () => mkFile(files[i++], name) }; },
      getFolders: () => { let i = 0; return { hasNext: () => i < subNames.length, next: () => mkFolder(subNames[i], node[subNames[i++]]) }; },
      getFoldersByName: (n) => {
        const has = subNames.indexOf(n) >= 0;
        let done = !has;
        return { hasNext: () => !done, next: () => { done = true; return mkFolder(n, node[n]); } };
      },
    };
  };
  return { DriveApp: { getFolderById: () => mkFolder('照片根', tree) }, trashed };
}

function load(tree) {
  const { DriveApp, trashed } = makeDrive(tree);
  const logs = [];
  const sandbox = {
    console, DriveApp,
    Logger: { log: (m) => logs.push(String(m)) },
    SpreadsheetApp: { openById: () => ({}) },
    Object, Date, String, Number, Array, JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SETUP_PATH, 'utf8'), sandbox, { filename: 'setup.gs' });
  return { ctx: sandbox, trashed, logs };
}

// 「一般店」與「缺失」兩層，同名檔案各有多份；另有不同資料夾的同名檔案（不算重複）
const tree = () => ({
  '115年08月': {
    '1.店外海報': {
      '缺失': {
        __files: [
          { name: 'A_2026-08-20_1_1.jpg', created: '2026-08-20T10:00:00Z' },  // 最早，應保留
          { name: 'A_2026-08-20_1_1.jpg', created: '2026-08-20T10:01:00Z' },
          { name: 'A_2026-08-20_1_1.jpg', created: '2026-08-20T10:02:00Z' },
          { name: 'A_2026-08-20_1_2.jpg', created: '2026-08-20T10:03:00Z' },  // 只有1份
        ],
      },
    },
    '2.店內海報': {
      __files: [
        { name: 'A_2026-08-20_1_1.jpg', created: '2026-08-20T09:00:00Z' },    // 同名但不同資料夾
      ],
    },
  },
  '115年07月': {
    __files: [{ name: 'OLD.jpg', created: '2026-07-01T10:00:00Z' }],
  },
});

// ===== 1. 只掃描不刪除 =====
let t = load(tree());
let r = t.ctx.reportDuplicatePhotos('115年08月');
assertEqual(r.scanned, 5, '應只掃描 8 月資料夾內的 5 個檔案（不含 7 月）');
assertEqual(r.duplicates, 2, '應找出 2 份重複（同名 3 份 → 多出 2 份）');
assertEqual(r.deleted, 0, '掃描模式不可刪除任何檔案');
assertEqual(t.trashed, [], '掃描模式不可有任何檔案被移入垃圾桶');
assertEqual(r.detail.length, 1, '只應有一組重複');
assertEqual(r.detail[0].indexOf('3 份') >= 0, true, '明細應標示該組共 3 份');
assertEqual(t.logs[0].indexOf('僅掃描，未刪除任何檔案') >= 0, true, '記錄檔應明確標示未刪除');

// ===== 2. 沒有明確傳 true 時也不刪（避免誤觸）=====
t = load(tree());
r = t.ctx.removeDuplicatePhotos('115年08月');
assertEqual(t.trashed, [], '未明確傳 true 不可刪除');
assertEqual(r.deleted, 0, '未明確傳 true 的回傳刪除數應為 0');
t = load(tree());
t.ctx.removeDuplicatePhotos('115年08月', 'true');   // 字串不算
assertEqual(t.trashed, [], '只有布林 true 才刪除，字串不算');

// ===== 3. 實際刪除：保留最早，其餘移入垃圾桶 =====
t = load(tree());
r = t.ctx.removeDuplicatePhotos('115年08月', true);
assertEqual(r.deleted, 2, '應處理 2 份重複');
assertEqual(t.trashed, [
  '缺失/A_2026-08-20_1_1.jpg@2026-08-20T10:01:00Z',
  '缺失/A_2026-08-20_1_1.jpg@2026-08-20T10:02:00Z',
], '應保留建立時間最早的那份，只把較晚的移入垃圾桶');
assertEqual(t.logs[0].indexOf('已移入垃圾桶') >= 0, true, '記錄檔應標示已處理');

// ===== 4. 不同資料夾的同名檔案不可被誤判為重複 =====
t = load({ '115年08月': {
  'X': { __files: [{ name: 'same.jpg', created: '2026-08-01T00:00:00Z' }] },
  'Y': { __files: [{ name: 'same.jpg', created: '2026-08-02T00:00:00Z' }] },
} });
r = t.ctx.removeDuplicatePhotos('115年08月', true);
assertEqual(r.duplicates, 0, '不同資料夾的同名檔案不算重複');
assertEqual(t.trashed, [], '不同資料夾的同名檔案不可被刪除');

// ===== 5. 找不到指定的月份資料夾時要安全結束 =====
t = load(tree());
r = t.ctx.reportDuplicatePhotos('115年99月');
assertEqual(r.scanned, 0, '找不到資料夾時不應掃描');
assertEqual(r.error.indexOf('找不到資料夾') >= 0, true, '應回報找不到資料夾');
assertEqual(t.trashed, [], '找不到資料夾時不可刪除任何檔案');

// ===== 6. 沒有重複時的正常回報 =====
t = load({ '115年08月': { __files: [{ name: 'only.jpg', created: '2026-08-01T00:00:00Z' }] } });
r = t.ctx.removeDuplicatePhotos('115年08月', true);
assertEqual([r.duplicates, r.deleted], [0, 0], '沒有重複時不應有任何處理');
assertEqual(t.logs[0].indexOf('沒有發現重複檔案') >= 0, true, '應明確回報沒有重複');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
