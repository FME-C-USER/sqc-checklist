// 回歸測試：App 只能被編譯與掛載一次
//   2026-08-26 實測發現整份三千行 JSX 被編譯並執行了兩次、createRoot 被呼叫兩次、
//   開場 API（getBootstrap + queryRecords）各打兩輪。
//   原因：Babel Standalone 會自動掃描並執行 type="text/jsx" 的 script，
//   而啟動區塊又手動 Babel.transform + eval 了一次。
//   後果不只是浪費：開場多一輪往返會讓「本月已點檢」的確認空窗期加倍，
//   而那個空窗期正是誤選已點檢店的成因（見 storePickGuard.test.js）。
//   對策：把 script 的 type 改成 Babel 不認得的 text/plain，只保留手動編譯那一次。
// 執行方式：node backend/test/bootOnce.test.js
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. 承載 JSX 的 script 不可以是 Babel 會自動執行的類型 =====
const AUTO_TYPES = ['text/jsx', 'text/babel', 'text/jsx;version=', 'application/javascript+jsx'];
const appCodeTag = (/<script[^>]*id="appCode"[^>]*>/.exec(APP) || [''])[0];
assertEqual(!!appCodeTag, true, '應能找到 id="appCode" 的 script 標籤');
AUTO_TYPES.forEach(t => assertEqual(appCodeTag.indexOf('"' + t) < 0, true, `type 不可為 ${t}（Babel 會自動執行）`));
assertEqual(appCodeTag.includes('type="text/plain"'), true, 'type 應為 text/plain');

// ===== 2. 手動編譯那一段必須還在（否則 App 根本不會執行）=====
assertEqual(APP.includes("document.getElementById('appCode').textContent"), true, '啟動區塊要讀 appCode 的內容');
assertEqual(/Babel\.transform\(src, \{ presets: \[\['react', \{ runtime: 'classic' \}\]\] \}\)/.test(APP), true,
  '要以 classic runtime 手動編譯（automatic runtime 會產生 import 而在純瀏覽器報錯）');
assertEqual(APP.includes('(0, eval)(out)'), true, '要執行編譯結果');

// ===== 3. createRoot 只能有一處 =====
assertEqual((APP.match(/ReactDOM\.createRoot\(/g) || []).length, 1, 'createRoot 只能出現一次');

// ===== 4. 開場資料只能有一個自動載入的入口 =====
//   多一個入口就多一輪往返，「本月已點檢」的確認空窗期會跟著變長
const bootEffect = /useEffect\(\(\) => \{\s*\n\s*if \(!CONFIGURED\) return;\s*\n\s*const cached = readBootCache\(workMonth\);[\s\S]*?\}, \[workMonth\]\);/.exec(APP);
assertEqual(!!bootEffect, true, '應能找到開場載入的 useEffect');
assertEqual((bootEffect[0].match(/reloadBoot\(/g) || []).length, 1, '開場只呼叫一次 reloadBoot');
assertEqual((bootEffect[0].match(/loadInspected\(/g) || []).length, 1, '開場只呼叫一次 loadInspected');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
