// 回歸測試：使用者 2026-08-27「先做 gzip ＋ 快取標頭 / 配額錯誤的處理也建議一起補」
//   A. nginx.conf 的壓縮與快取標頭（Cloud Run 入口原本兩者皆無，一次冷啟動要下 3.13MB）
//   B. 照片存進 IndexedDB 佇列失敗（手機空間不足 → QuotaExceededError）時不可默默吞掉
// 本機沒有 docker／nginx，無法真的啟動來驗，因此這裡把 nginx 的 location 選擇規則
// 實作成一個小模擬器，直接對「哪個區塊會勝出」做斷言 —— 這正是最容易寫錯的地方
// （一般前綴 location 會輸給正規表示式 location，vendor 若不寫 ^~ 就會被套上 no-cache）。
// 執行方式：node backend/test/gzipAndQuota.test.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const NGINX = fs.readFileSync(path.join(ROOT, 'nginx.conf'), 'utf8');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const GS = fs.readFileSync(path.join(__dirname, '..', '程式碼.gs'), 'utf8');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 解析 nginx.conf =====
const noComment = NGINX.split('\n').map(l => l.replace(/#.*$/, '')).join('\n');

// 抓出每個 location 的修飾詞、樣式與區塊內容
const locations = [];
const locRe = /location\s+(=|\^~|~\*|~)?\s*([^\s{]+)\s*\{([^}]*)\}/g;
let m;
while ((m = locRe.exec(noComment))) {
  locations.push({ mod: m[1] || '', pattern: m[2], body: m[3] });
}
assertEqual(locations.length, 3, 'nginx.conf 應有 3 個 location 區塊');

function cacheControlOf(loc) {
  const h = /add_header\s+Cache-Control\s+"([^"]*)"/.exec(loc.body);
  return h ? h[1] : null;
}

// nginx 的 location 選擇規則（http core module）：
//   1 精確比對 = 命中即結束
//   2 記下「最長」的前綴比對；若該前綴帶 ^~ 則就此結束，不再試正規表示式
//   3 依「在設定檔中出現的順序」試正規表示式，第一個命中者勝
//   4 都沒命中才回到步驟 2 記下的前綴
function pickLocation(uri) {
  const exact = locations.find(l => l.mod === '=' && l.pattern === uri);
  if (exact) return exact;
  let prefix = null;
  locations.filter(l => l.mod === '' || l.mod === '^~').forEach(l => {
    if (uri.startsWith(l.pattern) && (!prefix || l.pattern.length > prefix.pattern.length)) prefix = l;
  });
  if (prefix && prefix.mod === '^~') return prefix;
  const rx = locations.find(l => (l.mod === '~' || l.mod === '~*')
    && new RegExp(l.pattern, l.mod === '~*' ? 'i' : '').test(uri));
  if (rx) return rx;
  return prefix;
}

// ===== A1. 壓縮 =====
assertEqual(/^\s*gzip\s+on\s*;/m.test(noComment), true, '要開啟 gzip');
assertEqual(/^\s*gzip_vary\s+on\s*;/m.test(noComment), true, '要有 gzip_vary（否則中間快取可能對不支援壓縮的客端發出壓縮版本）');
const gzTypes = (/gzip_types([^;]*);/.exec(noComment) || [, ''])[1].trim().split(/\s+/).filter(Boolean);
['text/css', 'text/javascript', 'application/javascript', 'application/json', 'image/svg+xml']
  .forEach(t => assertEqual(gzTypes.includes(t), true, `gzip_types 要含 ${t}`));
// nginx 1.21.1 起把 .js 的 MIME 由 application/javascript 改為 text/javascript，
// 兩個都列才能同時涵蓋新舊映像檔 —— 少列一個就等於 vendor 的 js 完全沒被壓縮。
assertEqual(gzTypes.includes('text/javascript') && gzTypes.includes('application/javascript'), true,
  'js 的兩種 MIME 都要列（nginx 1.21.1 前後不同）');
assertEqual(gzTypes.includes('text/html'), false, 'text/html 一律會壓縮，重複列出 nginx 會警告 duplicate MIME type');

// ===== A2. 快取標頭與 location 優先序 =====
const vendorLoc = locations.find(l => l.pattern === '/vendor/');
assertEqual(!!vendorLoc, true, '要有 /vendor/ 的 location');
assertEqual(vendorLoc && vendorLoc.mod, '^~', '/vendor/ 必須用 ^~，一般前綴會輸給下面的 .js 正規表示式');

const babel = pickLocation('/vendor/babel-standalone-8.0.4.min.js');
assertEqual(cacheControlOf(babel), 'public, max-age=31536000, immutable',
  'vendor 的 js 要拿到永久快取（這是最大那一塊，2.4MB）');
