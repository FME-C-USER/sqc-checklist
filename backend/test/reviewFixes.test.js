// 回歸測試：2026-08-27 外部程式碼審查後採納的三項（第 1 項另有 undefinedFunctions.test.js 把關）
//   1 weekMondayOf 一律先過 toYmd()：Date 物件不可以讓跨週保護靜默放行
//   2 getChangeLog 只讀最後 N 列，不可以讀整張表
//   3 mapToInternal 已刪除（全專案零呼叫的死碼）
// 執行方式：node backend/test/reviewFixes.test.js
const fs = require('fs');
const path = require('path');
const { loadGasFile, stubExisting } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
const GS = fs.readFileSync(GS_PATH, 'utf8');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. weekMondayOf 對 Date 物件 =====
// 這是「錯誤方向是放行而不是擋下」的那一類：解析失敗 → 回空字串 → isCrossWeek 回 false
// → 跨週密碼保護整個失效。Sheet 讀回來的日期欄就是 Date 物件，所以不能只靠呼叫端記得包 toYmd。
{
  const { ctx } = loadGasFile(GS_PATH);
  // 假環境的 Utilities.formatDate 是寫死的，這裡換成真的實作才驗得出週一
  stubExisting(ctx, 'toYmd', (v) => (v instanceof Date)
    ? v.toISOString().slice(0, 10)                      // 測試裡以 UTC 當台北日期，夠用
    : String(v || '').slice(0, 10));
  ctx.Utilities.formatDate = (d, tz, fmt) => d.toISOString().slice(0, 10);

  assertEqual(ctx.weekMondayOf('2026-08-27'), '2026-08-24', '週四(8/27) 的週一是 8/24');
  assertEqual(ctx.weekMondayOf('2026-08-24'), '2026-08-24', '週一本身回自己');
  assertEqual(ctx.weekMondayOf('2026-08-30'), '2026-08-24', '週日(8/30) 仍屬 8/24 那一週');
  assertEqual(ctx.weekMondayOf('2026-08-31'), '2026-08-31', '下週一換週');
  // 帶時間的字串（實際存進 Sheet 的格式）與 ISO 都要一樣
  assertEqual(ctx.weekMondayOf('2026-08-27 14:01'), '2026-08-24', '帶空白時間的字串');
  assertEqual(ctx.weekMondayOf('2026-08-27T14:01'), '2026-08-24', 'ISO 格式（審查說會壞，其實不會）');
  // 關鍵：Date 物件
  assertEqual(ctx.weekMondayOf(new Date(Date.UTC(2026, 7, 27))), '2026-08-24',
    'Date 物件必須也算得出來 —— 這是原本會靜默放行的洞');
  // 垃圾輸入要回空字串，不可以讓 Utilities.formatDate 對 Invalid Date 拋錯
  assertEqual(ctx.weekMondayOf('2026-ab-27'), '', '月份不是數字 → 回空字串，不可拋錯');
  assertEqual(ctx.weekMondayOf(''), '', '空字串 → 空字串');
  assertEqual(ctx.weekMondayOf(null), '', 'null → 空字串');
}
// 原始碼層面：確保沒有人把 toYmd 拿掉退回 String().slice()
assertEqual(/function weekMondayOf\(ymd\) \{\s*var parts = toYmd\(ymd\)\.split\('-'\);/.test(GS), true,
  'weekMondayOf 必須以 toYmd(ymd) 起手');
assertEqual(/isNaN\(year\) \|\| isNaN\(month\) \|\| isNaN\(day\)/.test(GS), true,
  '要有 isNaN 防護（Invalid Date 會讓 Utilities.formatDate 拋錯）');

// ===== 2. getChangeLog 只讀最後 N 列 =====
assertEqual(/function getChangeLog[\s\S]{0,400}?readSheet\('異動紀錄'\)/.test(GS), false,
  'getChangeLog 不可以用 readSheet(整張表)');
assertEqual(/getRange\(lastRow - n \+ 1, 1, n, lastCol\)/.test(GS), true,
  '要用 getRange 只取最後 n 列');
{
  const { ctx, book } = loadGasFile(GS_PATH);
  const sh = ctx.ensureSheetNamed('異動紀錄', ctx.HEADERS_MAP.log);
  for (let i = 1; i <= 1000; i++) {
    sh.appendRow(['2026-08-27 10:00', 'U' + i, '修改', '對象' + i, '說明' + i]);
  }
  // 記下讀取範圍，確認沒有讀整張表
  const reads = [];
  const realGetRange = sh.getRange.bind(sh);
  sh.getRange = (...a) => { reads.push(a); return realGetRange(...a); };
  let fullReads = 0;
  sh.getDataRange = () => { fullReads++; return realGetRange(1, 1, sh.getLastRow(), sh.getLastColumn()); };

  const r = ctx.getChangeLog(300);
  assertEqual(r.rows.length, 300, '回 300 筆');
  assertEqual(r.rows[0].user, 'U1000', '最新的排最前面（倒序）');
  assertEqual(r.rows[299].user, 'U701', '最舊的那一筆是第 701 列');
  assertEqual(fullReads, 0, '不可以呼叫 getDataRange（那就是讀整張表）');
  const rowsRead = reads.filter(a => a.length === 4).reduce((s, a) => s + a[2], 0);
  assertEqual(rowsRead <= 301, true, '實際讀進來的列數要 ≤ 301（表頭 1 + 資料 300），實際 ' + rowsRead);

  assertEqual(ctx.getChangeLog(5).rows.map(x => x.user), ['U1000', 'U999', 'U998', 'U997', 'U996'],
    'limit 較小時同樣取最後幾筆');
}
{
  // 少於 limit、以及空表都不可以爆
  const { ctx } = loadGasFile(GS_PATH);
  assertEqual(ctx.getChangeLog(300).rows, [], '活頁還不存在時回空陣列');
  const sh = ctx.ensureSheetNamed('異動紀錄', ctx.HEADERS_MAP.log);
  assertEqual(ctx.getChangeLog(300).rows, [], '只有表頭時回空陣列');
  sh.appendRow(['2026-08-27 10:00', 'only', '刪除', 'X', '']);
  assertEqual(ctx.getChangeLog(300).rows.map(x => x.user), ['only'], '只有 1 筆時不可以越界讀取');
}

// ===== 3. mapToInternal 已刪除 =====
assertEqual(/function mapToInternal\s*\(/.test(GS), false, 'mapToInternal 應已刪除');
assertEqual(/\bmapToInternal\b/.test(GS.replace(/這裡原本有一支 mapToInternal[^\n]*/, '')), false,
  '除了那行說明註解，不應再有任何 mapToInternal 的痕跡');
assertEqual(/function rowToRecord\s*\(/.test(GS) && /function recordToRow\s*\(/.test(GS), true,
  '接手它職責的 rowToRecord／recordToRow 必須還在');

console.log(failed ? `\n✗ ${failed} 項未通過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);
