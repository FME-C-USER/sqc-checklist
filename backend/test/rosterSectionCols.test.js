// 回歸測試：查核店鋪名單的「營業課」與「主責課」是兩回事，且主責課要跟著實際點檢課
//   使用者 2026-08-26 指出：D/E/F 三欄是營業組織（部／課／擔當，取自店鋪主檔），
//   但 E 欄原本誤用店鋪名單的課別 —— 結果它與後面的「主責課」欄完全重複，
//   真正的營業課反而沒有出現在報表裡。課長版與客戶版都要改。
//   另外：實際點檢課與實際梯次是同一個規則 —— 實際由哪一課點的，主責課就改成那一課，
//   而且「主責課店數」（KPI 的應點檢、梯次表的預計）要跟著搬，否則原課永遠掛著未點檢、
//   新課出現已點檢大於應點檢，兩邊的完成率都到不了 100%。
// 執行方式：node backend/test/rosterSectionCols.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. 後端要把營業課帶出來（原本只帶了營業部與營業擔當）=====
const { ctx } = loadGasFile(GS_PATH);
ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.ensureMonth('11508');
ctx.upsertRow('stores', null, {
  序號: 1, 店號: '025129', 店名: '基隆新大慶店', 營業本部名稱: '北一本部',
  營業部名稱: '北一一區', 營業課名稱: '基隆課', 營業擔當: '李貞慧', 地址: '基隆市中山區中和路170號',
});
ctx.upsertRow('roster', '11508', {
  店號: '025129', 店名: '基隆新大慶店', 課別: '北三課', 店鋪型態: '一般店',
  遠程店: '否', 假日店: '否', 預排梯次: '第二梯',
});
const rep = ctx.buildMonthlyReport('11508', { from: '2026-08-01', to: '2026-08-31' }, true);
const r0 = rep.roster[0];
assertEqual(r0.營業課, '基隆課', '營業課要取自店鋪主檔的「營業課名稱」');
assertEqual(r0.營業部, '北一一區', '營業部照舊');
assertEqual(r0.課別, '北三課', '名單的課別（主責課）不受影響，兩者是不同的東西');

// ===== 2. 前端表頭：兩個版本都要叫「營業課」，且 E 欄取營業課 =====
assertEqual(/'序', '既存店號', '店舖名稱', '部別', '營業課', '擔當', '地址', '隨盤點', '預排梯次'/.test(APP), true,
  '客戶版表頭要用「營業課」');
assertEqual(/'序', '既存店號', '店舖名稱', '部別', '營業課', '擔當', '地址', '隨盤點', '實際點檢課'/.test(APP), true,
  '課長版表頭要用「營業課」');
assertEqual(APP.includes("'課別', '擔當', '地址'"), false, '不可再有叫「課別」的欄位（會與主責課混淆）');
assertEqual(/const common = \[i \+ 1, padStoreCode\(s\.店號\), s\.店名, s\.營業部, s\.營業課, s\.營業擔當/.test(APP), true,
  'E 欄要取 s.營業課，不是 s.課別');

// ===== 3. 主責課要跟著實際點檢課（與梯次同一個規則）=====
assertEqual(APP.includes('(rec ? rec.主責課 : s.課別) || \'\''), true,
  '主責課欄：已點檢取實際、未點檢才用名單的課別');

// ===== 4. 主責課店數也要跟著搬 =====
const grab = (a, b) => { const s = APP.indexOf(a), e = APP.indexOf(b, s); if (s < 0 || e < 0) throw new Error('抽取失敗：' + a); return APP.slice(s, e); };
const normCodeSrc = grab('function normCode(', '\n');
const code = grab('// ===== 每日店數表', 'window.SqcReport =');
const sb = { window: {}, console };
vm.createContext(sb);
vm.runInContext(normCodeSrc + '\n' + code + '\nthis.api = { buildKpiBlock, buildBatchBlock, effSectionOf };', sb);
const { buildKpiBlock, buildBatchBlock, effSectionOf } = sb.api;

// 有效課別：點過的用實際，沒點的用名單
const report = {
  passScore: 85,
  deptSectionList: [{ 部: '一部', 課: '北三課' }, { 部: '業務部', 課: '訓練課' }],
  roster: [
    { 店號: '000001', 課別: '北三課', 預排梯次: '第一梯' },   // 未點檢
    { 店號: '000002', 課別: '北三課', 預排梯次: '第一梯' },   // 實際由訓練課點的
  ],
  rows: [
    { 店號: '000002', 主責課: '訓練課', 主責部: '業務部', 合計: 90, 店名: '換課店', 點檢時間: '2026-08-05 10:00', 實際梯次: '第一梯' },
  ],
};
const effSec = effSectionOf(report);
assertEqual(effSec('000001', '北三課'), '北三課', '沒點檢的店用名單的課別');
assertEqual(effSec('000002', '北三課'), '訓練課', '點過的店改用實際點檢的課別');
assertEqual(effSec('009999', ''), '(未分類)', '名單與紀錄都查不到時不可回 undefined');

const kpi = buildKpiBlock(report, '8/1-8/31');
const rowOf = (name) => kpi.find(r => r[0] === name);
assertEqual(rowOf('北三課').slice(1, 4), [1, 0, 1], '北三課：應點檢1、已點檢0、未點檢1（換課的那家已搬走）');
assertEqual(rowOf('訓練課').slice(1, 4), [1, 1, 0], '訓練課：應點檢1、已點檢1、未點檢0 → 完成率100%');
assertEqual(rowOf('合計').slice(1, 4), [2, 1, 1], '合計不變：應點檢仍是名單的2家');
// 沒有搬移的話會是「北三課 2/1」與「訓練課 0/1」—— 訓練課的已點檢大於應點檢，永遠算不出合理的完成率
assertEqual(rowOf('訓練課')[2] <= rowOf('訓練課')[1], true, '已點檢不可大於應點檢');

// 名單外自行新增的店要補進應點檢，否則已點檢會大於應點檢
const withExtra = {
  ...report,
  rows: report.rows.concat([{ 店號: '009999', 主責課: '訓練課', 主責部: '業務部', 合計: 88, 店名: '名單外店', 點檢時間: '2026-08-06 10:00', 實際梯次: '第一梯' }]),
};
const kpi2 = buildKpiBlock(withExtra, '8/1-8/31');
const t2 = kpi2.find(r => r[0] === '訓練課');
assertEqual(t2.slice(1, 4), [2, 2, 0], '名單外的店也要計入應點檢（2/2）');

// 梯次表的預計側同樣要按有效課別分組
const batch = buildBatchBlock(report, '8/1-8/31');
const b北三 = batch.find(r => r[0] === '北三課');
const b訓練 = batch.find(r => r[0] === '訓練課');
assertEqual(b北三.slice(1), [1, 0], '梯次表 北三課：預計1、實際0');
assertEqual(b訓練.slice(1), [1, 1], '梯次表 訓練課：預計1、實際1（預計跟著搬過來）');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
