// 回歸測試：店鋪名單的「總店數x店(一般店x店，隨盤點點檢店x店)」
//   關鍵：getMaster 只回前 800 筆（大表避免逾時），所以型態統計必須在後端用「全部資料」算，
//   前端拿到的 rows 自己數會少算。這裡驗證超過 800 筆時 byType 仍然正確。
// 執行方式：node backend/test/rosterStats.test.js
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

const { ctx } = loadGasFile(GS_PATH);
const cache = {};
ctx.CacheService = { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null, remove: (k) => { delete cache[k]; } }) };
ctx.ContentService = { createTextOutput: (s) => ({ __text: s, setMimeType: () => ({ __text: s }) }), MimeType: { JSON: 'json' } };
ctx.UrlFetchApp = { fetch: () => ({ getContentText: () => JSON.stringify({ MSG: '000 OK' }) }) };
vm.runInContext(fs.readFileSync(GS_PATH, 'utf8'), ctx, { filename: GS_PATH });

ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.ensureMonth('11508');
ctx.upsertRow('staff', null, { 部別: '業務部', 課別: '業務課', 工號: '1', 姓名: '林秀真', AD帳號: 'jolin', 角色: '管理者' });
const token = ctx.login('jolin', 'pw').user.token;
const post = (action, payload, tk) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ action, token: tk, payload }) } }).__text);

// 建 1000 筆名單：一般店 900、隨盤點點檢店 90、未填 10（刻意超過 800 筆的回傳上限）
const mk = (i, type) => ({ 店號: ('00000' + i).slice(-6), 店名: 'S' + i, 課別: '北一課', 店鋪型態: type, 遠程店: '否', 假日店: '否', 預排梯次: '' });
for (let i = 1; i <= 900; i++) ctx.upsertRow('roster', '11508', mk(i, '一般店'));
for (let i = 901; i <= 990; i++) ctx.upsertRow('roster', '11508', mk(i, '隨盤點點檢店'));
for (let i = 991; i <= 1000; i++) ctx.upsertRow('roster', '11508', mk(i, ''));

// ===== 1. 後端統計必須涵蓋全部資料，不受 800 筆回傳上限影響 =====
const r = post('getMaster', { kind: 'roster', month: '11508' }, token);
assertEqual(r.ok, true, 'getMaster 應成功');
assertEqual(r.result.total, 1000, '總筆數應為 1000');
assertEqual(r.result.rows.length, 800, '回傳的列數仍受 800 筆上限限制');
assertEqual(r.result.truncated, true, '應標記為已截斷');
assertEqual(r.result.byType, { '一般店': 900, '隨盤點點檢店': 90, '(未填)': 10 },
  '型態統計必須用全部 1000 筆計算（若用回傳的 800 筆會少算）');

// 反面驗證：拿前端實際收到的 rows 自己數會是錯的 —— 這就是統計必須放後端的理由
const naive = {};
r.result.rows.forEach(x => { const t = String(x['店鋪型態'] || '').trim() || '(未填)'; naive[t] = (naive[t] || 0) + 1; });
assertEqual(naive['一般店'] < 900, true, '確認前端自己數會少算（故不可在前端統計）');

// ===== 2. 沒有「店鋪型態」欄位的表不應回傳統計 =====
ctx.upsertItem('11508', { 排序: 1, 編號: 'A1', 大分類: '活動告示', 題號名稱: '1.店外海報', 配分: 4, 計分方式: '合格0分', 每項扣分: '', 子項清單: '' });
assertEqual(post('getMaster', { kind: 'checklist', month: '11508' }, token).result.byType, null,
  '題庫沒有店鋪型態欄位，byType 應為 null（前端就不顯示）');

// ===== 3. 空名單不應讓統計出錯 =====
ctx.ensureMonth('11509');
const empty = post('getMaster', { kind: 'roster', month: '11509' }, token);
assertEqual(empty.result.total, 0, '空名單總數為 0');
assertEqual(empty.result.byType, null, '空名單無從判斷欄位，回 null 即可（前端不顯示）');

// ===== 4. 顯示文字：順序固定、未定義型態排後面、不隱藏任何型態 =====
const appSrc = fs.readFileSync(APP_PATH, 'utf8');
const mOrder = /const STORE_TYPE_ORDER = \[[^\]]*\];/.exec(appSrc);
const mFn = /function storeCountText\(total, byType\) \{[\s\S]*?\n    \}/.exec(appSrc);
assertEqual(!!mOrder && !!mFn, true, '應能在 app.html 找到 storeCountText');
const sb = { Object };
vm.createContext(sb);
vm.runInContext(mOrder[0] + '\n' + mFn[0] + '; this.fn = storeCountText;', sb);
const txt = sb.fn;
assertEqual(txt(1563, { '一般店': 1456, '隨盤點點檢店': 107 }),
  '總店數1563店（一般店1456店，隨盤點點檢店107店）', '正常情況的文字格式');
assertEqual(txt(1000, { '隨盤點點檢店': 90, '一般店': 900, '(未填)': 10 }),
  '總店數1000店（一般店900店，隨盤點點檢店90店，(未填)10店）', '一般店永遠排最前，未定義型態排後面且不可被隱藏');
assertEqual(txt(5, { '一般店': 5 }), '總店數5店（一般店5店）', '只有一種型態時也要正常');
assertEqual(txt(0, null), '', '沒有統計資料時不顯示任何文字');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
