// 回歸測試：多缺失項的題目「鎖定幾個扣分項就要幾張缺失照片」
//   扣分項數＝缺失單位數（ngUnitsOf）：固定子項用其 units；填寫型子項填幾個名稱算幾個。
//   這份定義必須與扣分邏輯共用一份 —— 否則會出現「畫面扣 4 分卻只要求 1 張照片」。
//   本測試直接從 app.html 取出 ngUnitsOf 驗證，確保它就是畫面在用的那一份。
// 執行方式：node backend/test/photoPerDefect.test.js
const path = require('path');
const vm = require('vm');
const fs = require('fs');

const APP_PATH = path.join(__dirname, '..', '..', 'app.html');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const src = fs.readFileSync(APP_PATH, 'utf8');
const pick = (re, name) => { const m = re.exec(src); if (!m) throw new Error('在 app.html 找不到 ' + name); return m[0]; };
const code = [
  pick(/const subLabelOf = [^\n]+/, 'subLabelOf'),
  pick(/const subIsCustom = [^\n]+/, 'subIsCustom'),
  pick(/const subFixedUnits = [^\n]+/, 'subFixedUnits'),
  pick(/const splitNames = [^\n]+/, 'splitNames'),
  pick(/function ngUnitsOf\(item, st\) \{[\s\S]*?\n    \}/, 'ngUnitsOf'),
].join('\n');
const sb = { Math, String, Number };
vm.createContext(sb);
vm.runInContext(code + '; this.ngUnitsOf = ngUnitsOf; this.splitNames = splitNames;', sb);
const { ngUnitsOf, splitNames } = sb;

// 第12題的實際子項設定：其他貨架為「填寫型」，其餘為單一單位
const item12 = {
  id: 'A12', name: '12.價格清楚標示', type: 'subdeduct', max: 12, perPoint: 2,
  subs: ['OC', 'WI', '冷凍櫃', '口巧', '零食', '加工', 'TM前貨架', { label: '其他貨架', custom: true }],
};
// 有「多單位」子項的題目（如 :2 的寫法）
const itemMulti = {
  id: 'A13', name: '13.機台清潔', type: 'subdeduct', max: 10, perPoint: 1,
  subs: [{ label: '馬鈴薯機', units: 2 }, '夯番麥', { label: '其他機台', custom: true }],
};

// ===== 1. 沒有缺失 → 不需要照片 =====
assertEqual(ngUnitsOf(item12, {}), 0, '沒勾任何子項＝0 個扣分項');
assertEqual(ngUnitsOf(item12, { ngSubs: [] }), 0, '空陣列＝0');

// ===== 2. 一般子項：勾幾個算幾個 =====
assertEqual(ngUnitsOf(item12, { ngSubs: ['口巧'] }), 1, '勾1個一般子項＝1張照片');
assertEqual(ngUnitsOf(item12, { ngSubs: ['口巧', 'TM前貨架'] }), 2, '勾2個一般子項＝2張照片');

// ===== 3. 填寫型子項：填幾個名稱算幾個（使用者的實際案例）=====
//   中和景會店：勾「其他貨架」並填「報架，其他」→ 2 個貨架 → 扣 4 分 → 需要 2 張照片
assertEqual(ngUnitsOf(item12, { ngSubs: ['其他貨架'], customNames: { '其他貨架': '報架，其他' } }), 2,
  '填寫型子項填2個名稱＝2個扣分項（與扣4分一致）');
assertEqual(ngUnitsOf(item12, { ngSubs: ['其他貨架'], customNames: { '其他貨架': '報架' } }), 1,
  '填1個名稱＝1個扣分項');
assertEqual(ngUnitsOf(item12, { ngSubs: ['其他貨架'], customNames: {} }), 1,
  '勾了但還沒填名稱時至少算1個（不可算0而放過照片檢查）');
assertEqual(ngUnitsOf(item12, { ngSubs: ['口巧', '其他貨架'], customNames: { '其他貨架': '報架、其他、第三個' } }), 4,
  '一般子項1個 + 填寫型3個 = 4個扣分項');

// ===== 4. 多單位子項 =====
assertEqual(ngUnitsOf(itemMulti, { ngSubs: ['馬鈴薯機'] }), 2, '單一子項標記2單位＝2個扣分項');
assertEqual(ngUnitsOf(itemMulti, { ngSubs: ['馬鈴薯機', '夯番麥'] }), 3, '2單位 + 1單位 = 3');

// ===== 5. 名稱分隔符號：多種符號都要能切 =====
assertEqual(splitNames('報架，其他'), ['報架', '其他'], '全形逗號');
assertEqual(splitNames('報架, 其他'), ['報架', '其他'], '半形逗號加空白');
assertEqual(splitNames('報架、其他'), ['報架', '其他'], '頓號');
assertEqual(splitNames('報架/其他'), ['報架', '其他'], '斜線');
assertEqual(splitNames('報架 其他'), ['報架', '其他'], '空白');
assertEqual(splitNames('  '), [], '只有空白＝0個');

// ===== 6. 不在子項清單裡的標籤要忽略（題庫改版後的舊紀錄）=====
assertEqual(ngUnitsOf(item12, { ngSubs: ['已被移除的子項'] }), 0, '題庫已無該子項時不計入，避免舊紀錄要求不存在的照片');

// ===== 7. 送出檢查的算式：needShots 與 haveShots =====
//   app.html: needShots = max(1, ngUnitsOf)；haveShots = 新照片 + 既有照片
const needShots = (item, st) => Math.max(1, ngUnitsOf(item, st));
assertEqual(needShots(item12, { ngSubs: ['其他貨架'], customNames: { '其他貨架': '報架，其他' } }), 2, '需要2張');
assertEqual(needShots(item12, { ngSubs: [] }), 1, '扣分但沒勾子項時仍至少要1張');
const enough = (need, fresh, existing) => (fresh + existing) >= need;
assertEqual(enough(2, 2, 0), true, '新拍2張足夠');
assertEqual(enough(2, 1, 1), true, '新拍1張+原照片1張足夠（編輯時不必重傳）');
assertEqual(enough(2, 1, 0), false, '只有1張不足，應擋下');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
