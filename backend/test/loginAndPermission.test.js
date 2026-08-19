// 回歸測試：登入與權限模型（依實際作業方式決定）
//   「點檢人員」名冊多數人的 AD 欄位是空的，故：
//   1. 只要日翊帳密正確就能登入、能點檢（AD 比對不到也放行，身分留空、角色以點檢員計）
//   2. 查詢紀錄：所有登入者皆可查全部，不依登入者工號過濾
//   3. 權限差異只在：管理者才看得到「維護專區」與報表/請款產出（前端以 role 判斷）
// 執行方式：node backend/test/loginRequiresStaff.test.js
const path = require('path');
const vm = require('vm');
const fs = require('fs');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const { ctx } = loadGasFile(GS_PATH);
// login 需要 CacheService(發權杖) 與 UrlFetchApp(日翊驗證)。此處驗證一律回成功(000)，
// 才能單獨測「名冊比對」與權限這段邏輯。
const cache = {};
ctx.CacheService = { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null }) };
ctx.UrlFetchApp = { fetch: () => ({ getContentText: () => JSON.stringify({ MSG: '000 OK' }) }) };
vm.runInContext(fs.readFileSync(GS_PATH, 'utf8'), ctx, { filename: GS_PATH });

ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.ensureMonth('11508');
// 主檔實況：管理者有填 AD；一般點檢員的 AD 欄是空的
ctx.upsertRow('staff', null, { 部別: '業務部', 課別: '業務課', 工號: '10707005', 姓名: '林秀真', 職稱: '資深專員', AD帳號: 'jolin', 角色: '管理者' });
ctx.upsertRow('staff', null, { 部別: '一部', 課別: '北一課', 工號: '09812013', 姓名: '趙千皓', 職稱: '課長', AD帳號: '', 角色: '' });

// ===== 1. 有登錄 AD（管理者）=====
const mgr = ctx.login('jolin', 'pw');
assertEqual(mgr.ok, true, '有登錄AD應可登入');
assertEqual(mgr.user.name, '林秀真', '應帶出姓名');
assertEqual(mgr.user.role, '管理者', '角色為管理者→前端才顯示維護專區與報表產出');
assertEqual(String(mgr.user.empId), '10707005', '應帶出工號');

// ===== 2. AD 未登錄於名冊 → 仍可登入（身分留空、角色點檢員）=====
const anon = ctx.login('someone', 'pw');
assertEqual(anon.ok, true, 'AD未登錄於名冊仍應可登入（只要日翊帳密正確）');
assertEqual(anon.user.role, '點檢員', '取不到身分時角色以點檢員計→前端隱藏維護專區與報表產出');
assertEqual(anon.user.name, '', '姓名留空，登入後於基本資料自行選取點檢人員');
assertEqual(anon.user.ad, 'someone', '應記錄其AD帳號（異動紀錄的操作人會用到）');
assertEqual(!!ctx.getSession(anon.user.token), true, '應發出有效權杖');

// ===== 3. 帳密錯誤才擋下 =====
assertEqual(ctx.login('', 'pw').ok, false, '空白帳號應擋下');
assertEqual(ctx.login('x', '').ok, false, '空白密碼應擋下');

// ===== 4. AD留空者仍可被選為點檢人員 =====
const boot = ctx.getBootstrap('11508', '');
assertEqual(boot.staffs.map(s => s.name).indexOf('趙千皓') >= 0, true, 'AD留空者仍應出現在點檢人員下拉');

// ===== 5. 查詢紀錄：不帶工號時取全部（＝所有登入者都查得到全部）=====
const rec = (id, empId, name, code, store) => ({
  id, month: '11508', time: '2026-08-05 10:00', dept: '一部', section: '北一課',
  empId, staffName: name, storeCode: code, storeName: store, storeType: '可拍照',
  total: 90, grade: '合格', staffCount: '1', identity: '店長', note: '',
  detail: {}, observation: {}, photos: {}, paperPhotos: [],
});
ctx.submitRecord(rec('R1', '09812013', '趙千皓', '000001', 'A店'));
ctx.submitRecord(rec('R2', '10707005', '林秀真', '000002', 'B店'));
assertEqual(ctx.queryRecords('11508', { from: '2026-08-01', to: '2026-08-31' }).length, 2,
  '不帶工號→取到全部紀錄（本系統設計：所有登入者皆可查全部）');
assertEqual(ctx.queryRecords('11508', { section: '北一課' }).length, 2, '課別過濾仍可用');

// ===== 6. 管理者專屬路由：非管理者不可呼叫 =====
const anonToken = anon.user.token;
const post = (action, payload, token) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ action, token, payload }) } }).__text);
ctx.ContentService = { createTextOutput: (s) => ({ __text: s, setMimeType: () => ({ __text: s }) }), MimeType: { JSON: 'json' } };
vm.runInContext(fs.readFileSync(GS_PATH, 'utf8'), ctx, { filename: GS_PATH });
const denied = post('getMaster', { kind: 'roster', month: '11508' }, anonToken);
assertEqual(denied.ok, false, '非管理者呼叫維護專區的API應被拒絕');
assertEqual(denied.error.indexOf('管理者') >= 0, true, '應提示需管理者權限');
const allowed = post('getMaster', { kind: 'roster', month: '11508' }, mgr.user.token);
assertEqual(allowed.ok, true, '管理者呼叫維護專區的API應允許');

// ===== 7. 課長版/客戶版：所有登入者皆可產出；請款單價只給管理者 =====
const repAnon = post('buildMonthlyReport', { month: '11508', filter: {} }, anonToken);
assertEqual(repAnon.ok, true, '非管理者應可取得報表資料（課長版/客戶版）');
assertEqual(repAnon.result.rows.length, 2, '非管理者取得的報表資料應完整');
assertEqual(repAnon.result.pricing, null, '非管理者不應取得請款單價（請款金額限管理者）');
const repMgr = post('buildMonthlyReport', { month: '11508', filter: {} }, mgr.user.token);
assertEqual(repMgr.ok, true, '管理者應可取得報表資料');
assertEqual(repMgr.result.pricing.平日點檢費, 245, '管理者應取得請款單價');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
