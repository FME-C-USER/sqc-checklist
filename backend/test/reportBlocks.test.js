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

// 梯次表要用店號比對「這家店有沒有被點過」，normCode 定義在更上面
const normCodeSrc = grab('function normCode(', '\n');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(normCodeSrc + '\n' + code + '\nthis.__api = { buildDailyCountBlock, buildBatchBlock, buildKpiBlock };', sandbox);
const { buildDailyCountBlock, buildBatchBlock, buildKpiBlock } = sandbox.__api;

// ===== 測資：8/1(六) 7家、8/3(一) 127家；第一梯已完成、第二梯未開始 =====
// 梯次表是以「店號」把名單與紀錄對起來的，測資的店號必須真的對得上（實務資料一定有店號）
const mk = (date, dept, section, batch, score, name, code) => ({
  點檢時間: date + ' 10:00', 主責部: dept, 主責課: section, 預排梯次: batch, 合計: score, 店名: name,
  店號: code,
});
const seq = (n, from) => Array.from({ length: n }, (_, i) => String(from + i).padStart(6, '0'));
const N1A = seq(100, 1), N1B = seq(44, 101), TC = seq(60, 201), YW = seq(10, 301);
const rows = []
  .concat(N1A.slice(0, 3).map((c, i) => mk('2026-08-01', '一部', '北一課', '第一梯', 90, 'a' + i, c)))
  .concat(TC.slice(0, 4).map((c, i) => mk('2026-08-01', '二部', '台中課', '第一梯', 95, 'b' + i, c)))
  .concat(N1A.slice(3, 70).map((c, i) => mk('2026-08-03', '一部', '北一課', '第一梯', 90, 'c' + i, c)))
  .concat(TC.slice(4, 58).map((c, i) => mk('2026-08-03', '二部', '台中課', '第一梯', 80, 'd' + i, c)))
  .concat(YW.slice(0, 6).map((c, i) => mk('2026-08-03', '業務部', '業務課', '第一梯', 93, 'e' + i, c)));
const ros = (code, section, batch) => ({ 店號: code, 課別: section, 預排梯次: batch });
const roster = []
  .concat(N1A.map(c => ros(c, '北一課', '第一梯')))
  .concat(N1B.map(c => ros(c, '北一課', '第二梯')))
  .concat(TC.map(c => ros(c, '台中課', '第一梯')))
  .concat(YW.map(c => ros(c, '業務課', '第一梯')));
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
// 百分比輸出比例數值(0~1)由Excel套百分比格式；不可是字串，否則無法計算
assertEqual(typeof total[4], 'number', '完成率應為數值(非字串)');
assertEqual(total[4].toFixed(4), (134 / 214).toFixed(4), '完成率=134/214');
const sec1 = kpi.find(r => r[0] === '北一課');
assertEqual(sec1[1], 144, '北一課應點檢=100+44');
assertEqual(sec1[2], 70, '北一課已點檢=3+67');
assertEqual(sec1[6], 0, '北一課不合格家數=0(皆90分)');
const sec2 = kpi.find(r => r[0] === '台中課');
assertEqual(sec2[6], 54, '台中課不合格家數=54(80分那批)');
assertEqual(sec2[7].toFixed(4), (54 / 58).toFixed(4), '台中課不合格佔比=54/58');
assertEqual(typeof sec2[8], 'number', '平均分數應為數值(由Excel套兩位小數格式)');
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
// 全部點完時，實際必須等於預計（執行率 100%）—— 這是使用者驗收梯次表的方式
const allDone = {
  passScore: 85,
  roster: N1A.concat(N1B).map(c => ros(c, '北一課', N1A.indexOf(c) >= 0 ? '第一梯' : '第二梯')),
  rows: N1A.concat(N1B).map((c, i) => Object.assign(
    mk('2026-08-03', '一部', '北一課', '', 90, 'z' + i, c), { 實際梯次: i < 100 ? '第一梯' : '第二梯' })),
};
const done = buildBatchBlock(allDone, '8/1-8/31')[2];
assertEqual(done, ['合計', 100, 100, 44, 44], '全部點完時每一梯的實際＝預計（執行率100%）');

