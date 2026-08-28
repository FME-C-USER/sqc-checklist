// 回歸測試：合計得分的 useMemo 漏了 checklist 依賴（2026-08-27 於煙霧測試中發現）
//
// 題庫是開場 API 回來才有的。第一次算 total 時 checklist.categories 還是空陣列 → 0；
// 只依賴 [scores] 的話，題庫到達不會觸發重算，於是在「使用者還沒動過任何一題」之前
// 合計永遠停在 0。實測畫面上分區小計顯示 5/5、合計卻顯示 0/10，兩個數字自相矛盾；
// 若全店滿分而點檢人員沒去動任何得分就送出，會寫進一筆 0 分「不合格」的紀錄。
//
// 這裡除了檢查依賴陣列，也把 total 的算式抽出來實跑一次，確認
// 「scores 為空 + 題庫已到」的組合算出的是滿分而不是 0。
// 執行方式：node backend/test/totalMemoDeps.test.js
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 依賴陣列 =====
// 取出 total 的 useMemo（從 const total = useMemo 到它的依賴陣列）
const totalBlock = /const total = useMemo\(\(\) => \{([\s\S]*?)\}, \[([^\]]*)\]\);/.exec(APP);
assertEqual(!!totalBlock, true, '找得到 total 的 useMemo');
const totalDeps = totalBlock ? totalBlock[2].split(',').map(s => s.trim()) : [];
assertEqual(totalDeps.includes('scores'), true, 'total 要依賴 scores');
assertEqual(totalDeps.includes('checklist'), true, 'total 要依賴 checklist（題庫後到，否則永遠算不到）');

const ndBlock = /const noDeductDefect = useMemo\(([\s\S]*?)\, \[([^\]]*)\]\);/.exec(APP);
assertEqual(!!ndBlock, true, '找得到 noDeductDefect 的 useMemo');
const ndDeps = ndBlock ? ndBlock[2].split(',').map(s => s.trim()) : [];
assertEqual(ndDeps.includes('checklist'), true, 'noDeductDefect 也要依賴 checklist（它決定要不要求滿分照片）');

// 凡是函式體用到 checklist 的 useMemo，依賴就必須含 checklist —— 一次抓完，避免以後又漏
const memoRe = /const (\w+) = useMemo\(([\s\S]*?)\, \[([^\]]*)\]\);/g;
let m;
const leaks = [];
while ((m = memoRe.exec(APP))) {
  const [, name, bodyText, deps] = m;
  const list = deps.split(',').map(s => s.trim());
  if (/\bchecklist\b/.test(bodyText) && !list.includes('checklist')) leaks.push(name);
}
assertEqual(leaks, [], '所有用到 checklist 的 useMemo 都要把它列進依賴');

// ===== 把算式抽出來實跑 =====
// 直接取用 app.html 裡的那幾行，確保測的是同一份算式而不是我抄的版本。
// 2026-08-27 起合計改成走 scoreOfItem（全 App 唯一的計分算式），
// 不再讀 state 裡的 score —— 那個值原本是由非同步 useEffect 寫回的。
const grab = (re, label) => { const m = re.exec(APP); if (!m) throw new Error('抓不到 ' + label); return m[0]; };
assertEqual(/checklist\.categories\.forEach\(c => c\.items\.forEach\(it => \{ t \+= scoreOfItem\(it, scores\[it\.id\]\); \}\)\);/.test(APP), true,
  '合計要用 scoreOfItem');
assertEqual(/\(s\.score != null\) \? s\.score : it\.max/.test(APP), false,
  '合計不可再直接讀 state 裡的 score');
const deps = [
  grab(/const subLabelOf = [^\n]*/, 'subLabelOf'),
  grab(/const subIsCustom = [^\n]*/, 'subIsCustom'),
  grab(/const subFixedUnits = [^\n]*/, 'subFixedUnits'),
  grab(/const splitNames = [^\n]*/, 'splitNames'),
  grab(/function ngUnitsOf\(item, st\) \{[\s\S]*?\n    \}/, 'ngUnitsOf'),
  grab(/const scoreOfItem = \(item, st\) => \{[\s\S]*?\n    \};/, 'scoreOfItem'),
].join('\n');
const totalOf = new Function('checklist', 'scores', `${deps}
  let t = 0;
  checklist.categories.forEach(c => c.items.forEach(it => { t += scoreOfItem(it, scores[it.id]); }));
  return t;`);

const SUBS = [{ label: 'OC' }, { label: '其他貨架', custom: true }];
const CHECKLIST = {
  categories: [
    { key: '1.店外', max: 30, items: [{ id: 'A1', max: 20, type: 'deduct' }, { id: 'A2', max: 10, type: 'deduct' }] },
    { key: '2.櫃台', max: 70, items: [{ id: 'B1', max: 70, type: 'deduct' }] },
  ],
};
assertEqual(totalOf(CHECKLIST, {}), 100, '題庫已到、使用者還沒動過任何一題 → 應為滿分 100，不是 0');
assertEqual(totalOf(CHECKLIST, { A1: { score: 15 } }), 95, '扣了 5 分 → 95');
assertEqual(totalOf(CHECKLIST, { A1: { score: 0 }, B1: { score: 0 } }), 10, '兩題 0 分 → 只剩 A2 的 10 分');
assertEqual(totalOf({ categories: [] }, {}), 0, '題庫未到時為 0（合理，但必須能被後續重算取代）');

// 分區扣分題：合計必須由勾選內容現算，而且「state 裡殘留的舊 score 要被忽略」——
// 這正是「填寫 88、編輯 92」的根因（存下來的 score 落後一步）
const SUB_LIST = {
  categories: [{ key: '商品陳列', max: 18, items: [{ id: 'B10', max: 18, type: 'subdeduct', perPoint: 2, subs: SUBS }] }],
};
assertEqual(totalOf(SUB_LIST, {}), 18, '沒勾任何子項 → 滿分');
assertEqual(totalOf(SUB_LIST, { B10: { ngSubs: ['OC'] } }), 16, '勾一個固定子項 → 扣 2');
assertEqual(totalOf(SUB_LIST, { B10: { ngSubs: ['其他貨架'], customNames: { 其他貨架: '日用品架、寵物架' } } }), 14,
  '填寫型子項兩個名稱 → 扣 4');
assertEqual(totalOf(SUB_LIST, { B10: { ngSubs: ['其他貨架'], customNames: { 其他貨架: 'TM 前貨架' } } }), 16,
  '含空格的名稱算一個貨架 → 只扣 2（空白已不是分隔符）');
assertEqual(totalOf(SUB_LIST, { B10: { score: 12, ngSubs: [] } }), 18,
  '★ state 裡殘留的舊 score(12) 必須被忽略，一律由勾選現算 → 18');
assertEqual(totalOf(SUB_LIST, { B10: { score: 18, ngSubs: ['OC', '其他貨架'], customNames: { 其他貨架: 'A、B' } } }), 12,
  '★ 反向：殘留的 score(18) 也要被忽略 → 3 個單位扣 6 → 12');

console.log(failed ? `\n✗ ${failed} 項未通過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);
