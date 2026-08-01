// 回歸測試：月報表聚合邏輯（分類小計、部/課查找、KPI 完成率/合格率）
// 執行方式：node backend/test/buildMonthlyReport.test.js
const path = require('path');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

function seed(ctx) {
  ctx.ensureMonth('11507'); // 建齊題庫/觀察題/店鋪名單/點檢紀錄活頁
  // 題庫（跨兩大分類）
  ctx.upsertItem('11507', { 排序: 1, 編號: 'A1', 大分類: '活動告示', 題號名稱: '1.店外海報', 配分: 4, 計分方式: '合格0分', 每項扣分: '', 子項清單: '' });
  ctx.upsertItem('11507', { 排序: 2, 編號: 'B1', 大分類: '商品陳列', 題號名稱: '10.商品豐富陳列', 配分: 10, 計分方式: '分區扣分', 每項扣分: 2, 子項清單: 'X|Y|其他:填寫' });
  // 店鋪主檔（店的「營業」部課，跟盤點主責課是不同維度）
  ctx.upsertRow('stores', null, { 序號: 1, 店號: '017246', 店名: '基隆武勝店', 營業本部名稱: '北一本部', 營業部名稱: '北一二區', 營業課名稱: '台北一課', 營業擔當: '王小明' });
  // 店鋪名單_11507：兩家店同課，只有一家會被點檢（測試「未點檢」計算）
  ctx.upsertRow('roster', '11507', { 店號: '017246', 店名: '基隆武勝店', 課別: '北三課', 店鋪型態: '一般店', 遠程店: '是', 假日店: '否', 預排梯次: '第一梯' });
  ctx.upsertRow('roster', '11507', { 店號: '020847', 店名: '台東四維店', 課別: '北三課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: '第一梯' });
  // 及格分數設定
  const settingSh = ctx.ensureSheetNamed('設定', ['參數', '值']);
  settingSh.appendRow(['及格分數', 85]);
  // 送出一筆點檢紀錄（017246，主責課=北三課，跟其營業課"台北一課"刻意不同，驗證兩者不會混淆）
  ctx.submitRecord({
    id: 'R1', month: '11507', time: '2026-07-15 10:00',
    dept: '一部', section: '北三課', empId: 'A001', staffName: '測試員',
    storeCode: '017246', storeName: '基隆武勝店', storeType: '可拍照',
    total: 90, grade: '合格', staffCount: '2', identity: '店長', note: '',
    detail: { A1: { score: 4, ngSubs: [], customNames: {} }, B1: { score: 6, ngSubs: ['X'], customNames: {} } },
    observation: { toilet: { O1: '無' }, obsText: '' }, photos: {}, paperPhotos: [],
  });
}

const { ctx } = loadGasFile(GS_PATH);
seed(ctx);
const report = ctx.buildMonthlyReport('11507', {});

assertEqual(report.rows.length, 1, '應有1筆點檢紀錄');
const row = report.rows[0];
assertEqual(row.營業部, '北一二區', '營業部應來自店鋪主檔(非主責部)');
assertEqual(row.營業課別, '台北一課', '營業課別應來自店鋪主檔(非主責課)');
assertEqual(row.主責課, '北三課', '主責課應來自紀錄本身(盤點課別)，與營業課不同');
assertEqual(row.itemScores.A1, 4, 'A1得分應為4');
assertEqual(row.itemScores.B1, 6, 'B1(分區扣分)得分應為6(10-2*2)');
assertEqual(row.itemExtra.B1, 'X', 'B1應記錄缺失子項X');
assertEqual(row.分類小計['活動告示'], 4, '活動告示分類小計應為4');
assertEqual(row.分類小計['商品陳列'], 6, '商品陳列分類小計應為6');
assertEqual(row.遠程店, '是', '遠程店應從店鋪名單帶出');

assertEqual(report.kpi.length, 1, 'KPI應只有1個課別');
const kpi = report.kpi[0];
assertEqual(kpi.課別, '北三課', 'KPI課別');
assertEqual(kpi.應點檢, 2, '應點檢=名單2家');
assertEqual(kpi.已點檢, 1, '已點檢=1家');
assertEqual(kpi.未點檢, 1, '未點檢=1家');
assertEqual(kpi.完成率, '50%', '完成率應為50%');
assertEqual(kpi.合格家數, 1, '合格家數(>=85分)應為1');
assertEqual(kpi.平均分, 90, '平均分應為90');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