// ===== 3c. 脫期：預排第二梯、實際在第一梯點完 → 預計也要跟著移到第一梯 =====
//   否則第一梯永遠 1 家沒預計卻有實際、第二梯永遠差 1 家，全部點完也到不了 100%。
const late = {
  passScore: 85,
  roster: [ros('000001', '北一課', '第一梯'), ros('000002', '北一課', '第二梯')],
  rows: [Object.assign(mk('2026-08-05', '一部', '北一課', '', 90, '脫期店', '000002'), { 實際梯次: '第一梯' })],
};
const lateBlock = buildBatchBlock(late, '8/1-8/31');
// 兩家店的有效梯次都變成第一梯（一家原本就是、一家脫期補點），所以只剩第一梯這一組欄位
assertEqual(lateBlock[0], ['期間', '第一梯', ''], '預計搬到第一梯後，第二梯已無店可算，欄位不再出現');
assertEqual(lateBlock[2], ['合計', 2, 1], '脫期店的預計跟著搬到第一梯（預計2、實際1）');
// 那一家補點完之後，第一梯就會是 2/2 → 執行率 100%
const lateDone = {
  passScore: 85, roster: late.roster,
  rows: late.rows.concat([Object.assign(mk('2026-08-05', '一部', '北一課', '', 91, '準時店', '000001'), { 實際梯次: '第一梯' })]),
};
assertEqual(buildBatchBlock(lateDone, '8/1-8/31')[2], ['合計', 2, 2], '含脫期店在內全部點完後，執行率為100%');

// ===== 3d. 合計必須等於總店數：名單外自行新增的店與判不出梯次的店都不可以憑空消失 =====
const odd = {
  passScore: 85,
  roster: [ros('000001', '北一課', '第一梯'), ros('000002', '北一課', '')],   // 第二家名單上沒填預排
  rows: [
    Object.assign(mk('2026-08-05', '一部', '北一課', '', 90, '名單外店', '009999'), { 實際梯次: '第一梯' }),
    Object.assign(mk('2026-08-06', '一部', '北一課', '', 88, '沒梯次店', '000002'), { 實際梯次: '' }),
  ],
};
const oddBlock = buildBatchBlock(odd, '8/1-8/31');
assertEqual(oddBlock[0], ['期間', '第一梯', '', '(未列梯次)', ''], '判不出梯次的要有自己的欄位，不可被丟掉');
const oddTotal = oddBlock[2];
assertEqual(oddTotal[1] + oddTotal[3], 3, '預計合計＝名單2家＋名單外1家');
assertEqual(oddTotal[2] + oddTotal[4], 2, '實際合計＝已點檢2家（與紀錄筆數相同）');

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


// ===== 缺失子項的文字：填寫型子項只呈現人工key入的名稱 =====
//   2026-08-24：中和景會店第12題勾了「其他貨架」並填「報架，其他」，
//   原本輸出「其他貨架、報架，其他」，但人工版只要「報架，其他」。
//   一般子項（口巧、TM前貨架）仍用子項名稱本身。
(function () {
  const { ctx } = require('./gas-fake-env').loadGasFile(require('path').join(__dirname, '..', '程式碼.gs'));
  ctx.ensureSheetNamed('設定', ['參數', '值']);
  ctx.ensureMonth('11508');
  ctx.upsertItem('11508', { 排序: 1, 編號: 'A12', 大分類: '商品陳列', 題號名稱: '12.價格清楚標示', 配分: 12,
    計分方式: '分區扣分', 每項扣分: 2, 子項清單: 'OC|WI|冷凍櫃|口巧|零食|加工|TM前貨架|其他貨架:填寫' });
  ctx.upsertRow('roster', '11508', { 店號: '000001', 店名: '中和景會店', 課別: '北一課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: '' });
  ctx.upsertRow('roster', '11508', { 店號: '000002', 店名: 'B店', 課別: '北一課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: '' });
  const rec = (id, code, name, detail) => ({
    id, month: '11508', time: '2026-08-24 10:00', dept: '一部', section: '北一課',
    empId: 'A1', staffName: '測試員', storeCode: code, storeName: name, storeType: '可拍照',
    total: 96, grade: '優良', staffCount: '1', identity: '店長', note: '',
    detail: detail, observation: {}, photos: {}, paperPhotos: [],
  });
  // 中和景會店：勾「其他貨架」並人工填入兩個貨架名稱
  ctx.submitRecord(rec('R1', '000001', '中和景會店', {
    A12: { name: '12.價格清楚標示', score: 8, ngSubs: ['其他貨架'], customNames: { '其他貨架': '報架，其他' } },
  }));
  // B店：只勾一般子項，沒有填寫型
  ctx.submitRecord(rec('R2', '000002', 'B店', {
    A12: { name: '12.價格清楚標示', score: 10, ngSubs: ['口巧'], customNames: {} },
  }));
  const rep = ctx.buildMonthlyReport('11508', { from: '2026-08-01', to: '2026-08-31' }, true);
  const byStore = {};
  rep.rows.forEach(r => { byStore[r.店名] = r.itemExtra['A12']; });
  assertEqual(byStore['中和景會店'], '報架，其他', '填寫型子項只輸出人工key入的名稱，不含「其他貨架」標籤');
  assertEqual(byStore['B店'], '口巧', '一般子項仍輸出子項名稱本身');
})();


console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
