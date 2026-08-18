// 回歸測試：「點檢人員」與「操作人」必須分開記錄
//   點檢紀錄的「點檢人員」＝填寫時下拉選擇的人員（可能不是登入者）
//   異動紀錄的「操作人」＝登入帳號者（用來追查實際是誰操作系統）
// 執行方式：node backend/test/auditWho.test.js
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

// gas-fake-env 沒有 CacheService（doPost 需要它驗 token），這裡補上
const src = fs.readFileSync(GS_PATH, 'utf8');
const { ctx, book } = loadGasFile(GS_PATH);
const cache = {};
ctx.CacheService = { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null }) };
ctx.ContentService = { createTextOutput: (s) => ({ __text: s, setMimeType: () => ({ __text: s }) }), MimeType: { JSON: 'json' } };
vm.runInContext(src, ctx, { filename: GS_PATH }); // 重新載入讓函式綁到補上的服務

ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.ensureMonth('11508');

// 登入者＝林秀真(業務課)；另有一位台中課的張三可被選為點檢人員
ctx.upsertRow('staff', null, { 部別: '業務部', 課別: '業務課', 工號: '10707005', 姓名: '林秀真', 職稱: '', AD帳號: 'jolin', 角色: '管理者' });
ctx.upsertRow('staff', null, { 部別: '二部', 課別: '台中課', 工號: '10509005', 姓名: '張三', 職稱: '', AD帳號: '', 角色: '點檢員' });

const token = ctx.issueToken({ role: '管理者', name: '林秀真', empId: '10707005' }, 'jolin');
const post = (action, payload) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ action, token, payload }) } }).__text);

// 林秀真登入，但點檢人員選「張三」送出紀錄
const res = post('submitRecord', {
  record: {
    id: 'R1', month: '11508', time: '2026-08-18 11:40',
    dept: '二部', section: '台中課', empId: '10509005', staffName: '張三',
    storeCode: '021616', storeName: '大雅矽品店', storeType: '不可拍照',
    total: 95, grade: '優良', staffCount: '1', identity: '店長', note: '',
    detail: {}, observation: {}, photos: {}, paperPhotos: [],
  },
});
assertEqual(res.ok, true, '送出應成功');

// 1) 點檢紀錄裡存的是「選擇的人員」，不是登入者
const rec = ctx.queryRecords('11508', {})[0];
assertEqual(rec.staffName, '張三', '點檢紀錄的點檢人員＝填寫時選擇的人員（非登入者林秀真）');
assertEqual(String(rec.empId), '10509005', '員編應為所選人員的工號');
assertEqual(rec.section, '台中課', '課別應為所選人員的課別');

// 2) 異動紀錄只記「刪除/修改」：新增送出不應留下紀錄
assertEqual(ctx.getChangeLog(50).rows.length, 0, '送出(新增)不應寫入異動紀錄');

// 3) 修改紀錄要留痕，且操作人＝登入帳號者
post('updateRecord', { month: '11508', id: 'R1', record: { id: 'R1', month: '11508', time: '2026-08-18 12:00', dept: '二部', section: '台中課', empId: '10509005', staffName: '張三', storeCode: '021616', storeName: '大雅矽品店', storeType: '不可拍照', total: 90, grade: '合格', staffCount: '1', identity: '店長', note: '', detail: {}, observation: {}, photos: {}, paperPhotos: [] } });
const updLog = ctx.getChangeLog(50).rows.find(r => r.action === '修改點檢紀錄');
assertEqual(!!updLog, true, '異動紀錄應留下「修改點檢紀錄」');
assertEqual(updLog.user, '林秀真', '修改紀錄的操作人＝登入帳號者');
assertEqual(updLog.target, '點檢紀錄_11508', '異動紀錄的對象應為該月活頁');
assertEqual(updLog.note.indexOf('張三') >= 0, true, '說明應看得到點檢人員是誰（與操作人區分）');
assertEqual(updLog.note.indexOf('大雅矽品店') >= 0, true, '說明應含店名');

// 4) 刪除紀錄要留痕
post('deleteRecord', { month: '11508', id: 'R1' });
const delLog = ctx.getChangeLog(50).rows.find(r => r.action === '刪除點檢紀錄');
assertEqual(!!delLog, true, '異動紀錄應留下「刪除點檢紀錄」');
assertEqual(delLog.user, '林秀真', '刪除紀錄的操作人＝登入帳號者');

// 5) 維護專區：新增不記錄、修改才記錄
ctx.ensureKindSheet('roster', '11508');
post('upsertRow', { kind: 'roster', month: '11508', row: { 店號: '000009', 店名: '新店', 課別: '北三課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: '' } });
assertEqual(ctx.getChangeLog(50).rows.filter(r => r.action === '修改').length, 0, '維護專區「新增」不應寫入異動紀錄');
post('upsertRow', { kind: 'roster', month: '11508', row: { 店號: '000009', 店名: '新店改名', 課別: '北三課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: '' } });
assertEqual(ctx.getChangeLog(50).rows.filter(r => r.action === '修改').length, 1, '維護專區「修改」應寫入異動紀錄');

// 6) 匯入不再記錄（依需求只留刪除/修改）
post('importMaster', { kind: 'roster', month: '11508', fileName: 'x.xlsx', rows: [{ 店號: '000010', 店名: 'A', 課別: '北三課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: '' }] });
assertEqual(ctx.getChangeLog(50).rows.filter(r => String(r.action).indexOf('匯入') >= 0).length, 0, 'Excel匯入不應寫入異動紀錄');

// 7) 被擋下的動作(同店重複)不應寫入異動紀錄
const before = ctx.getChangeLog(50).rows.length;
post('submitRecord', {
  record: { id: 'R3', month: '11508', time: '2026-08-19 10:00', dept: '二部', section: '台中課', empId: '10509005', staffName: '張三', storeCode: '000010', storeName: 'A', storeType: '可拍照', total: 88, grade: '合格', staffCount: '1', identity: '店長', note: '', detail: {}, observation: {}, photos: {}, paperPhotos: [] },
});
const dup = post('submitRecord', {
  record: { id: 'R4', month: '11508', time: '2026-08-20 10:00', dept: '二部', section: '台中課', empId: '10509005', staffName: '張三', storeCode: '000010', storeName: 'A', storeType: '可拍照', total: 88, grade: '合格', staffCount: '1', identity: '店長', note: '', detail: {}, observation: {}, photos: {}, paperPhotos: [] },
});
assertEqual(dup.result.code, 'DUPLICATE', '同店重複應被擋下');
assertEqual(ctx.getChangeLog(50).rows.length, before, '送出與被擋下的送出都不應新增異動紀錄');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
