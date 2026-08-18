// 回歸測試：請款金額計算 — 以人工版 6 月範例檔當標準答案驗算
//   做法：讀出範例檔「請款明細(客戶)」裡的 1,563 筆逐店明細，轉成我們的 report.rows 形狀，
//   丟進 js/billing.js 計算，再與範例檔上方的請款總表、各部/各課金額逐項比對。
//   若計算邏輯有誤，這裡就會對不上人工版的實際請款數字。
// 執行方式：node backend/test/billing.test.js
const path = require('path');
const billing = require('../../js/billing.js');

const XLSX_PATH = 'C:/Users/family/AppData/Local/Temp/claude/D--Claude---app-SQC/f8fda5c3-9d83-421c-9158-eee1d6658a21/scratchpad/node_modules/xlsx';
const SAMPLE = 'D:/Claude/點檢app/SQC/測試資料/(11506)SQC點檢彙總表-請款金額-彙總範例.xlsx';

let XLSX;
try { XLSX = require(XLSX_PATH); } catch (e) {
  console.log('⚠ 找不到 xlsx 模組，略過本測試（僅在有安裝時驗算人工版數字）');
  process.exit(0);
}
const fs = require('fs');
if (!fs.existsSync(SAMPLE)) {
  console.log('⚠ 找不到人工版範例檔，略過本測試：' + SAMPLE);
  process.exit(0);
}

let failed = 0;
const num = (v) => Number(String(v == null ? '' : v).replace(/[, ]/g, '')) || 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  人工版: ${JSON.stringify(expected)}\n  程式算: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 讀人工版：逐店明細 → report.rows =====
const wb = XLSX.readFile(SAMPLE);
const cust = XLSX.utils.sheet_to_json(wb.Sheets['請款明細(客戶) '], { header: 1, raw: false, defval: '' });
const detail = cust.slice(14).filter(r => String(r[3] || '').trim() !== '');
const rows = detail.map(r => ({
  營業部: r[1], 營業課別: r[2], 店號: r[3], 店名: r[4], 營業擔當: r[5],
  假日店: r[7] === 'V' ? '是' : '否', 遠程店: r[8] === 'V' ? '是' : '否',
  主責部: r[9], 主責課: r[10],
}));
console.log('讀入人工版逐店明細：' + rows.length + ' 筆\n');

const out = billing.buildBillingSheets({ rows }, null, {}, { from: '2026-06-01', to: '2026-06-30' });

// ===== 1. 全部合計（對照客戶分頁上方總表）=====
const expAll = { 平日數: num(cust[2][2]), 平日小計: num(cust[2][4]), 遠程數: num(cust[3][2]), 遠程小計: num(cust[3][4]), 文件費: num(cust[6][4]), 未稅: num(cust[7][4]), 稅金: num(cust[8][4]), 總計: num(cust[9][4]) };
const L = out.總表.lines;
assertEqual(out.家數, 1563, '總家數應為1563店');
assertEqual(L[0].數量, expAll.平日數, '平日點檢費數量');
assertEqual(L[0].小計, expAll.平日小計, '平日點檢費小計');
assertEqual(L[1].數量, expAll.遠程數, '平日遠程加價數量');
assertEqual(L[1].小計, expAll.遠程小計, '平日遠程加價小計');
assertEqual(L[2].數量, 0, '假日點檢費數量(6月為0)');
assertEqual(L.find(l => l.群 === '文件處理費').小計, expAll.文件費, '文件處理費');
assertEqual(out.總表.未稅, expAll.未稅, '未稅合計');
assertEqual(out.總表.稅金, expAll.稅金, '5%稅金');
assertEqual(out.總表.總計, expAll.總計, '總計');

// ===== 2. 各部（對照內部分頁的每個區塊）=====
const inner = XLSX.utils.sheet_to_json(wb.Sheets['請款明細(內部)'], { header: 1, raw: false, defval: '' });
function findDeptBlock(dept) { // 找「…:盤點中心X部」標題列，往下數到合計/總計
  const i = inner.findIndex(r => String(r[0] || '').indexOf('盤點中心' + dept) >= 0);
  if (i < 0) return null;
  const b = {};
  for (let k = i; k < Math.min(i + 12, inner.length); k++) {
    const c0 = String(inner[k][0] || '');
    if (c0 === '合計') b.未稅 = num(inner[k][4]);
    if (c0.indexOf('稅金') >= 0) b.稅金 = num(inner[k][4]);
    if (c0 === '總計') { b.總計 = num(inner[k][4]); break; }
  }
  return b;
}
const grouped = billing.groupStores(rows);
['業務部', '一部', '二部'].forEach(dept => {
  const exp = findDeptBlock(dept);
  if (!exp) { console.log('✗ 人工版找不到 ' + dept + ' 區塊'); failed++; return; }
  const g = billing.computeGroup(grouped.byDept[dept].all, null, { includeDocFee: dept === '業務部' });
  assertEqual(g.未稅, exp.未稅, dept + ' 未稅合計');
  assertEqual(g.家數, dept === '一部' ? 766 : dept === '二部' ? 630 : 167, dept + ' 家數');
  // 稅金：人工版在此處與其彙總矩陣有1元不一致(截去/四捨五入混用)，故容許±1
  const taxOk = Math.abs(g.稅金 - exp.稅金) <= 1;
  console.log((taxOk ? '✓' : '✗') + ' ' + dept + ' 稅金（容許±1，人工版此處有截去/四捨五入混用）人工:' + exp.稅金 + ' 程式:' + g.稅金);
  if (!taxOk) failed++;
});

