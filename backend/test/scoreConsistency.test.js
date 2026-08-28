// 回歸測試：2026-08-27 的六項改動
//   1 分區扣分題的分數一律現算（scoreOfItem），不再由非同步 useEffect 寫回 state
//   2 取消勾選填寫型子項時要清掉已輸入的文字（隱藏資料）
//   3 後端不再有「有填名稱但沒勾選也呈現」的保險
//   4 attachPhotoLinks 鎖內不可讀整張活頁
//   5 recomputeScores：重算既有紀錄，且刻意沿用舊的空白分隔規則
//   6 照片張數蓋住配分上限（見 photoPerDefect.test.js）
// 執行方式：node backend/test/scoreConsistency.test.js
const fs = require('fs');
const path = require('path');
const { loadGasFile } = require('./gas-fake-env');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const GS = fs.readFileSync(path.join(ROOT, 'backend', '程式碼.gs'), 'utf8');
const SETUP = fs.readFileSync(path.join(ROOT, 'backend', 'setup.gs'), 'utf8');
// 註解裡會提到舊寫法，掃程式碼時要先剝掉
const CODE = APP.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. 不可再有把分數寫回 state 的 effect =====
assertEqual(/useEffect\([^)]*setState\(\{ \.\.\.s, score: subdeductScore \}\)/.test(CODE), false,
  '不可再用 useEffect 把算出來的分數寫回 state（passive effect 在繪製後才沖洗，'
  + '送出落在那個窗口就會存到上一步的分數 —— 現場的「填寫 88、編輯 92」）');
