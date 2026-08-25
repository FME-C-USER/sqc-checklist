// 回歸測試：梯次以「實際點檢日期」為準
//   名單檔右側附「梯次 / 評核日期區間」小表（每月不同），例如 第一梯 8/1-8/15、第二梯 8/16-8/31。
//   規則（使用者 2026-08-24 指定）：以實際為主 —— 實際點檢日期落在哪一梯就算哪一梯，
//   與名單的預排不符時，報表的梯次一律改用實際值。
//   名單原本的預排另存 原預排梯次，梯次表的「預計」側仍用它，兩者並列才看得出脫期。
// 執行方式：node backend/test/batchPeriods.test.js
const path = require('path');
const vm = require('vm');
const fs = require('fs');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
const APP_PATH = path.join(__dirname, '..', '..', 'app.html');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const { ctx } = loadGasFile(GS_PATH);
ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.ensureMonth('11508');

// ===== 1. 區間字串解析（民國年月 → 西元日期）=====
assertEqual(ctx.parseBatchRange('8/1-8/15', '11508'), { from: '2026-08-01', to: '2026-08-15' }, '8/1-8/15');
assertEqual(ctx.parseBatchRange('8/16-8/31', '11508'), { from: '2026-08-16', to: '2026-08-31' }, '8/16-8/31');
assertEqual(ctx.parseBatchRange('08/01-08/15', '11508'), { from: '2026-08-01', to: '2026-08-15' }, '補零寫法');
assertEqual(ctx.parseBatchRange(' 8/1 ~ 8/15 ', '11508'), { from: '2026-08-01', to: '2026-08-15' }, '波浪號與空白');
assertEqual(ctx.parseBatchRange('12/16-1/15', '11512'), { from: '2026-12-16', to: '2027-01-15' }, '跨年區間迄日年份要+1');
assertEqual(ctx.parseBatchRange('亂寫', '11508'), { from: '', to: '' }, '格式不對時回空，不可亂猜');
assertEqual(ctx.parseBatchRange('', '11508'), { from: '', to: '' }, '空字串');

// ===== 2. 存取梯次期間 =====
assertEqual(ctx.getBatchPeriods('11508'), [], '還沒匯入時回空陣列（呼叫端要能退回舊行為）');
const saved = ctx.saveBatchPeriods('11508', [
  { 梯次: '第一梯', 區間: '8/1-8/15' },
  { 梯次: '第二梯', 區間: '8/16-8/31' },
  { 梯次: '', 區間: '9/1-9/2' },        // 沒有梯次名稱的列要略過
]);
assertEqual(saved, 2, '只存下有梯次名稱的兩列');
assertEqual(ctx.getBatchPeriods('11508'), [
  { name: '第一梯', from: '2026-08-01', to: '2026-08-15' },
  { name: '第二梯', from: '2026-08-16', to: '2026-08-31' },
], '讀回的期間');

// ===== 3. 依日期判定梯次（含邊界）=====
const P = ctx.getBatchPeriods('11508');
assertEqual(ctx.batchOfDate(P, '2026-08-01'), '第一梯', '第一梯起日');
assertEqual(ctx.batchOfDate(P, '2026-08-15'), '第一梯', '第一梯迄日（含當日）');
assertEqual(ctx.batchOfDate(P, '2026-08-16'), '第二梯', '第二梯起日');
assertEqual(ctx.batchOfDate(P, '2026-08-31'), '第二梯', '第二梯迄日（含當日）');
assertEqual(ctx.batchOfDate(P, '2026-08-24 14:30'), '第二梯', '帶時間的字串也要能判斷');
assertEqual(ctx.batchOfDate(P, '2026-09-01'), '', '落在所有區間之外回空字串');
assertEqual(ctx.batchOfDate([], '2026-08-24'), '', '沒有梯次表時回空（報表會退回預排）');

// ===== 4. 報表：實際與預排不符時以實際為準 =====
const rec = (id, time, code, name) => ({
  id: id, month: '11508', time: time, dept: '一部', section: '北一課',
  empId: 'A1', staffName: '測試員', storeCode: code, storeName: name, storeType: '可拍照',
  total: 90, grade: '合格', staffCount: '1', identity: '店長', note: '',
  detail: {}, observation: {}, photos: {}, paperPhotos: [],
});
const roster = (code, name, batch) => ({ 店號: code, 店名: name, 課別: '北一課', 店鋪型態: '一般店', 遠程店: '否', 假日店: '否', 預排梯次: batch });
ctx.upsertRow('roster', '11508', roster('000001', '準時店', '第一梯'));   // 預排第一梯、8/5 點檢 → 相符
ctx.upsertRow('roster', '11508', roster('000002', '脫期店', '第一梯'));   // 預排第一梯、8/24 點檢 → 實際第二梯
ctx.upsertRow('roster', '11508', roster('000003', '未點檢店', '第二梯'));
ctx.submitRecord(rec('R1', '2026-08-05 10:00', '000001', '準時店'));
ctx.submitRecord(rec('R2', '2026-08-24 10:00', '000002', '脫期店'));

