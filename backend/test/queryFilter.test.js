// 回歸測試：按下「查詢」必須用畫面上當下的日期，而不是上一次的條件
//
// 2026-08-27 現場回報「查不到 8 月資料，只有今天的」。原因不是資料不見：
//   filter 初始值是 { from: 今天, to: 今天 }；進入頁面時 useEffect 會先自動查一次
//   並把它記進 appliedFilter。而兩個「查詢」按鈕寫成 onClick={loadRecords}，
//   React 會把 click 事件物件當第一個參數傳進去 —— 事件物件是 truthy，於是
//     const src = (useApplied && appliedFilter.current) || filter;
//   取到的是「上一次」的條件（今天→今天），使用者剛改好的 8/01~8/26 被整個忽略。
//   前端再用 8/01~8/26 去過濾「只有今天的資料」→ 執行店數 0。
// 同一個 bug 還造成：進度條不出現、按鈕的 disabled 失效（可連點）、查詢失敗完全不提示。
// 執行方式：node backend/test/queryFilter.test.js
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
// 註解裡會提到舊寫法（就是上面那幾行），掃程式碼時一定要先把註解剝掉
const CODE = APP.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
  .join('\n');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. 按鈕不可以把函式直接當 handler =====
assertEqual(/onClick=\{loadRecords\}/.test(CODE), false,
  '不可有 onClick={loadRecords}（React 會把 click 事件當第一個參數傳進去）');
const wrapped = (CODE.match(/onClick=\{\(\) => loadRecords\(\)\}/g) || []).length;
assertEqual(wrapped >= 2, true, '兩個「查詢」按鈕都要包成 () => loadRecords()，實際 ' + wrapped + ' 處');

// ===== 2. loadRecords 內部要嚴格比對 true，不可只看 truthy =====
assertEqual(/const silent = useApplied === true;/.test(CODE), true,
  'silent 要用 === true 嚴格比對（第二道防線：以後有人寫回 onClick={loadRecords} 也不會靜默沿用舊條件）');
assertEqual(/\(useApplied && appliedFilter\.current\)/.test(CODE), false,
  '不可再用 (useApplied && ...) 判斷是否沿用舊條件');
['setQueryLoading(true)', 'setQueryLoading(false)'].forEach(t => {
  assertEqual(new RegExp('if \\(!silent\\) ' + t.replace(/[()]/g, '\\$&')).test(CODE), true,
    '進度條的開關要看 silent：' + t);
});

// ===== 3. 「那個月讀不到」不可以被當成「那個月沒有紀錄」 =====
assertEqual(/\.catch\(\(\) => \(\{ records: \[\] \}\)\)/.test(CODE), false,
  '不可再用 .catch(() => ({ records: [] })) 把讀取失敗吞成空結果');
assertEqual(/\.catch\(e => \(\{ ok: false, month: m, error: e, records: \[\] \}\)\)/.test(CODE), true,
  '每個月要各自記下成功或失敗');
assertEqual(/const bad = results\.filter\(r => !r\.ok\);/.test(CODE), true, '要挑出失敗的月份');
assertEqual(/if \(bad\.length && silent\) \{ setLoadWarn\(warnTextOf\(bad\)\); return; \}/.test(CODE), true,
  '背景刷新遇到部分失敗時不可用不完整的清單覆蓋掉上一次完整的');

// ===== 4. 警示要攤在畫面上，不能只彈一次視窗 =====
assertEqual(/const \[loadWarn, setLoadWarn\] = useState\(''\);/.test(CODE), true, '要有 loadWarn 狀態');
const banners = (CODE.match(/\{loadWarn && \(/g) || []).length;
assertEqual(banners, 2, '查詢紀錄與彙總專區兩頁都要顯示警示條，實際 ' + banners + ' 處');
assertEqual(/warnTextOf = \(bad\) => bad\.map/.test(CODE), true, '警示文字要指名是哪個月、什麼原因');
// warnTextOf 必須定義在 loadRecords 之前（這個專案曾因 const 順序整個 App 起不來）
assertEqual(CODE.indexOf('const warnTextOf') < CODE.indexOf('const loadRecords'), true,
  'warnTextOf 要定義在 loadRecords 之前');

// ===== 5. 把實際的取值邏輯抽出來跑，確認事件物件不會再騙過它 =====
const pick = (useApplied, applied, current) => {
  const silent = useApplied === true;                    // 與正式碼同一行邏輯
  return (silent && applied) || current;
};
const APPLIED = { from: '2026-08-27', to: '2026-08-27' };   // 上一次查的：今天
const CURRENT = { from: '2026-08-01', to: '2026-08-26' };   // 使用者剛改的
const fakeEvent = { type: 'click', target: {}, preventDefault() { } };
assertEqual(pick(fakeEvent, APPLIED, CURRENT), CURRENT,
  '傳進 click 事件物件時，要用畫面上當下的日期（這就是現場回報的那個 bug）');
assertEqual(pick(undefined, APPLIED, CURRENT), CURRENT, '按鈕呼叫（無參數）用當下的日期');
assertEqual(pick(true, APPLIED, CURRENT), APPLIED, '背景刷新明確傳 true 時沿用上一次的條件');
assertEqual(pick(true, null, CURRENT), CURRENT, '背景刷新但還沒有上一次條件時退回當下的');

console.log(failed ? `\n✗ ${failed} 項未通過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);
