// 回歸測試：已點檢的店不可以被選到（含「還在確認中」的空窗期）
//   現場（2026-08-25）：同事選到昨天已點檢的店，填完整份表、上傳完照片，按送出才被擋。
//   根因是競態：店鋪名單走 localStorage 快取、開 App 立刻畫出來，而「本月已點檢的店號」
//   要等一趟後端往返（而且刻意排在 getBootstrap 之後）。中間那幾秒每家店都顯示成沒點過。
//   已在瀏覽器重現：把 queryRecords 延遲 6 秒，1.2s～6.3s 之間該店都是「可點」。
//   三個修法都要在位，缺一個就補不完：
//     1. 確認完才能選店（也涵蓋確認失敗的情況）
//     2. 確認結果回來後若已選到已點檢的店，立刻取消選擇並說明
//     3. 查詢失敗不可靜音 —— 原本 catch 是空的，一次失敗就讓整個 session 的防重複失效
// 執行方式：node backend/test/storePickGuard.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. 確認狀態必須外顯，且選店要等它 =====
assertEqual(APP.includes("const [inspectedState, setInspectedState] = useState({ loaded: false, err: '' })"), true,
  '要有「已確認 / 確認失敗」狀態，初始為未確認');
assertEqual(APP.includes('const pickReady = inspectedState.loaded || !!editingRecordId;'), true,
  '選店的開關綁在確認狀態上（編輯既有紀錄例外，那時店鋪是固定的）');
assertEqual(APP.includes('disabled={s.done || !pickReady}'), true, '未確認完時整份名單都不可點');
assertEqual(APP.includes('正在確認本月哪些店已經點檢過'), true, '要告訴使用者在等什麼，不可只是不能點');

// ===== 2. 失敗不可靜音（原本 catch 是空的）=====
assertEqual(/\.catch\(e => setInspectedState\(\{ loaded: false, err: e\.message/.test(APP), true,
  '查詢失敗要記進狀態');
assertEqual(APP.includes('無法確認本月已點檢的店'), true, '失敗要顯示在畫面上');
assertEqual(APP.includes('onClick={() => loadInspected(workMonth)}'), true, '失敗要能重試');
// 失敗時「不開放選店」比「開放但可能重複」安全：重複點檢會浪費整份表與整批照片
assertEqual(APP.includes('為避免重複點檢，暫時不開放選店'), true, '失敗時維持不可選，並說明原因');
assertEqual(/const loadInspected[\s\S]{0,900}\.catch\(\(\) => \{ \}\)/.test(APP), false,
  'loadInspected 不可以再有空的 catch');

// ===== 3. 確認結果回來後要撤銷誤選 =====
assertEqual(/useEffect\(\(\) => \{\s*if \(!inspectedState\.loaded \|\| editingRecordId\) return;/.test(APP), true,
  '確認完才檢查目前選的店；編輯模式不檢查');
assertEqual(APP.includes('本月已有點檢紀錄，已為你取消選擇'), true, '要明講已取消選擇');
assertEqual(APP.includes("setBasic(b => ({ ...b, storeCode: '', customStore: '', customInfo: null }))"), true,
  '真的要把選擇清掉，不能只是提示');
assertEqual(APP.includes('請到「查詢紀錄」找到它按「編輯」'), true, '要指出正確的做法');

// ===== 4. 送出成功後清掉店鋪選擇 =====
//   否則剛送出的店馬上變成「已點檢」，會被自己的警告攔下來
assertEqual(/setBasic\(b => \(\{ \.\.\.b, storeCode: '', customStore: '', customInfo: null, storeType: ''/.test(APP), true,
  '送出後清掉店鋪與拍照類型（部別/課別/點檢人員保留，接著點下一家）');

// ===== 5. 點檢時間的時／分下拉 =====
assertEqual(/const HOURS = Array\.from\(\{ length: 24 \}/.test(APP), true, '時為 00~23');
assertEqual(/const MINUTES = Array\.from\(\{ length: 60 \}/.test(APP), true, '分為 00~59');
const m = /const setTimePart = \(which, v\) => \{[\s\S]*?\n      \};/.exec(APP);
assertEqual(!!m, true, '應能找到 setTimePart');
const sb = { basic: { time: '2026-08-25' }, out: null };
sb.setBasic = (o) => { sb.out = o; sb.basic = o; };
vm.createContext(sb);
vm.runInContext(m[0] + '; this.fn = setTimePart;', sb);
const setTimePart = sb.fn;
sb.basic = { time: '2026-08-25' };
setTimePart('h', '16');
assertEqual(sb.basic.time, '2026-08-25T16:00', '只選時：分先給 00（使用者看得到可再改）');
setTimePart('m', '27');
assertEqual(sb.basic.time, '2026-08-25T16:27', '再選分');
setTimePart('h', '09');
assertEqual(sb.basic.time, '2026-08-25T09:27', '改時不影響分');
setTimePart('h', '');
assertEqual(sb.basic.time, '2026-08-25', '選回「--時」＝清掉時間，回到必填未填狀態');
sb.basic = { time: '2026-08-25' };
setTimePart('m', '05');
assertEqual(sb.basic.time, '2026-08-25T00:05', '只選分：時先給 00');
// 送出時的必填檢查是看長度 > 10，上面每個結果都要能被它正確判斷
assertEqual('2026-08-25'.length <= 10, true, '沒選時間時長度為 10 → 會被必填檢查擋下');
assertEqual('2026-08-25T16:27'.length > 10, true, '選了時間就通過必填檢查');

// ===== 6. 查詢紀錄與彙總專區不再有「結果」欄，不及格分數改紅字 =====
assertEqual(APP.includes('<th>結果</th>'), false, '兩個表格都不再有「結果」欄');
assertEqual((APP.match(/r\.total < PASS_SCORE \? "text-red-600" : ""/g) || []).length, 2,
  '查詢紀錄與彙總專區各一處：不及格分數以粗體紅字呈現');
assertEqual(APP.includes('colSpan="6"'), true, '查詢紀錄少一欄，空狀態的 colSpan 要跟著改');
assertEqual(/<td className=\{"font-bold " \+ \(r\.total < PASS_SCORE/.test(APP), true, '分數本來就是粗體，只加紅色');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
