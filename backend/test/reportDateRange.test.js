// 回歸測試：報表/請款必須依「查詢的起訖日期」取資料
//   原本前端只傳 section、沒傳日期，導致不論日期範圍設多少都會抓整個月來算，
//   請款金額可能因此多算（畫面顯示的店數與實際請款內容不一致）。
//   這裡驗證後端 buildMonthlyReport 確實會依 from/to 過濾，且金額隨之改變。
// 執行方式：node backend/test/reportDateRange.test.js
const path = require('path');
const { loadGasFile } = require('./gas-fake-env');
const billing = require('../../js/billing.js');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const { ctx } = loadGasFile(GS_PATH);
ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.ensureMonth('11508');
ctx.upsertItem('11508', { 排序: 1, 編號: 'A1', 大分類: '活動告示', 題號名稱: '1.店外海報', 配分: 100, 計分方式: '合格0分', 每項扣分: '', 子項清單: '' });

// 8月上半月2家、下半月1家（皆一般店，方便用金額驗證）
const rec = (id, day, code, name) => ({
  id: id, month: '11508', time: '2026-08-' + day + ' 10:00',
  dept: '一部', section: '北一課', empId: 'A001', staffName: '測試員',
  storeCode: code, storeName: name, storeType: '可拍照',
  total: 100, grade: '優良', staffCount: '1', identity: '店長', note: '',
  detail: {}, observation: {}, photos: {}, paperPhotos: [],
});
ctx.upsertRow('roster', '11508', { 店號: '000001', 店名: 'A店', 課別: '北一課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: '' });
ctx.upsertRow('roster', '11508', { 店號: '000002', 店名: 'B店', 課別: '北一課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: '' });
ctx.upsertRow('roster', '11508', { 店號: '000003', 店名: 'C店', 課別: '北一課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: '' });
ctx.submitRecord(rec('R1', '05', '000001', 'A店'));
ctx.submitRecord(rec('R2', '12', '000002', 'B店'));
ctx.submitRecord(rec('R3', '25', '000003', 'C店'));

// ===== 整月：3家 =====
const full = ctx.buildMonthlyReport('11508', { from: '2026-08-01', to: '2026-08-31' }, true);
assertEqual(full.rows.length, 3, '整月(8/1-8/31)應取到3家');
const bFull = billing.buildBillingSheets(full, full.pricing, {}, { from: '2026-08-01', to: '2026-08-31' });
assertEqual(bFull.家數, 3, '整月請款店數應為3');
assertEqual(bFull.總表.未稅, 3 * 245 + 6500, '整月未稅=3*245+文件處理費6500');

// ===== 上半月：只有2家（這是修正前會失效的關鍵案例）=====
const half = ctx.buildMonthlyReport('11508', { from: '2026-08-01', to: '2026-08-15' }, true);
assertEqual(half.rows.length, 2, '上半月(8/1-8/15)應只取到2家，不可抓整月');
const bHalf = billing.buildBillingSheets(half, half.pricing, {}, { from: '2026-08-01', to: '2026-08-15' });
assertEqual(bHalf.家數, 2, '上半月請款店數應為2');
assertEqual(bHalf.總表.未稅, 2 * 245 + 6500, '上半月未稅應隨之減少');

// ===== 單日 =====
const oneDay = ctx.buildMonthlyReport('11508', { from: '2026-08-12', to: '2026-08-12' }, true);
assertEqual(oneDay.rows.length, 1, '單日(8/12)應只取到1家');
assertEqual(oneDay.rows[0].店名, 'B店', '單日取到的應為當天那家店');

// ===== KPI 的已點檢也應隨日期範圍變動（應點檢仍為名單3家）=====
assertEqual(half.kpi[0].應點檢, 3, '應點檢以當月名單為分母，不受日期範圍影響');
assertEqual(half.kpi[0].已點檢, 2, '已點檢應依日期範圍計算');

// ===== 單價來自「設定」活頁；未設定時用內建預設 =====
assertEqual(full.pricing.平日點檢費, 245, '未設定時單價用內建預設245（單價僅回傳給管理者）');
assertEqual(ctx.buildMonthlyReport('11508', {}, false).pricing, null, '非管理者不應取得單價');
const shSet = ctx.ssBook().getSheetByName('設定');
shSet.appendRow(['平日點檢費', 260]);
const priced = ctx.buildMonthlyReport('11508', { from: '2026-08-01', to: '2026-08-31' }, true);
assertEqual(priced.pricing.平日點檢費, 260, '設定活頁調價後應改用新單價');
const bPriced = billing.buildBillingSheets(priced, priced.pricing, {}, { from: '2026-08-01', to: '2026-08-31' });
assertEqual(bPriced.總表.未稅, 3 * 260 + 6500, '調價後金額應跟著變（證明調價不需改程式）');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
