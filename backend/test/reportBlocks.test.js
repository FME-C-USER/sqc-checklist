// 回歸測試：課長版新增的三個區塊（每日店數表／課別KPI表／梯次表）
//   這些函式定義在 app.html 的模組層，測試時用正規表示式抽出後在 Node 執行，
//   確保驗的是實際出貨的程式碼而不是另外複製一份。
// 執行方式：node backend/test/reportBlocks.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// 從 app.html 抽出報表區塊相關的模組層程式碼
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
const grab = (startMarker, endMarker) => {
  const s = html.indexOf(startMarker);
  const e = html.indexOf(endMarker, s);
  if (s < 0 || e < 0) throw new Error('抽取失敗：找不到 ' + startMarker);
  return html.slice(s, e);
};
// 這一整段（日期工具 → 每日店數表 → 課別排序 → KPI表 → 梯次表）都在 window.SqcReport 之前
const code = grab('// ===== 每日店數表', 'window.SqcReport =');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(code + '\nthis.__api = { buildDailyCountBlock, buildBatchBlock, buildKpiBlock };', sandbox);
const { buildDailyCountBlock, buildBatchBlock, buildKpiBlock } = sandbox.__api;

// ===== 測資：8/1(六) 7家、8/3(一) 127家；第一梯已完成、第二梯未開始 =====
const mk = (date, dept, section, batch, score, name) => ({
  點檢時間: date + ' 10:00', 主責部: dept, 主責課: section, 預排梯次: batch, 合計: score, 店名: name,
});
const rows = []
  .concat(Array.from({ length: 3 }, (_, i) => mk('2026-08-01', '一部', '北一課', '第一梯', 90, 'a' + i)))
  .concat(Array.from({ length: 4 }, (_, i) => mk('2026-08-01', '二部', '台中課', '第一梯', 95, 'b' + i)))
  .concat(Array.from({ length: 67 }, (_, i) => mk('2026-08-03', '一部', '北一課', '第一梯', 90, 'c' + i)))
  .concat(Array.from({ length: 54 }, (_, i) => mk('2026-08-03', '二部', '台中課', '第一梯', 80, 'd' + i)))
  .concat(Array.from({ length: 6 }, (_, i) => mk('2026-08-03', '業務部', '業務課', '第一梯', 93, 'e' + i)));
const roster = []
  .concat(Array.from({ length: 100 }, () => ({ 課別: '北一課', 預排梯次: '第一梯' })))
  .concat(Array.from({ length: 44 }, () => ({ 課別: '北一課', 預排梯次: '第二梯' })))
  .concat(Array.from({ length: 60 }, () => ({ 課別: '台中課', 預排梯次: '第一梯' })))
  .concat(Array.from({ length: 10 }, () => ({ 課別: '業務課', 預排梯次: '第一梯' })));
const report = { rows, roster, passScore: 85 };

// ===== 1. 每日店數表 =====
const daily = buildDailyCountBlock(report, '2026-08-01', '2026-08-16');
assertEqual(daily[0], ['星期', '六', '日', '一', '二', '三', '四', '五'], '星期列應依起始日對齊(8/1/2026是星期六)');
assertEqual(daily[1], ['日期', '08/01', '08/02', '08/03', '08/04', '08/05', '08/06', '08/07'], '第一週日期');
assertEqual(daily[2], ['合計', 7, 0, 127, 0, 0, 0, 0], '第一週合計(8/1=7家、8/3=127家)');
assertEqual(daily[3], ['一部', 3, 0, 67, 0, 0, 0, 0], '第一週一部');
assertEqual(daily[4], ['二部', 4, 0, 54, 0, 0, 0, 0], '第一週二部');
assertEqual(daily[5], ['業務部', 0, 0, 6, 0, 0, 0, 0], '第一週業務部');
assertEqual(daily[6][1], '08/08', '第二週應接續 08/08');
// 8/1~8/16 共16天 → 補滿3週(21天)，每週5列(日期+合計+3個部)
assertEqual(daily.length, 1 + 3 * 5, '應補滿整週：星期列1 + 3週×5列');