assertEqual(cacheControlOf(pickLocation('/app.html')), 'no-cache', 'app.html 每次都要向伺服器確認');
assertEqual(cacheControlOf(pickLocation('/js/api.js')), 'no-cache', '自己的 js 每次都要確認');
assertEqual(cacheControlOf(pickLocation('/service-worker.js')), 'no-cache',
  'service-worker.js 若被快取，改版就永遠推不出去');
assertEqual(cacheControlOf(pickLocation('/manifest.json')), 'no-cache', 'manifest 每次都要確認');
// 根路徑不帶副檔名，會落到 location / 交給 try_files 補 index.html
assertEqual(pickLocation('/').pattern, '/', '根路徑要落在 location /');
assertEqual(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html\s*;/.test(noComment), true,
  'location / 要保留原本的 SPA fallback');

// add_header 只在「本次回應是 2xx/3xx」時才會加，除非帶 always。
// vendor 命中 =404 時無所謂，但 no-cache 那條若漏了 always，錯誤頁就不帶標頭。
locations.filter(l => cacheControlOf(l)).forEach(l => {
  assertEqual(/add_header\s+Cache-Control\s+"[^"]*"\s+always\s*;/.test(l.body), true,
    `location ${l.mod}${l.pattern} 的 add_header 要帶 always`);
});

// 設定檔要真的被放進映像檔，否則以上全都不會生效
assertEqual(/COPY\s+nginx\.conf\s+\/etc\/nginx\/conf\.d\/default\.conf/.test(DOCKERFILE), true,
  'Dockerfile 要把 nginx.conf 複製成 default.conf');

// vendor 目錄要真的存在且檔名帶版本號（immutable 的前提是內容永不改變）
const vendorFiles = fs.readdirSync(path.join(ROOT, 'vendor'));
assertEqual(vendorFiles.length > 0, true, 'vendor 目錄要有檔案');
const unversioned = vendorFiles.filter(f => /\.(js|css)$/.test(f) && !/\d+\.\d+\.\d+/.test(f));
assertEqual(unversioned, [], 'vendor 內的檔名都要帶版本號，否則不能宣告 immutable');

// ===== B. 照片存不進佇列時的處理 =====
// 去掉註解再掃 —— app.html 裡的註解本身就寫著「原本是 queue.forEach(...)」，
// 直接掃全文會把說明文字當成程式碼命中。
const APP_CODE = APP.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
assertEqual(/queue\.forEach\(\s*q\s*=>\s*(window\.)?SqcUploader\.enqueue/.test(APP_CODE), false,
  '不可再用 forEach 發射 enqueue（丟出的錯誤沒人接，使用者不會知道照片沒存進去）');
assertEqual(APP.includes('await Promise.allSettled('), true, '要等每一張照片的 enqueue 結果');
assertEqual(/const doSubmit = async \(\) =>/.test(APP), true, 'doSubmit 要是 async');
assertEqual(APP.includes("Promise.resolve(doSubmit()).catch(oops)"), true,
  'submit() 要接住 doSubmit 的 rejection，否則按鈕會鎖在「送出中」而畫面上什麼都不說');
assertEqual(APP.includes("why.reason.name === 'QuotaExceededError'"), true,
  '空間不足要講人話（手機儲存空間不足），不是丟原始錯誤名');
assertEqual(APP.includes('const queuedCount = queue.length - failedNames.length;'), true,
  '成功訊息的張數要扣掉失敗的');
assertEqual(/added: queue\.length\b/.test(APP), false, '不可再用 queue.length 當已加入張數');
// 存不進去的照片必須從 photosJson 移除 —— 否則紀錄裡寫著有這張、雲端卻永遠不會有，
// 就變成報表少連結、查詢紀錄永遠標「未完整上傳」的那類問題。
assertEqual(APP.includes('if (!photosJson[k].length) delete photosJson[k];'), true,
  '失敗的照片要從 photosJson 中移除，空的鍵也要刪掉');
assertEqual(APP.includes("SqcApi.logEvent('photoQueueFull'"), true, '要留下事件紀錄才查得到有多少人踩到');

// 後端白名單沒放行的事件會被丟掉，補了前端卻沒補後端等於白做
const events = (/var CLIENT_EVENTS = \{([\s\S]*?)\};/.exec(GS) || [, ''])[1];
assertEqual(/photoQueueFull\s*:/.test(events), true, '後端 CLIENT_EVENTS 要放行 photoQueueFull');
assertEqual(/leaveWithPendingPhotos\s*:/.test(events), true, '原本的 leaveWithPendingPhotos 要保留');

console.log(failed ? `\n✗ ${failed} 項未通過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);