// ===== 3. 各課（對照一部各課分頁右側彙總矩陣）=====
const p1 = XLSX.utils.sheet_to_json(wb.Sheets['請款明細(一部各課)'], { header: 1, raw: false, defval: '' });
const expSec = {}; // 課別 → 未稅
p1.forEach(r => {
  const name = String(r[7] || '').trim();
  if (/^(北一課|北二課|北三課|北四課|桃竹課)$/.test(name)) expSec[name] = { 未稅: num(r[8]), 家數: num(r[11]) };
});
console.log('');
Object.keys(expSec).forEach(sec => {
  const g = billing.computeGroup(grouped.byDept['一部'].sections[sec], null, { includeDocFee: false });
  assertEqual(g.未稅, expSec[sec].未稅, '一部/' + sec + ' 未稅');
  assertEqual(g.家數, expSec[sec].家數, '一部/' + sec + ' 家數');
});

// ===== 4. 店型態推導 =====
console.log('');
assertEqual(billing.storeTypeOf('否', '否'), '一般店', '店型態：非遠程非假日→一般店');
assertEqual(billing.storeTypeOf('是', '否'), '平日遠程店', '店型態：遠程→平日遠程店');
assertEqual(billing.storeTypeOf('否', '是'), '假日店', '店型態：假日→假日店');
assertEqual(billing.storeTypeOf('是', '是'), '假日遠程店', '店型態：遠程+假日→假日遠程店');
const typeCount = {};
out.客戶.slice(14).forEach(r => { if (r[3]) typeCount[r[6]] = (typeCount[r[6]] || 0) + 1; });
assertEqual(typeCount, { '一般店': 1456, '平日遠程店': 107 }, '客戶明細的店型態分佈應與人工版一致');

// ===== 5. 假日店計價（人工版6月無假日店，用合成資料驗證單價套用）=====
console.log('');
const hol = billing.computeGroup([
  { 遠程店: '否', 假日店: '是' }, { 遠程店: '是', 假日店: '是' }, { 遠程店: '是', 假日店: '否' },
], null, { includeDocFee: false });
assertEqual(hol.lines[0].數量, 1, '假日情境：平日點檢費數量應為1');
assertEqual(hol.lines[1].數量, 1, '假日情境：平日遠程加價數量應為1');
assertEqual(hol.lines[2].數量, 2, '假日情境：假日點檢費數量應為2');
assertEqual(hol.lines[3].數量, 1, '假日情境：假日遠程加價數量應為1');
assertEqual(hol.未稅, 245 + 220 + 2 * 470 + 345, '假日情境：未稅=245+220+470*2+345');

// ===== 6. 外島交通費（手動輸入）會計入該課 =====
const offG = billing.computeGroup([{ 遠程店: '否', 假日店: '否' }], null, { includeDocFee: false, includeOffshore: true, offshore: 1200 });
assertEqual(offG.未稅, 245 + 1200, '外島交通費應計入未稅');

// ===== 7. 店號需補回6碼前導0且以文字輸出（Sheet 常把 022320 存成數字 22320）=====
console.log('');
const codeOut = billing.buildBillingSheets({
  rows: [
    { 店號: 22320, 店名: 'A店', 主責部: '一部', 主責課: '北一課', 遠程店: '否', 假日店: '否' },
    { 店號: '024019', 店名: 'B店', 主責部: '一部', 主責課: '北一課', 遠程店: '否', 假日店: '否' },
    { 店號: '0173', 店名: 'C店', 主責部: '一部', 主責課: '北一課', 遠程店: '否', 假日店: '否' },
  ],
}, null, {}, { from: '2026-08-01', to: '2026-08-31' });
const nrow = codeOut.客戶.findIndex(r => r[0] === 'NO');
const ccol = codeOut.客戶[nrow].indexOf('店號');
const codes = codeOut.客戶.slice(nrow + 1).filter(r => r[ccol]).map(r => r[ccol]);
assertEqual(codes, ['022320', '024019', '000173'], '店號應補成6碼');
assertEqual(codes.map(c => typeof c), ['string', 'string', 'string'], '店號應為字串(文字格式)，不可為數字');

console.log(failed === 0 ? '\n✅ 全部通過（與人工版 6 月請款數字一致）' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
