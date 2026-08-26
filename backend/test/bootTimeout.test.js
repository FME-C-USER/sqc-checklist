// 回歸測試：開場載入的逾時與「快取值不可假裝成即時值」
//   現場 2026-08-26：畫面一直出現「連線不穩…（伺服器逾時未回應（12 秒））」，
//   而且「後端版本」數字永遠不動。查出兩件事：
//     1. 逾時是全域 12 秒，但 getBootstrap 要搬 1500+ 家店名單＋題庫＋觀察題＋人員，
//        伺服器端有六次完整活頁讀取，本來就可能十幾秒 —— 用 12 秒等於每次都在逾時邊緣。
//     2. 載入失敗時整份開場資料（含後端版本號）是 localStorage 的快取，畫面卻讓它看起來
//        像即時值 → 使用者以為後端沒貼成功，反覆重貼都沒用。
//   另外把 getBootstrap 裡重複讀取的「點檢人員」去掉（原本 staffs 與 distinctDepts 各讀一次）。
// 執行方式：node backend/test/bootTimeout.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'api.js'), 'utf8');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. 逾時要按動作分，重的動作不可被 12 秒砍掉 =====
const mBy = /const TIMEOUT_BY_ACTION = \{[\s\S]*?\n  \};/.exec(API);
const mTs = /const timeoutsOf = \(action\) => \{[\s\S]*?\n  \};/.exec(API);
assertEqual(!!mBy && !!mTs, true, '應能找到 TIMEOUT_BY_ACTION 與 timeoutsOf');
const sb = { TIMEOUT_MS: 12000 };
vm.createContext(sb);
vm.runInContext(mBy[0] + '\n' + mTs[0] + '; this.fn = timeoutsOf;', sb);
const timeoutsOf = sb.fn;
const RETRY = [700, 1500, 3000];
const worst = (a) => {
  const ts = timeoutsOf(a);
  return ts.reduce((s, x, i) => s + x + (i + 1 < ts.length ? RETRY[Math.min(i, 2)] : 0), 0);
};
// 重的動作：第一次仍用短逾時（快速跳過轉送層偶發的 404），第二次才給足時間
assertEqual(timeoutsOf('getBootstrap')[0], 12000, '開場載入第一次仍用 12 秒');
assertEqual(timeoutsOf('getBootstrap')[1] >= 30000, true, '第二次要給足時間（六次整表讀取＋1500 家店的傳輸）');
assertEqual(timeoutsOf('getBootstrap').length, 2, '重的動作只嘗試兩次，否則失敗要等好幾分鐘');
assertEqual(timeoutsOf('buildMonthlyReport')[1] >= 30000, true, '產報表要更久');
assertEqual(timeoutsOf('importMaster')[1] >= 30000, true, '匯入名單要更久');
assertEqual(timeoutsOf('repairPhotoLinks')[1] >= 30000, true, '整月照片修復要更久');
// 輕量動作維持四次短逾時
assertEqual(timeoutsOf('submitRecord'), [12000, 12000, 12000, 12000], '送出維持四次 12 秒');
assertEqual(timeoutsOf('checkEditPass'), [12000, 12000, 12000, 12000], '未列出的動作用預設值');
// 最壞總等待不可比原本（12×4＋間隔＝53 秒）長太多，否則失敗時像卡死
assertEqual(worst('getBootstrap') <= 75000, true, '開場載入最壞總等待不超過 75 秒（實際 58 秒）');
assertEqual(worst('submitRecord'), 53200, '送出的最壞總等待與原本相同');
// 逾時訊息要講實際用的秒數，不可寫死 12
assertEqual(API.includes("'伺服器逾時未回應（' + Math.round(ms / 1000) + ' 秒）'"), true,
  '逾時訊息要顯示該次實際的逾時秒數');
assertEqual(API.includes('const out = await attempt(action, payload, timeouts[i]);'), true, '每次嘗試用各自的逾時');
assertEqual(/setTimeout\(\(\) => ctrl\.abort\(\), TIMEOUT_MS\)/.test(API), false, '不可再用全域逾時');
// 重試的睡眠要以「還有沒有下一次」為準，不可用 RETRY_DELAYS 的長度（重動作只有兩次）
assertEqual(API.includes('if (i + 1 < maxAttempts) {'), true, '最後一次失敗後不可再多睡一輪');

// ===== 2. 載入失敗時，版本號要標明是快取值 =====
assertEqual(APP.includes("後端 {gasVer || '—'}{bootWarn ? '（上次載入時）' : ''}"), true,
  '載入失敗時要在版本號後面標「（上次載入時）」');
