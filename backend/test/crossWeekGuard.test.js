// 回歸測試：編輯/刪除限當週，非當週要密碼
//   規則：當週＝週一到週日。例：週五點檢的資料，下週一要編輯或刪除就需要密碼。
//   密碼放「設定」活頁的「跨週修改密碼」，未設定時預設 9588。
//   關鍵防繞過：判斷要用「原紀錄的點檢時間」，不能用前端送來的新時間 ——
//   否則只要把時間改成本週就能規避密碼。
// 執行方式：node backend/test/crossWeekGuard.test.js
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

// 把「今天」固定在 2026-08-24（週一），這樣週界的判斷才可重現：
//   本週 = 08-24(一) ~ 08-30(日)；08-21(五) 屬上週 → 需要密碼
const TODAY = '2026-08-24';
const { ctx } = loadGasFile(GS_PATH);
ctx.Utilities.formatDate = (date, tz, fmt) => {
  if (fmt === 'yyyy-MM-dd') {
    // 傳進來的是「現在」就回固定的今天；其他（週一換算）照實格式化
    const iso = new Date(date).toISOString().slice(0, 10);
    return Math.abs(new Date(date).getTime() - Date.now()) < 60000 ? TODAY : iso;
  }
  return '2026-08-24 10:00';
};
vm.runInContext(fs.readFileSync(GS_PATH, 'utf8'), ctx, { filename: GS_PATH });
ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.ensureMonth('11508');

// ===== 1. 週界判斷（週一為一週之始）=====
assertEqual(ctx.weekMondayOf('2026-08-24'), '2026-08-24', '週一的週起始是自己');
assertEqual(ctx.weekMondayOf('2026-08-30'), '2026-08-24', '週日仍屬同一週（週一~週日）');
assertEqual(ctx.weekMondayOf('2026-08-21'), '2026-08-17', '上週五屬上一週');
assertEqual(ctx.isCrossWeek('2026-08-24 09:00'), false, '今天(週一)的紀錄屬當週');
assertEqual(ctx.isCrossWeek('2026-08-30 23:00'), false, '本週日的紀錄屬當週');
assertEqual(ctx.isCrossWeek('2026-08-21 15:00'), true, '上週五的紀錄屬跨週（使用者舉的例子）');
assertEqual(ctx.isCrossWeek(''), false, '日期解析不出來時不阻擋，避免誤鎖');

// ===== 2. 密碼預設 9588，且可由「設定」活頁覆蓋 =====
assertEqual(ctx.editPassword(), '9588', '未設定時用預設密碼');
assertEqual(ctx.checkEditPass('9588'), { ok: true }, '正確密碼應通過');
assertEqual(ctx.checkEditPass('1234'), { ok: false }, '錯誤密碼應失敗');
assertEqual(ctx.checkEditPass(''), { ok: false }, '空密碼應失敗');
ctx.ssBook().getSheetByName('設定').appendRow(['跨週修改密碼', '2468']);
assertEqual(ctx.editPassword(), '2468', '設定活頁可覆蓋密碼（改密碼不必動程式）');
assertEqual(ctx.checkEditPass('9588'), { ok: false }, '改過密碼後舊密碼失效');
assertEqual(ctx.checkEditPass('2468'), { ok: true }, '新密碼生效');

// ===== 3. 當週紀錄：不需密碼 =====
const rec = (id, time, code, name) => ({
  id: id, month: '11508', time: time, dept: '一部', section: '北一課',
  empId: 'A1', staffName: '測試員', storeCode: code, storeName: name, storeType: '可拍照',
  total: 90, grade: '合格', staffCount: '1', identity: '店長', note: '',
  detail: {}, observation: {}, photos: {}, paperPhotos: [],
});
ctx.submitRecord(rec('THIS_WEEK', '2026-08-24 09:00', '000001', '本週店'));
ctx.submitRecord(rec('LAST_WEEK', '2026-08-21 15:00', '000002', '上週五店'));

assertEqual(ctx.updateRecord('11508', 'THIS_WEEK', rec('THIS_WEEK', '2026-08-24 09:30', '000001', '本週店'), ''),
  { ok: true }, '當週紀錄不需密碼即可修改');

// ===== 4. 跨週紀錄：沒密碼或密碼錯 → 擋下，且不可寫入 =====
const before = ctx.queryRecords('11508', { from: '2026-08-01', to: '2026-08-31' }).find(r => r.id === 'LAST_WEEK');
const noPass = ctx.updateRecord('11508', 'LAST_WEEK', rec('LAST_WEEK', '2026-08-21 15:00', '000002', '被改掉的店名'), '');
assertEqual(noPass.ok, false, '跨週且無密碼應被擋下');
assertEqual(noPass.code, 'CROSS_WEEK', '應回 CROSS_WEEK 供前端提示');
assertEqual(noPass.message.indexOf('2026-08-21') >= 0, true, '訊息應指出是哪一天的紀錄');
const wrong = ctx.updateRecord('11508', 'LAST_WEEK', rec('LAST_WEEK', '2026-08-21 15:00', '000002', 'X'), '9999');
assertEqual(wrong.ok, false, '密碼錯誤應被擋下');
const after = ctx.queryRecords('11508', { from: '2026-08-01', to: '2026-08-31' }).find(r => r.id === 'LAST_WEEK');
assertEqual(after.storeName, before.storeName, '被擋下時資料必須完全沒有被改到');

// ===== 5. 最重要：不可把時間改成本週來繞過 =====
const bypass = ctx.updateRecord('11508', 'LAST_WEEK',
  rec('LAST_WEEK', '2026-08-24 09:00', '000002', '想用改時間繞過'), '');
assertEqual(bypass.ok, false, '把送出的時間改成本週也不能繞過（判斷用原紀錄的時間）');
assertEqual(bypass.code, 'CROSS_WEEK', '仍應回 CROSS_WEEK');

// ===== 6. 正確密碼可以修改 =====
assertEqual(ctx.updateRecord('11508', 'LAST_WEEK', rec('LAST_WEEK', '2026-08-21 16:00', '000002', '已核准修改'), '2468'),
  { ok: true }, '密碼正確應可修改跨週紀錄');
assertEqual(ctx.queryRecords('11508', { from: '2026-08-01', to: '2026-08-31' }).find(r => r.id === 'LAST_WEEK').storeName,
  '已核准修改', '修改應真的寫入');

// ===== 7. 刪除同樣把關 =====
assertEqual(ctx.deleteRecord('11508', 'LAST_WEEK', '').ok, false, '跨週刪除無密碼應被擋下');
assertEqual(ctx.queryRecords('11508', {}).some(r => r.id === 'LAST_WEEK'), true, '被擋下時紀錄不可被刪掉');
assertEqual(ctx.deleteRecord('11508', 'THIS_WEEK', '').ok, true, '當週刪除不需密碼');
assertEqual(ctx.deleteRecord('11508', 'LAST_WEEK', '2468').ok, true, '密碼正確可刪跨週紀錄');
assertEqual(ctx.queryRecords('11508', {}).some(r => r.id === 'LAST_WEEK'), false, '確實已刪除');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
