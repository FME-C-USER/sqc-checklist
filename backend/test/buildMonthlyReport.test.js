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
  // 店鋪名單_11507：兩家店同課，只有一家會被點檢（測試「未點檢」計算）；店鋪型態＝「隨盤點點檢店」，驗證不會被誤用成拍照類型
  ctx.upsertRow('roster', '11507', { 店號: '017246', 店名: '基隆武勝店', 課別: '北三課', 店鋪型態: '隨盤點點檢店', 遠程店: '是', 假日店: '否', 預排梯次: '第一梯' });
  ctx.upsertRow('roster', '11507', { 店號: '020847', 店名: '台東四維店', 課別: '北三課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: '第一梯' });
  // 店號重新編號情境：名單上是舊碼(025604)，店鋪主檔已換成新碼(026045)，店名也差一個「店」字尾
  // 應仍能以店名比對到店鋪主檔資訊，不能因為店號不同就找不到
  ctx.upsertRow('stores', null, { 序號: 2, 店號: '026045', 店名: '淡水新崙店', 營業本部名稱: '北一本部', 營業部名稱: '北一二區', 營業課名稱: '北東四課', 營業擔當: '吳晉宏' });
  ctx.upsertRow('roster', '11507', { 店號: '025604', 店名: '淡水新崙', 課別: '北一課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: '第一梯' });
  // 點檢人員主檔：測試部/課對照表去重
  ctx.upsertRow('staff', null, { 部別: '一部', 課別: '北三課', 工號: 'A001', 姓名: '測試員', 職稱: '', AD帳號: '', 角色: '點檢人員' });
  ctx.upsertRow('staff', null, { 部別: '一部', 課別: '北三課', 工號: 'A002', 姓名: '測試員2', 職稱: '', AD帳號: '', 角色: '點檢人員' });
  // 觀察題
  ctx.upsertRow('obs', '11507', { 排序: 1, 編號: 'O1', 類型: '有無', 題目名稱: '店舖有無對外廁所', 選項: '有|無', 顯示條件: 'always', 必填: '' });
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
    observation: { toilet: { O1: '無' }, obsText: '' },
    photos: {
      '115年07月/1.店外海報/缺失': ['017246_2026-07-15_店外海報缺失_1.jpg'],
      // 觀察區照片：App 在「觀察題」活頁未匯入時會用內建預設題名建資料夾，報表必須照樣對得上
      '115年07月/重點觀察題1.【店外全景照】': ['ko1.jpg'],
      '115年07月/廁所觀察/廁所乾淨無髒污及垃圾桶無明顯滿溢/缺失': ['t1.jpg'],
    }, paperPhotos: [],
  });
  // 該筆紀錄的照片完成上傳並回寫雲端連結
  ctx.attachPhotoLinks('11507', 'R1', {
    '115年07月/1.店外海報/缺失': [{ name: '017246_2026-07-15_店外海報缺失_1.jpg', fileId: 'FILE_A' }],
    '115年07月/重點觀察題1.【店外全景照】': [{ name: 'ko1.jpg', fileId: 'FILE_KO1' }],
    '115年07月/廁所觀察/廁所乾淨無髒污及垃圾桶無明顯滿溢/缺失': [{ name: 't1.jpg', fileId: 'FILE_T1' }],
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
assertEqual(row.店型態, '隨盤點點檢店', '店型態應來自店鋪名單(角色/名單分類)，而非拍照類型');
assertEqual(row.拍照類型, '可拍照', '拍照類型應來自紀錄本身，與店型態是不同欄位');
assertEqual(row.photoGroups['1.店外海報/缺失'], ['https://drive.google.com/file/d/FILE_A/view'], '已回寫連結的照片應出現在photoGroups(去掉月份資料夾前綴)');

// 報表(前端)是以資料夾名稱前綴比對觀察區照片，這裡驗證後端回傳的 key 確實符合該前綴約定，
// 否則「課長版觀察區沒有照片連結」的問題會再次發生
const groupKeys = Object.keys(row.photoGroups);
assertEqual(groupKeys.filter(k => k.indexOf('重點觀察題1') === 0), ['重點觀察題1.【店外全景照】'], '重點觀察題照片的key應以「重點觀察題1」開頭');
assertEqual(row.photoGroups['重點觀察題1.【店外全景照】'], ['https://drive.google.com/file/d/FILE_KO1/view'], '重點觀察題1應帶出雲端連結');
assertEqual(groupKeys.filter(k => k.indexOf('廁所觀察/') === 0).length, 1, '廁所觀察缺失照片的key應以「廁所觀察/」開頭');
assertEqual(row.photoGroups['廁所觀察/廁所乾淨無髒污及垃圾桶無明顯滿溢/缺失'], ['https://drive.google.com/file/d/FILE_T1/view'], '廁所觀察缺失照片應帶出雲端連結');

assertEqual(report.obsList.length, 1, '應回傳觀察題定義供報表產生欄位使用');
assertEqual(report.obsList[0].id, 'O1', '觀察題編號');

assertEqual(report.deptSectionList.length, 1, '部/課對照表應依點檢人員主檔去重(2位同課員工只算1筆)');
assertEqual(report.deptSectionList[0], { 部: '一部', 課: '北三課' }, '部/課對照內容');

const rosterEntry = report.roster.find(r => r.店號 === '017246');
assertEqual(rosterEntry.營業部, '北一二區', '名單也應帶出店鋪主檔資訊(供未點檢店也能顯示部別/擔當)');
assertEqual(rosterEntry.營業擔當, '王小明', '名單應帶出營業擔當');

// 店號重新編號(舊碼025604 vs 主檔新碼026045)，仍應靠店名比對到店鋪主檔資訊
const renamedEntry = report.roster.find(r => r.店號 === '025604');
assertEqual(renamedEntry.營業部, '北一二區', '店號不同但店名對得上，仍應帶出店鋪主檔的營業部(以店名為主比對)');
assertEqual(renamedEntry.營業擔當, '吳晉宏', '店號不同但店名對得上，仍應帶出營業擔當');

assertEqual(report.kpi.length, 2, 'KPI應有2個課別(北三課+新增的北一課)');
const kpiByDept = {}; report.kpi.forEach(k => { kpiByDept[k.課別] = k; });
const kpi = kpiByDept['北三課'];
assertEqual(kpi.課別, '北三課', 'KPI課別');
assertEqual(kpi.應點檢, 2, '應點檢=名單2家');
assertEqual(kpi.已點檢, 1, '已點檢=1家');
assertEqual(kpi.未點檢, 1, '未點檢=1家');
assertEqual(kpi.完成率, '50%', '完成率應為50%');
assertEqual(kpi.合格家數, 1, '合格家數(>=85分)應為1');
assertEqual(kpi.平均分, 90, '平均分應為90');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