assertEqual(/const subdeductScore = /.test(CODE), false, 'subdeductScore 這個中間變數應已移除');
assertEqual(/const scoreOfItem = \(item, st\) => \{/.test(CODE), true, '要有全 App 唯一的 scoreOfItem');
// 所有讀分數的地方都要走同一支
['const score = scoreOfItem(item, s);',
  't += scoreOfItem(it, scores[it.id]);',
  's + scoreOfItem(it, scores[it.id])',
  'score: scoreOfItem(it, s)',
  'const ng = scoreOfItem(it, scores[it.id]) < it.max;',
  'if (scoreOfItem(it, s) < it.max) addPhotos',
  'const ng = scoreOfItem(it, s) < it.max;',
].forEach(t => assertEqual(CODE.includes(t), true, '要用 scoreOfItem：' + t));
assertEqual(/scoreOfItem\(it, scores\[it\.id\]\) === it\.max/.test(CODE), true, 'noDeductDefect 也要用 scoreOfItem');

// ===== 2. 取消勾選要清掉已輸入的名稱 =====
// 2026-08-28 起 toggleSub 改用 updater（patch(p => ...)），判斷要讀 prev 而不是 render 快照
assertEqual(CODE.includes('if (on && p.customNames && p.customNames[lbl] != null) {'), true,
  'toggleSub 關閉時要清掉該子項的 customNames（以 prev 判斷）');
assertEqual(CODE.includes('delete cn[lbl];'), true, '要真的刪掉那個鍵，不是設成空字串');

// ===== 3. 後端不再有「未勾選也呈現」的保險 =====
assertEqual(/if \(ngSubs\.indexOf\(k\) < 0 && customNames\[k\]\) labels\.push/.test(GS), false,
  '後端不可再把「有填名稱但沒勾選」的文字列成缺失（分數沒扣到它，報表卻列出來）');

// ===== 4. attachPhotoLinks 鎖內不可讀整張活頁 =====
{
  const fn = /function attachPhotoLinks\([\s\S]*?\n\}/.exec(GS)[0];
  assertEqual(/getDataRange\(\)/.test(fn), false, 'attachPhotoLinks 不可用 getDataRange（全域鎖會被整張表的讀取佔住）');
  assertEqual(/sh\.getRange\(2, idCol \+ 1, lastRow - 1, 1\)\.getValues\(\)/.test(fn), true, '只讀「紀錄ID」一欄');
  assertEqual(/safeJson\(sh\.getRange\(i \+ 1, photoCol \+ 1\)\.getValue\(\)\)/.test(fn), true, '只讀命中那一列的照片JSON 一格');
  assertEqual(/lock\.waitLock\(20000\)/.test(fn), true, '鎖要保留（讀取-修改-寫回同一格需要互斥）');
}

// ===== 5. recomputeScores =====
assertEqual(/function recomputeScores\(month, doWrite\)/.test(SETUP), true, 'setup.gs 要有 recomputeScores');
assertEqual(/recomputeScores: 1/.test(GS), true, 'recomputeScores 必須列為管理者專用（會直接改分數）');
assertEqual(/recomputeScores: function \(\) \{ return recomputeScores\(p\.month, p\.write === true\); \}/.test(GS), true,
  '路由要把 write 明確轉成布林（避免任何真值都當成寫入）');
// 重算刻意用「舊」的分隔規則：新規則回頭套用會把當初刻意用空白分隔的紀錄無故加回分數
assertEqual(/function splitNamesLegacy_\(v\) \{[\s\S]*?\[\\s,，、;；\\\/\|\]/.test(SETUP), true,
  '重算要用含空白的舊分隔規則（splitNamesLegacy_）');
assertEqual(/spaceWarn/.test(SETUP), true, '含空白的名稱要另外列出來讓人工判斷');
assertEqual(/hiddenWarn/.test(SETUP), true, '有填名稱但沒勾選的要另外列出來（報表內容會改變）');

// 實跑 recomputeScores 的算式（從 setup.gs 抽出來，測的是同一份程式碼）
{
  const src = [
    /function splitNamesLegacy_\(v\) \{[\s\S]*?\n\}/.exec(SETUP)[0],
    /function ngUnitsLegacy_\(item, d\) \{[\s\S]*?\n\}/.exec(SETUP)[0],
    /function gradeOfScore_\(total, pass\) \{[\s\S]*?\n\}/.exec(SETUP)[0],
  ].join('\n');
  const ctx = {};
  require('vm').createContext(ctx);
  require('vm').runInContext(src + '\nthis.ngUnitsLegacy_=ngUnitsLegacy_;this.gradeOfScore_=gradeOfScore_;', ctx);
  const item = { id: 'B10', max: 18, perPoint: 2, type: 'subdeduct',
    subs: [{ label: 'OC' }, { label: 'WI' }, { label: '其他貨架', custom: true }] };
  const scoreOf = (d) => Math.max(0, item.max - ctx.ngUnitsLegacy_(item, d) * item.perPoint);

  assertEqual(scoreOf({ ngSubs: [] }), 18, '沒勾 → 滿分');
  assertEqual(scoreOf({ ngSubs: ['OC'] }), 16, '勾一個 → 16');
  assertEqual(scoreOf({ ngSubs: ['其他貨架'], customNames: { 其他貨架: '日用品架、寵物架' } }), 14, '兩個名稱 → 14');
  // 重算沿用舊規則：空白仍算分隔符，所以「TM 前貨架」在重算時仍是 2 個單位。
  // 這是刻意的 —— 不能拿新規則回頭改變當初的語意。
  assertEqual(scoreOf({ ngSubs: ['其他貨架'], customNames: { 其他貨架: 'TM 前貨架' } }), 14,
    '重算沿用舊規則：含空白仍算 2 個單位（新規則只適用於往後的紀錄）');
  assertEqual(scoreOf({ ngSubs: ['不存在的子項'] }), 18, '題庫已無該子項 → 不計（與前端一致）');
  assertEqual(scoreOf({ ngSubs: ['OC', 'WI', '其他貨架'], customNames: { 其他貨架: 'A、B、C、D、E、F、G、H' } }), 0,
    '扣超過配分時壓到 0，不可為負');
  assertEqual([ctx.gradeOfScore_(96, 85), ctx.gradeOfScore_(90, 85), ctx.gradeOfScore_(84, 85)],
    ['優良', '合格', '不合格'], '等第門檻與前端 gradeOf 一致（95／及格分數）');
}

// ===== 前端提示文字要改掉，不然使用者還會被教去用空白分隔 =====
assertEqual(/多個貨架請用空格或符號/.test(APP), false, '不可再叫使用者用空白分隔');
assertEqual(/多個貨架請用「、」或「,」「\/」隔開/.test(APP), true, '要明確說用符號');
assertEqual(/placeholder="例：日用品架、寵物貨架"/.test(APP), true, 'placeholder 不可再示範空白分隔');

console.log(failed ? `\n✗ ${failed} 項未通過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);