const rep = ctx.buildMonthlyReport('11508', { from: '2026-08-01', to: '2026-08-31' }, true);
const byName = {};
rep.rows.forEach(r => { byName[r.店名] = r; });
assertEqual(byName['準時店'].實際梯次, '第一梯', '8/5 點檢＝第一梯');
assertEqual(byName['準時店'].預排梯次, '第一梯', '相符時看不出差異');
assertEqual(byName['脫期店'].實際梯次, '第二梯', '8/24 點檢＝第二梯（雖然預排是第一梯）');
assertEqual(byName['脫期店'].預排梯次, '第二梯', '不符時梯次以實際為準');
assertEqual(byName['脫期店'].原預排梯次, '第一梯', '名單原本的預排要保留，才看得出脫期');
assertEqual(rep.batchPeriods.length, 2, '報表應帶出梯次期間供前端使用');

// ===== 5. 沒有梯次表時要能退回舊行為（不可讓報表壞掉）=====
ctx.ensureMonth('11509');
ctx.upsertRow('roster', '11509', roster('000009', '九月店', '第一梯'));
ctx.submitRecord(Object.assign(rec('R9', '2026-09-03 10:00', '000009', '九月店'), { month: '11509' }));
const rep9 = ctx.buildMonthlyReport('11509', { from: '2026-09-01', to: '2026-09-30' }, true);
assertEqual(rep9.rows[0].實際梯次, '', '沒有梯次表時算不出實際梯次');
assertEqual(rep9.rows[0].預排梯次, '第一梯', '此時退回名單的預排，報表照常產出');

// ===== 6. 前端：名單檔右側小表的解析與報表取值 =====
const app = fs.readFileSync(APP_PATH, 'utf8');
const m = /function rosterBatchPeriods\(sheets\) \{[\s\S]*?\n    \}/.exec(app);
assertEqual(!!m, true, '應能在 app.html 找到 rosterBatchPeriods');
const sb = { String, Array };
vm.createContext(sb);
vm.runInContext(m[0] + '; this.fn = rosterBatchPeriods;', sb);
const parse = sb.fn;
// 模擬使用者的名單檔：A~I 是店鋪資料，J/K 是梯次小表
const sheet = {
  aoa: [
    ['序號', '店號', '店名', '隨盤', '主責部', '主責課', '預排梯次', '遠程店', '假日店', '梯次', '評核日期區間'],
    [1, '025129', '基隆新大慶店', '', '一部', '北三課', '第二梯', '', '', '第一梯', '8/1-8/15'],
    [2, '019962', '基隆樂利店', '', '業務部', '訓練課', '第二梯', '', '', '第二梯', '8/16-8/31'],
    [3, '024732', '台東南京店', 'V', '二部', '高屏課', '第一梯', 'V', '', '', ''],
  ],
};
assertEqual(parse([sheet]), [{ 梯次: '第一梯', 區間: '8/1-8/15' }, { 梯次: '第二梯', 區間: '8/16-8/31' }],
  '應抓出兩筆梯次期間，並忽略沒有梯次的資料列');
assertEqual(parse([{ aoa: [['店號', '店名'], ['001', 'A店']] }]), null, '沒有這張小表時回 null（不影響一般匯入）');

assertEqual(app.includes("rec ? (rec.實際梯次 || '') : ''"), true, '查核店鋪名單的「實際點檢梯次」應取實際梯次');
assertEqual(app.includes('(rec ? rec.預排梯次 : s.預排梯次)'), true, '已點檢的店，預排梯次欄要顯示實際值');
assertEqual(app.includes('batchOf(r.實際梯次 || r.預排梯次)'), true, '梯次表的實際側應以實際梯次統計');

// 表頭不一定在第一列（官方名單常有標題列），也可能整張沒有表頭 —— 都要能抓到，
// 因為靜默失敗會讓使用者以為梯次已生效，實際上仍在沿用預排。
const ONE = [{ 梯次: '第一梯', 區間: '8/1-8/15' }];
assertEqual(parse([{ aoa: [['11508 委外SQC評核名單'], [], [], ['店號', '梯次', '評核日期區間'], ['1', '第一梯', '8/1-8/15']] }]),
  ONE, '表頭在第4列也要抓得到（官方名單常有標題列）');
assertEqual(parse([{ aoa: [['店號', '店名'], ['1', 'A'], ['', '', '第一梯', '8/1-8/15']] }]),
  ONE, '沒有表頭時，以「名稱+日期區間相鄰」為退路');
assertEqual(parse([{ aoa: [['店號', '店名'], ['1', 'A']] }, { aoa: [['梯次', '評核日期區間'], ['第一梯', '8/1-8/15']] }]),
  ONE, '小表在第二張分頁也要抓得到');
assertEqual(parse([{ aoa: [['店號', '梯次', '評核日期' + String.fromCharCode(10) + '區間'], ['1', '第一梯', '8/1-8/15']] }]),
  ONE, '欄名含換行也要抓得到');
assertEqual(app.includes('未在檔案中找到「梯次／評核日期區間」小表'), true,
  '找不到小表時必須明確提示，不可靜默沿用預排');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
