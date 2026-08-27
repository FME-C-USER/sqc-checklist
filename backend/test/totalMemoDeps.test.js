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
// 直接取用 app.html 裡那一行，確保測的是同一份算式而不是我抄的版本
const formula = /checklist\.categories\.forEach\(c => c\.items\.forEach\(it => \{ const s = scores\[it\.id\]; t \+= \(s && s\.score != null\) \? s\.score : it\.max; \}\)\);/.exec(APP);
assertEqual(!!formula, true, '找得到合計的算式');
const totalOf = new Function('checklist', 'scores', `let t = 0; ${formula ? formula[0] : ''} return t;`);

const CHECKLIST = {
  categories: [
    { key: '1.店外', max: 30, items: [{ id: 'A1', max: 20 }, { id: 'A2', max: 10 }] },
    { key: '2.櫃台', max: 70, items: [{ id: 'B1', max: 70 }] },
  ],
};
assertEqual(totalOf(CHECKLIST, {}), 100, '題庫已到、使用者還沒動過任何一題 → 應為滿分 100，不是 0');
assertEqual(totalOf(CHECKLIST, { A1: { score: 15 } }), 95, '扣了 5 分 → 95');
assertEqual(totalOf(CHECKLIST, { A1: { score: 0 }, B1: { score: 0 } }), 10, '兩題 0 分 → 只剩 A2 的 10 分');
// 題庫還沒到（空 categories）本來就會是 0 —— 這正是原本卡住的那個值，
// 差別在於「題庫到了以後要能重算」，所以依賴陣列才是關鍵。
assertEqual(totalOf({ categories: [] }, {}), 0, '題庫未到時為 0（合理，但必須能被後續重算取代）');

console.log(failed ? `\n✗ ${failed} 項未通過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);
