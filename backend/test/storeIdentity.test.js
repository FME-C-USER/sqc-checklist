/**
 * 回歸測試：門市重新編號（同一家店在新舊名單各是不同店號）。
 *
 * 2026-09 實際發生 13 家，例：三峽峇里店 019150 → 026169。
 * 兩個轉出檔比對才發現 —— 因為所有後果都是靜默的：
 *   ・課別 KPI 的「應點檢」從名單算、「已點檢」從紀錄算，兩個數字都還是對的
 *   ・只有逐店的「查核店鋪名單」那張表會把已點檢的店標成「未點檢」
 *   ・而「這家店本月點過了嗎」也會判錯 → 那家店重新變成可點檢，可能被重複點檢
 *
 * 使用者確認的領域規則：**店鋪會有新舊店號的問題，所以是以店名為主。**
 * 實測 115/09 名單 1323 家店，店名（含去尾字「店」之後）零重複，所以店名可當唯一鍵。
 *
 * 四項修正：
 *   A 名單查詢改雙鍵（後端 findRoster、前端 recLookupOf）
 *   B getInspectedCodes 一併回傳店名，前端店號或店名任一命中就算點過
 *   C 編輯回填的 inRoster 加店名備援
 *   D 匯入時偵測「同店名但店號不同」並明確告知（匯入是整表取代，舊店號覆蓋後查不到）
 *
 * ★ 兩邊的 normName 必須一字不差，否則後端正規化過的店名前端比不到，
 *   防重複點檢會靜默失效 —— 那比不修還糟。
 *
 * 執行方式：node backend/test/storeIdentity.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const GS = fs.readFileSync(path.join(ROOT, 'backend', '程式碼.gs'), 'utf8');
/**
 * 只移除 /* *\/ 區塊與整行 // 註解。
 * 不要用 /\{\s*\/\*[\s\S]*?\*\/\s*\}/ 想一次抓 JSX 註解 —— 非貪婪比對接不上 }
 * 時會回溯去找下一個 *\/}，於是從某個 `=> {` 一路吃掉幾千行（2026-09-04 踩過）。
 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
const CODE = strip(APP);
const GSC = strip(GS);

// ===== 0. ★ 前後端的 normName 必須一字不差 =====
const pick = (src, name) => {
  const m = new RegExp('function ' + name + '\\((\\w+)\\) \\{([^\\n]*)\\}').exec(src);
  return m ? m[0] : null;
};
{
  const a = pick(CODE, 'normName'), b = pick(GSC, 'normName');
  assertEqual(!!a, true, '前提：app.html 有 normName');
  assertEqual(!!b, true, '前提：程式碼.gs 有 normName');
  const body = (s) => s.replace(/^function normName\(\w+\)\s*\{/, '').replace(/\}$/, '')
    .replace(/\b(const|var|let)\b/g, '').replace(/\s+/g, ' ').trim();
  assertEqual(body(a), body(b),
    '★ 前後端 normName 的規則必須相同 —— 不同的話後端正規化過的店名前端比不到，防重複點檢會靜默失效');

  const normName = new Function(a + '; return normName;')();
  assertEqual(normName('三峽峇里店'), '三峽峇里', 'normName 去掉尾字「店」');
  assertEqual(normName('  三峽峇里店  '), '三峽峇里', '去空白');
  assertEqual(normName(null), '', 'null 不可爆掉');
  assertEqual(normName(''), '', '空值不可爆掉');
  // 只砍最後一個「店」，不是全部
  assertEqual(normName('店中店'), '店中', '只砍尾字，不是把所有「店」都拿掉');
}

// ===== A. 名單查詢雙鍵 =====
assertEqual(/var findRoster = function \(code, name\) \{ return rosterByName\[normName\(name\)\] \|\| rosterByCode\[normCode\(code\)\]/.test(GSC), true,
  '★ 後端要有 findRoster（店名優先、店號備援），與 findMaster 同一個規則');
assertEqual(/var ro = rosterByCode\[code\] \|\| \{\};/.test(GSC), false,
  '★ 報表不可再只用店號查名單（查不到會讓店型態退回「一般店」、遠程假日退回「否」）');
assertEqual(/var ro = findRoster\(rec\.storeCode, rec\.storeName\);/.test(GSC), true,
  '報表改用 findRoster');
// 前提：確認上面那條 false 不是因為整段被刪掉才通過
assertEqual(/rosterByCode\[normCode\(r\['店號'\]\)\] = r;/.test(GSC), true,
  '前提：rosterByCode 索引本身還在（只是不再單獨使用）');

{
  // 前端的 recLookupOf 用真原始碼跑一次
  const m = /function recLookupOf\(rows\) \{[\s\S]*?\n    \}/.exec(CODE);
  assertEqual(!!m, true, '前提：找得到 recLookupOf');
  const nn = pick(CODE, 'normName'), nc = pick(CODE, 'normCode');
  const find = new Function(nn + ';' + nc + ';' + m[0] + '; return recLookupOf;')();
  const rows = [{ 店號: '019150', 店名: '三峽峇里店', 主責課: '北二課' }];
  const look = find(rows);
  assertEqual(!!look('026169', '三峽峇里店'), true,
    '★ 名單是新店號 026169、紀錄是舊店號 019150 時，要靠店名認出是同一家');
  assertEqual(!!look('019150', ''), true, '沒有店名時仍要能用店號查到');
  assertEqual(look('099999', '不存在店'), null, '真的不同的店不可誤配');
  // 店號空白不可以變成一把通用鑰匙
  const look2 = find([{ 店號: '', 店名: '某店' }]);
  assertEqual(look2('', ''), null, '★ 店號與店名都空白時不可以配到任何一筆');
}

// ===== B. 已點檢判斷雙鍵 =====
assertEqual(/return \{ codes: codes, names: names \};/.test(GSC), true,
  '★ getInspectedCodes 要一併回傳店名');
assertEqual(/const isInspected = \(code, name\) => !!inspectedCodes\[normCode\(code\)\] \|\| !!inspectedNames\[normName\(name\)\];/.test(CODE), true,
  '★ 前端要有 isInspected：店號或店名任一命中就算點過');
assertEqual(/inspectedCodes\[normCode\(s\.code\)\] && !editingThis/.test(CODE), false,
  '★ 店鋪選單的「已完成」標記不可再只看店號');
for (const [re, label] of [
  [/if \(!isEdit && isInspected\(effStore\.code, effStore\.name\)\)/, '送出前最後一道要用 isInspected'],
  [/if \(isInspected\(code, inRoster\.name\)\)/, '新增名單外店鋪也要用 isInspected'],
  [/done: isInspected\(s\.code, s\.name\) && !editingThis/, '選單標記要用 isInspected'],
]) assertEqual(re.test(CODE), true, '★ ' + label);
// 送出成功後就地標記，店名也要記（否則重新整理前又會被判成可點檢）
assertEqual((CODE.match(/setInspectedNames\(prev => \(\{ \.\.\.prev, \[normName\(storeName\)\]: true \}\)\)/g) || []).length, 2,
  '★ 送出成功與 DUPLICATE 兩條路都要把店名記進去');
// 舊後端只回 codes 時要能降級，不可以爆掉
assertEqual(/names: r\.names \|\| \[\]/.test(CODE), true,
  '★ 舊後端沒有 names 時要退回只比店號（＝改動前的行為），不可以爆掉');

// ===== C. 編輯回填加店名備援 =====
assertEqual(/const inRoster = STORE_ROSTER\.find\(s => normName\(s\.name\) === normName\(rec\.storeName\)\)\s*\n\s*\|\| STORE_ROSTER\.find\(s => normCode\(s\.code\) === normCode\(rec\.storeCode\)\);/.test(CODE), true,
  '★ 編輯回填要店名優先、店號備援（否則落到 __custom 用舊店號，照片檔名就錯了）');

// ===== C2. 「尚未點檢」匯出的店名備援不可再是死碼 =====
assertEqual(/done\.add\('n:' \+ n\)/.test(CODE), true,
  '★ done 要放店名 —— 原本過濾條件寫了店名備援，但 done 從來沒放過店名，是做一半的功能');
assertEqual(/!done\.has\('c:' \+ normCode\(s\.code\)\) && !done\.has\('n:' \+ normName\(s\.name\)\)/.test(CODE), true,
  '過濾要同時比店號與店名');

// ===== D. 匯入時偵測店號異動 =====
assertEqual(/function diffStoreCodes_\(sh, head, rows\)/.test(GSC), true, '★ 後端要有 diffStoreCodes_');
assertEqual(/var codeChanges = \(kind === 'roster' \|\| kind === 'stores'\)/.test(GSC), true,
  '★ 名單與店鋪主檔都要偵測（使用者明確問了這兩個）');
{
  // diffStoreCodes_ 用真原始碼跑一次
  const m = /function diffStoreCodes_\(sh, head, rows\) \{[\s\S]*?\n\}/.exec(GSC);
  assertEqual(!!m, true, '前提：抓得到 diffStoreCodes_ 全文');
  const nn = pick(GSC, 'normName'), nc = pick(GSC, 'normCode');
  const fn = new Function(nn + ';' + nc + ';' + m[0] + '; return diffStoreCodes_;')();
  const head = ['店號', '店名', '課別'];
  const old = [['019150', '三峽峇里店', '北二課'], ['016663', '潭子祥和店', '台中一課'], ['020000', '要被移除的店', 'X課']];
  const sh = {
    getLastRow: () => old.length + 1,
    getRange: () => ({ getValues: () => old }),
  };
  const rows = [
    { 店號: '026169', 店名: '三峽峇里店', 課別: '北二課' },   // 改號
    { 店號: '016663', 店名: '潭子祥和店', 課別: '台中一課' },  // 不變
    { 店號: '0016663', 店名: '潭子祥和店2', 課別: 'Y課' },     // 新增（且帶前導零）
  ];
  const r = fn(sh, head, rows);
  assertEqual(r.changed, [{ name: '三峽峇里店', from: '019150', to: '026169' }],
    '★ 只回報「店名對得上但店號不同」的');
  assertEqual(r.added, 1, '新增的店只給數量');
  assertEqual(r.removed, 1, '消失的店只給數量');

  // 前導零的差異不算改號 —— 那是格式問題（2026-09-03 已另案處理），不是門市重新編號
  const r2 = fn(sh, head, [{ 店號: '19150', 店名: '三峽峇里店' }]);
  assertEqual(r2.changed, [], '★ 019150 → 19150 不算改號（只是前導零掉了），不可誤報');

  // 沒有店號或店名欄的表（例如題庫）要回 null，不可以爆掉
  assertEqual(fn(sh, ['編號', '題目'], rows), null, '不適用的表要回 null');
}
assertEqual(/有 \$\{chg\.length\} 家店的店號變更/.test(CODE), true, '★ 前端要把異動清單顯示出來');
assertEqual(/後端版本過舊。若這次名單有門市改號，系統不會提醒你。/.test(CODE), true,
  '★ 舊後端回不出 codeChanges 時要說清楚 —— 否則會被誤讀成「沒有異動」');

// ===== 版本 =====
assertEqual(/var GAS_VERSION = '20260904-1210';/.test(GS), true, '後端版號要更新（這批動了後端）');
assertEqual(/const NEEDS_GAS = '20260904-1210';/.test(APP), true, '前端要求的後端版本要跟上');

console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
process.exit(failed ? 1 : 0);
