// 回歸測試：同店同月防重複，不受店號前導0格式差異影響
//
// 背景：submitRecord 的防重複檢查一度用「完全字串相等」比對店號，
// 但「店鋪名單」「店鋪主檔」「手動編輯」三個資料來源常出現店號前導0
// 被 Google Sheet 自動轉數字吃掉的情況（如 017246 vs 17246），
// 導致兩筆格式不同但實為同一家店的紀錄都被判定為「不同店」而放行。
// 修正：submitRecord 內用 normCode()（去除前導0）比對後才判斷是否重複。
//
// 執行方式：node backend/test/duplicateStoreCode.test.js
const path = require('path');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');

function baseRecord(overrides) {
  return Object.assign({
    id: 'REC-A', month: '11507', time: '2026-07-15 10:00',
    dept: '營運一部', section: '北一課', empId: 'A001', staffName: '測試員',
    storeCode: '017246', storeName: '基隆武勝店', storeType: '可拍照',
    total: 90, grade: '合格', staffCount: '3', identity: '店長',
    note: '', detail: {}, observation: {}, photos: {}, paperPhotos: [],
  }, overrides);
}

function countRows(ctx, sheetName) {
  const sh = ctx.SpreadsheetApp.openById().getSheetByName(sheetName);
  return sh ? sh.getLastRow() - 1 : 0; // 扣表頭
}

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// 案例1：同店，兩種店號格式（017246 vs 17246）→ 第2筆須被擋下
(function case1() {
  const { ctx } = loadGasFile(GS_PATH);
  ctx.submitRecord(baseRecord({ id: 'A', storeCode: '017246' }));
  const r2 = ctx.submitRecord(baseRecord({ id: 'B', storeCode: '17246' }));
  assertEqual(r2.ok, false, '案例1a：格式不同的同店第2筆應被擋下(ok=false)');
  assertEqual(r2.code, 'DUPLICATE', '案例1b：擋下原因應為 DUPLICATE');
  assertEqual(countRows(ctx, '點檢紀錄_11507'), 1, '案例1c：活頁應只有1筆紀錄');
})();

// 案例2：同店，格式完全相同 → 第2筆一樣要被擋下（既有規則不能因為修正而壞掉）
(function case2() {
  const { ctx } = loadGasFile(GS_PATH);
  ctx.submitRecord(baseRecord({ id: 'A', storeCode: '017246' }));
  const r2 = ctx.submitRecord(baseRecord({ id: 'B', storeCode: '017246' }));
  assertEqual(r2.ok, false, '案例2：格式相同的同店第2筆應被擋下(ok=false)');
})();

// 案例3：不同店（即使正規化後也不同）→ 兩筆都應成功，不可誤擋
(function case3() {
  const { ctx } = loadGasFile(GS_PATH);
  const r1 = ctx.submitRecord(baseRecord({ id: 'A', storeCode: '017246' }));
  const r2 = ctx.submitRecord(baseRecord({ id: 'B', storeCode: '022390', storeName: '板橋雙子店' }));
  assertEqual(r1.ok, true, '案例3a：店A應成功');
  assertEqual(r2.ok, true, '案例3b：不同店的店B也應成功，不可被誤擋');
  assertEqual(countRows(ctx, '點檢紀錄_11507'), 2, '案例3c：活頁應有2筆紀錄');
})();

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
