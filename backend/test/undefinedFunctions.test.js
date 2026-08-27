// 回歸測試：不可以呼叫「整個 Apps Script 專案裡沒有定義」的函式
//
// 起因（2026-08-27）：repairRecordPhotos 呼叫 ensureFolderId，但那支函式從來不存在，
// 正式環境一執行就 ReferenceError。它會在「使用者點編輯、開啟一筆照片缺連結的紀錄」時
// 自動觸發，而前端是 .catch(() => {}) 靜默吞掉 —— 所以完全沒有跡象，
// 「編輯時顯示無雲端連結」這個回報過的問題其實一次都沒修好過。
//
// 為什麼既有測試抓不到：repairRecordPhotos.test.js 自己 ctx.ensureFolderId = ... 打了樁，
// 把「依賴不存在」偽裝成「依賴正常」。打樁天生會遮蔽這件事，所以需要一支不打樁、
// 純粹對原始碼做符號解析的檢查。
//
// 做法：用逐字元狀態機剝掉註解、字串與正規表示式（用 regex 依序 replace 會出事 ——
// 字串裡的 'https://...' 會被當成行註解開頭，吃掉右引號後單引號規則再往下吞一大段，
// 檔案後半的定義就全都掃不到），再比對「呼叫點」與「定義」。
// 執行方式：node backend/test/undefinedFunctions.test.js
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

function strip(s) {
  let out = '';
  let i = 0;
  const N = s.length;
  let prev = '';   // 用來判斷 / 是除號還是正規表示式開頭
  while (i < N) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { while (i < N && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < N && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < N && s[i] !== q) { if (s[i] === '\\') i++; if (s[i] === '\n') out += '\n'; i++; }
      i++; out += q + q; prev = 'value'; continue;
    }
    if (c === '/' && prev !== 'value') {
      let j = i + 1, ok = false;
      while (j < N && s[j] !== '\n') {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '[') { while (j < N && s[j] !== ']' && s[j] !== '\n') { if (s[j] === '\\') j++; j++; } }
        if (s[j] === '/') { ok = true; break; }
        j++;
      }
      if (ok) { i = j + 1; while (i < N && /[gimsuy]/.test(s[i])) i++; out += '/RE/'; prev = 'value'; continue; }
    }
    if (/[\w$)\]]/.test(c)) prev = 'value';
    else if (!/\s/.test(c)) prev = 'op';
    out += c; i++;
  }
  return out;
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.gs')).sort();
assertEqual(files.length >= 2, true, '找得到後端的 .gs 檔（' + files.join('、') + '）');
const clean = {};
files.forEach(f => { clean[f] = strip(fs.readFileSync(path.join(DIR, f), 'utf8')); });

// ---- 收集「已定義」的名字：函式宣告、指派給變數的函式、物件字面值裡的方法、參數名 ----
const defined = new Set();
files.forEach(f => {
  const s = clean[f];
  let m;
  [
    /function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function/g,
    /([A-Za-z_$][\w$]*)\s*:\s*function/g,
    /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?[\w$,\s]*\)?\s*=>/g,
  ].forEach(re => { while ((m = re.exec(s))) defined.add(m[1]); });
  // 參數名也要算：walkFolderFiles_(folder, pathStr, onFile) 裡的 onFile 是被當函式呼叫的參數
  const fnRe = /function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g;
  while ((m = fnRe.exec(s))) {
    m[1].split(',').forEach(p => { const n = p.trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n); });
  }
});

const BUILTIN = new Set([
  // Apps Script 服務
  'SpreadsheetApp', 'DriveApp', 'PropertiesService', 'LockService', 'CacheService', 'UrlFetchApp',
  'Utilities', 'Logger', 'ScriptApp', 'Session', 'ContentService', 'HtmlService', 'MailApp',
  'GmailApp', 'CalendarApp', 'DocumentApp', 'FormApp', 'Drive', 'Sheets', 'XmlService',
  // JS 內建
  'JSON', 'Math', 'Date', 'String', 'Number', 'Boolean', 'Array', 'Object', 'RegExp', 'Error',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'Set', 'Map', 'Promise', 'Function', 'TypeError', 'RangeError', 'console',
  // 關鍵字（`if (` 這種會被呼叫點的樣式掃到）
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'else', 'do', 'try',
  'new', 'delete', 'void', 'in', 'of', 'case', 'throw', 'with',
]);

// ---- 收集「呼叫點」：不帶前置 . 的 foo( ；帶點的是方法呼叫，不在檢查範圍 ----
const undef = {};
files.forEach(f => {
  clean[f].split('\n').forEach((line, i) => {
    const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(line))) {
      const name = m[2];
      if (BUILTIN.has(name) || defined.has(name)) continue;
      if (!undef[name]) undef[name] = [];
      undef[name].push(f + ':' + (i + 1));
    }
  });
});

const names = Object.keys(undef).sort();
console.log('  （已定義 ' + defined.size + ' 個名稱，掃過 ' + files.length + ' 個檔）');
assertEqual(names.map(n => n + ' @ ' + undef[n].join(',')), [],
  '不可有「被呼叫但沒有定義」的函式');

// ---- 掃描器本身要能真的抓到東西，否則這支測試等於空轉 ----
// 用一段刻意寫壞的程式碼驗證：註解與字串裡的 foo() 不算，實際呼叫要抓到。
const probe = [
  'function realOne() { return 1; }',
  '// 這行註解裡的 ghostInComment() 不算',
  "var url = 'https://example.com/a//b';   // 字串裡的斜線不可以吃掉後面的定義",
  'function afterUrl() { return realOne() + ghostCall(1, 2); }',
  'var re = /a\\/b/g;',
].join('\n');
const pClean = strip(probe);
const pDefined = new Set();
let pm;
const pRe = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
while ((pm = pRe.exec(pClean))) pDefined.add(pm[1]);
assertEqual([...pDefined].sort(), ['afterUrl', 'realOne'],
  '字串裡的 // 不可以吃掉後面的函式定義（afterUrl 必須被看見）');
const pCalls = new Set();
const cRe = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
while ((pm = cRe.exec(pClean))) { if (!BUILTIN.has(pm[2]) && !pDefined.has(pm[2])) pCalls.add(pm[2]); }
assertEqual([...pCalls].sort(), ['ghostCall'],
  '只抓實際呼叫：ghostCall 要被抓到，註解裡的 ghostInComment 不可以');

console.log(failed ? `\n✗ ${failed} 項未通過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);
