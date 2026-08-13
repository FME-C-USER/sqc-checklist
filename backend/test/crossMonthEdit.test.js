// 回歸測試：編輯紀錄時把「點檢時間」改到別的月份（跨月搬移）
//   紀錄依點檢時間分月活頁存放，所以跨月編輯不能只做 updateRecord，
//   必須「先寫入新月份、成功後才刪原月份」。這裡驗證後端這幾個基本行為：
//   1. 用錯誤的月份去 updateRecord 會找不到紀錄（證明原本的寫法確實會漏改）
//   2. 用原月份 updateRecord 才會改到
//   3. 搬移流程(先submit新月份→再delete原月份)結果正確：新月份1筆、原月份0筆
//   4. 新月份該店已有紀錄時，submit 會被擋下（此時前端會中止搬移，原紀錄保持不動）
// 執行方式：node backend/test/crossMonthEdit.test.js
const path = require('path');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const { ctx } = loadGasFile(GS_PATH);
ctx.ensureMonth('11507');
ctx.ensureMonth('11508');

const baseRec = (over) => Object.assign({
  id: 'R1', month: '11507', time: '2026-07-31 23:00',
  dept: '一部', section: '北三課', empId: 'A001', staffName: '測試員',
  storeCode: '017246', storeName: '基隆武勝店', storeType: '可拍照',
  total: 90, grade: '合格', staffCount: '2', identity: '店長', note: '',
  detail: {}, observation: {}, photos: {}, paperPhotos: [],
}, over || {});

// 原紀錄建在 7 月
ctx.submitRecord(baseRec());
assertEqual(ctx.queryRecords('11507', {}).length, 1, '原紀錄應在7月');

// 1. 誤用新月份(8月)去更新 → 找不到，7月原紀錄不會被改到（這就是原本的bug）
const wrong = ctx.updateRecord('11508', 'R1', baseRec({ month: '11508', time: '2026-08-01 09:00', total: 55 }));
assertEqual(wrong.ok, false, '用錯誤月份更新應回 ok:false（找不到紀錄）');
assertEqual(Number(ctx.queryRecords('11507', {})[0].total), 90, '7月原紀錄不應被改動（證明會漏改）');

// 2. 用原月份更新才會改到
const right = ctx.updateRecord('11507', 'R1', baseRec({ total: 88 }));
assertEqual(right.ok, true, '用原月份更新應成功');
assertEqual(Number(ctx.queryRecords('11507', {})[0].total), 88, '7月紀錄應被更新為88');

// 3. 跨月搬移：先寫入8月 → 成功後刪7月
const moved = baseRec({ month: '11508', time: '2026-08-01 09:00', total: 77 });
const ins = ctx.submitRecord(moved);
assertEqual(ins.ok, true, '搬移第一步：寫入新月份應成功');
const del = ctx.deleteRecord('11507', 'R1');
assertEqual(del.ok, true, '搬移第二步：刪除原月份應成功');
assertEqual(ctx.queryRecords('11507', {}).length, 0, '搬移後7月應為0筆');
assertEqual(ctx.queryRecords('11508', {}).length, 1, '搬移後8月應為1筆');
assertEqual(Number(ctx.queryRecords('11508', {})[0].total), 77, '8月紀錄內容應為搬移後的值');
assertEqual(ctx.queryRecords('11508', {})[0].id, 'R1', '搬移後紀錄ID應保持不變');

// 4. 新月份該店已有別人的紀錄 → 寫入被擋，前端據此中止搬移（原紀錄不會被刪）
ctx.ensureMonth('11509');
ctx.submitRecord(baseRec({ id: 'R9', month: '11509', time: '2026-09-02 10:00' }));
const blocked = ctx.submitRecord(baseRec({ id: 'R1', month: '11509', time: '2026-09-03 10:00' }));
assertEqual(blocked.ok, false, '新月份同店已有紀錄時，寫入應被擋下');
assertEqual(blocked.code, 'DUPLICATE', '擋下原因應為 DUPLICATE');
assertEqual(ctx.queryRecords('11509', {}).length, 1, '9月應仍只有原本那1筆');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