// ===== 2. 課別KPI表 =====
const kpi = buildKpiBlock(report, '8/1-8/16');
assertEqual(kpi[1][0], '合計', '第一列應為合計');
assertEqual(kpi.slice(1).map(r => r[0]), ['合計', '北一課', '一部', '台中課', '二部', '業務課', '業務部'], '列順序：合計→各課→該部小計');
// 表頭與資料列欄數必須一致（曾因表頭多一欄導致整列錯位）
assertEqual(kpi[0].length, kpi[1].length, '表頭欄數應與資料列相同');
assertEqual(kpi[0][0].indexOf('期間') === 0, true, '第一欄標頭應為期間');
const total = kpi[1];
assertEqual(total[1], 214, '合計應點檢=名單214家');
assertEqual(total[2], 134, '合計已點檢=134家');
assertEqual(total[3], 80, '合計未點檢=80家');
assertEqual(total[4], '62.62%', '完成率=134/214');
const sec1 = kpi.find(r => r[0] === '北一課');
assertEqual(sec1[1], 144, '北一課應點檢=100+44');
assertEqual(sec1[2], 70, '北一課已點檢=3+67');
assertEqual(sec1[6], 0, '北一課不合格家數=0(皆90分)');
const sec2 = kpi.find(r => r[0] === '台中課');
assertEqual(sec2[6], 54, '台中課不合格家數=54(80分那批)');
assertEqual(sec2[7], '93.10%', '台中課不合格佔比=54/58');
assertEqual(sec2[11].split('、').length, 54, '不及格店名單應列在最後一欄(台中課54家)');

// ===== 3. 梯次表 =====
const batch = buildBatchBlock(report, '8/1-8/16');
assertEqual(batch[0], ['期間', '第一梯', '', '第二梯', ''], '梯次表頭');
assertEqual(batch[1], ['8/1-8/16', '預計點檢店數', '實際點檢店數', '預計點檢店數', '實際點檢店數'], '第二層表頭');
const bTotal = batch[2];
assertEqual(bTotal, ['合計', 170, 134, 44, 0], '合計：第一梯預計170/實際134、第二梯預計44/實際0');
const b1 = batch.find(r => r[0] === '北一課');
assertEqual(b1, ['北一課', 100, 70, 44, 0], '北一課梯次數字');
assertEqual(batch.slice(2).map(r => r[0]), ['合計', '北一課', '一部', '台中課', '二部', '業務課', '業務部'], '梯次表列順序同KPI表');

// ===== 3b. 不及格店只列在課別列，合計列與部小計列不重複列出 =====
const failCase = {
  passScore: 85,
  deptSectionList: [{ 部: '一部', 課: '北二課' }, { 部: '一部', 課: '北三課' }],
  roster: [{ 課別: '北二課', 預排梯次: '第一梯' }, { 課別: '北三課', 預排梯次: '第一梯' }],
  rows: [
    mk('2026-08-03', '一部', '北二課', '第一梯', 82, '永和田單店'),
    mk('2026-08-03', '一部', '北三課', '第一梯', 80, '南港車站店'),
  ],
};
const fk = buildKpiBlock(failCase, 'x');
const failCol = fk[0].length - 1;
const fkBy = {}; fk.slice(1).forEach(r => { fkBy[r[0]] = r[failCol]; });
assertEqual(fkBy['北二課'], '永和田單店', '不及格店應列在該課別列');
assertEqual(fkBy['北三課'], '南港車站店', '不及格店應列在該課別列');
assertEqual(fkBy['合計'], '', '合計列不可重複列出不及格店');
assertEqual(fkBy['一部'], '', '部小計列不可重複列出不及格店');

// ===== 3c. 零點檢的課別也要排在所屬部之下（靠點檢人員主檔的部課對照）=====
const zeroCase = {
  passScore: 85,
  deptSectionList: [
    { 部: '一部', 課: '北一課' }, { 部: '一部', 課: '北二課' }, { 部: '一部', 課: '桃竹課' },
    { 部: '二部', 課: '台中課' }, { 部: '業務部', 課: '業務課' },
  ],
  roster: ['北一課', '北二課', '桃竹課', '台中課', '業務課'].map(s => ({ 課別: s, 預排梯次: '第一梯' })),
  rows: [mk('2026-08-03', '一部', '北一課', '第一梯', 90, 'z')], // 只有北一課有紀錄
};
assertEqual(buildKpiBlock(zeroCase, 'x').slice(1).map(r => r[0]),
  ['合計', '北一課', '北二課', '桃竹課', '一部', '台中課', '二部', '業務課', '業務部'],
  '零點檢課別仍應歸在所屬部之下，不可被丟到最後的(未分類)');
assertEqual(buildBatchBlock(zeroCase, 'x').slice(2).map(r => r[0]),
  ['合計', '北一課', '北二課', '桃竹課', '一部', '台中課', '二部', '業務課', '業務部'],
  '梯次表列順序應與KPI表一致');

// ===== 4. 課別排序：中文數字須按數值（不可是字元編碼順序）=====
const many = {
  rows: ['北一課', '北二課', '北三課', '北四課', '桃竹課'].map(s => mk('2026-08-03', '一部', s, '第一梯', 90, s)),
  roster: ['北四課', '北一課', '桃竹課', '北三課', '北二課'].map(s => ({ 課別: s, 預排梯次: '第一梯' })),
  passScore: 85,
};
assertEqual(buildKpiBlock(many, 'x').slice(1).map(r => r[0]),
  ['合計', '北一課', '北二課', '北三課', '北四課', '桃竹課', '一部'], '課別應按中文數字數值排序');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