assertEqual(APP.includes('這是「上次成功載入時」看到的後端版本'), true, '滑過去要說清楚那是快取值');
assertEqual(/\{!bootWarn && gasVer && gasVer < NEEDS_GAS &&/.test(APP), true,
  '載入失敗時不可顯示「需 xxx 以上」—— 拿快取值比對會叫人去貼一份其實已經貼好的後端');
assertEqual(/className=\{bootWarn \? 'text-slate-400'/.test(APP), true, '快取值要灰掉，視覺上就看得出不是即時的');

// ===== 2b. 失敗訊息要對得上原因，不可一律叫「連線不穩」 =====
//   逾時的成因是 Google 服務回應過慢，說「連線不穩」會讓使用者去檢查自己的網路（白忙）
const fm = /const bootFailMsg = \(e\) => \{[\s\S]*?\n      \};/.exec(APP);
assertEqual(!!fm, true, '應能找到 bootFailMsg');
const sb2 = {};
vm.createContext(sb2);
vm.runInContext(fm[0] + '; this.fn = bootFailMsg;', sb2);
const bootFailMsg = sb2.fn;
assertEqual(bootFailMsg({ message: '伺服器忙碌中，請稍後再試一次（伺服器逾時未回應（45 秒））' }).indexOf('Google 服務回應過慢') === 0, true,
  '逾時／忙碌要說是 Google 服務回應過慢');
assertEqual(bootFailMsg({ message: '伺服器逾時未回應（45 秒）' }).includes('不是你的網路問題'), true,
  '要明講不是使用者的網路問題');
assertEqual(bootFailMsg({ message: '網路連線中斷，請稍後再試（Failed to fetch）' }).indexOf('網路連線中斷') === 0, true,
  '真的斷線才說網路連線中斷');
assertEqual(bootFailMsg({ message: '後端未回傳資料（動作：getBootstrap），請確認 Apps Script 已重新部署新版本' }).indexOf('線上後端版本過舊') === 0, true,
  '後端太舊要直接說，不要混進連線問題');
assertEqual(bootFailMsg({}).indexOf('載入失敗') === 0, true, '沒有訊息時用中性說法');
assertEqual(bootFailMsg({ message: 'X' }).includes('目前顯示上次載入的資料'), true, '一律要說明畫面上是舊資料');
assertEqual(APP.includes('連線不穩，目前顯示'), false, '不可再有寫死的「連線不穩」');
assertEqual((APP.match(/setBootWarn\(bootFailMsg\(e\)\)/g) || []).length, 3, '三個失敗入口都要用同一個訊息函式');

// ===== 3. getBootstrap 不可重複讀同一張活頁 =====
const GS = fs.readFileSync(GS_PATH, 'utf8');
const boot = /function getBootstrap\(month, section, light\) \{[\s\S]*?\n\}/.exec(GS);
assertEqual(!!boot, true, '應能找到 getBootstrap');
assertEqual((boot[0].match(/readSheet\('點檢人員'\)/g) || []).length, 1, '「點檢人員」只能讀一次');
assertEqual(boot[0].includes('distinctDepts(people)'), true, '部課對照要沿用已讀好的資料');
assertEqual(/function distinctDepts\(rows\) \{\s*\n\s*rows = rows \|\| readSheet\('點檢人員'\);/.test(GS), true,
  'distinctDepts 要能接受傳入的資料，也要能獨立呼叫（其他地方仍在用）');

// 實際跑一次，確認行為沒變
const { ctx } = loadGasFile(GS_PATH);
ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.ensureMonth('11508');
ctx.upsertRow('staff', null, { 工號: 'A1', 姓名: '甲', 部別: '一部', 課別: '北一課', 職稱: '員', 角色: '點檢員' });
ctx.upsertRow('staff', null, { 工號: 'A2', 姓名: '乙', 部別: '一部', 課別: '北二課', 職稱: '員', 角色: '點檢員' });
ctx.upsertRow('staff', null, { 工號: 'A3', 姓名: '丙', 部別: '', 課別: '', 職稱: '', 角色: '管理者' });
const b = ctx.getBootstrap('11508', '');
assertEqual(b.staffs.map(s => s.name), ['甲', '乙'], '沒填部/課的人員不進下拉（行為不變）');
assertEqual(b.depts, [{ dept: '一部', sections: ['北一課', '北二課'] }], '部課對照正確');
assertEqual(ctx.distinctDepts(), [{ dept: '一部', sections: ['北一課', '北二課'] }], '不傳參數時仍可獨立運作');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
