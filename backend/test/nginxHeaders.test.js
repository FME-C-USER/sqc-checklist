/**
 * 回歸測試：nginx 安全回應標頭必須真的每個路徑都送得出去。
 *
 * 為什麼需要這支：nginx 的 add_header 是「整組取代」而不是累加 ——
 * 只要某個 location 自己寫了任何一個 add_header，它就會捨棄所有從 server 層
 * 繼承來的 add_header。本站的 vendor/ 與 *.html|js 兩個 location 都有自己的
 * Cache-Control，所以只把安全標頭寫在 server 層的話，**app.html 本身完全沒有
 * 安全標頭** —— 而那正是最需要的那個檔案。
 *
 * 這種失效是靜默的：設定檔看起來有寫、nginx 也不會報錯、要實際去看回應標頭
 * 才會發現。所以用測試把它釘住。
 *
 * 執行方式：node backend/test/nginxHeaders.test.js
 */
const fs = require('fs');
const path = require('path');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const CONF = fs.readFileSync(path.join(__dirname, '..', '..', 'nginx.conf'), 'utf8');

/** 必備的安全標頭（名稱 → 期望值的片段） */
const REQUIRED = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self)',
};

/** 去掉註解行，避免掃到「說明為什麼要這樣寫」的文字而誤判為已設定 */
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/**
 * 粗略切出所有 location 區塊（本檔結構單純：沒有巢狀 location）。
 * 回傳 [{ head, body }]。
 */
function locationBlocks(src) {
  const out = [];
  const re = /location\s+([^{]+)\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push({ head: m[1].trim(), body: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}

const SRC = stripComments(CONF);

// ===== 0. 大括號要平衡（最基本的語法防呆；本機沒有 nginx 可以 -t） =====
assertEqual((SRC.match(/\{/g) || []).length, (SRC.match(/\}/g) || []).length, '大括號要平衡');

// ===== 1. server 層要有全部四個安全標頭 =====
const blocks = locationBlocks(SRC);
const serverOnly = blocks.reduce((s, b) => s.replace(b.body, ''), SRC);
Object.keys(REQUIRED).forEach((h) => {
  assertEqual(new RegExp('add_header\\s+' + h + '\\s+"[^"]*' + REQUIRED[h].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(serverOnly),
    true, 'server 層要設 ' + h);
});

// ===== 2. ★ 任何自己寫了 add_header 的 location，都要把四個安全標頭重寫一次 =====
assertEqual(blocks.length > 0, true, '應能解析出 location 區塊');
let checked = 0;
blocks.forEach((b) => {
  if (!/add_header/.test(b.body)) return;   // 沒有自己的 add_header → 會正常繼承
  checked++;
  Object.keys(REQUIRED).forEach((h) => {
    assertEqual(new RegExp('add_header\\s+' + h).test(b.body), true,
      '★ location ' + b.head + ' 有自己的 add_header，必須重寫 ' + h + '（否則會捨棄繼承的全部標頭）');
  });
});
assertEqual(checked >= 2, true, '至少兩個 location 有自己的 Cache-Control，都要檢查到');

// ===== 3. 相機不可被 Permissions-Policy 關掉 =====
//   拍照用的是 <input type="file" capture>，把 camera 收成 () 會讓現場拍不了照。
assertEqual(/Permissions-Policy\s+"[^"]*camera=\(\)/.test(SRC), false,
  '★ camera 不可設為 ()：現場靠拍照，關掉等於整個系統不能用');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
assertEqual(/capture="environment"/.test(APP), true, '上面那條的前提：App 確實用 capture 拍照');

// ===== 4. 不可誤加 CSP 而沒放行 eval =====
//   本站用 Babel standalone 在瀏覽器端編譯 JSX 再 eval，CSP 少了 unsafe-eval
//   會讓整個 App 一行都跑不起來（畫面全白）。
if (/Content-Security-Policy/.test(SRC)) {
  assertEqual(/script-src[^;"]*'unsafe-eval'/.test(SRC), true,
    '★ 有設 CSP 就一定要放行 unsafe-eval，否則 Babel 編譯出來的程式碼無法執行');
}
assertEqual(/\(0, eval\)\(out\)/.test(APP), true, '上面那條的前提：App 確實用 eval 執行編譯後的程式碼');

console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
process.exit(failed ? 1 : 0);
