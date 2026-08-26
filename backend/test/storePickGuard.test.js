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

// ===== 4. 送出成功後為下一家店重設基本資料 =====
assertEqual(/\.\.\.b, time: b\.time\.slice\(0, 10\),\s*\n\s*storeCode: '', customStore: '', customInfo: null, storeType: ''/.test(APP), true,
  '送出後清掉店鋪與拍照類型，時間只留日期（時分必須重填，否則會沿用上一家的時間）');
assertEqual(/setBasic\(b => \(\{[\s\S]{0,200}\}\)\);\s*\n\s*setTimeRaw\(null\);/.test(APP), true,
  '打字暫存也要清掉，否則下一家會顯示上一家的時分');
assertEqual(APP.includes('dept:') && !/\.\.\.b, time: b\.time\.slice\(0, 10\),[\s\S]{0,200}(dept|section|staffId): ''/.test(APP), true,
  '部別/課別/點檢人員不可清掉：同一個人接著點下一家店');
// 已點檢清單要向後端重查（別人同時送出的店，本機樂觀更新看不到）
assertEqual(/loadRecords\(\);\s*\n(\s*\/\/[^\n]*\n)*\s*loadInspected\(workMonth\);/.test(APP), true,
  '送出後要重查已點檢清單，不能只靠本機樂觀更新');
assertEqual(APP.includes('重新向後端取店鋪名單、人員與「本月已點檢」清單'), true,
  '要有隨時可按的「重新載入」：名單與人員只在開 App 時載入一次');

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

// ===== 5b. 可打字的欄位＋datalist 清單（使用者 2026-08-26 改回方案 C）=====
assertEqual(APP.includes('<datalist id="sqc-hours">') && APP.includes('<datalist id="sqc-minutes">'), true,
  '時/分要用 datalist（同時提供下拉與自行輸入）');
assertEqual((APP.match(/inputMode="numeric"/g) || []).length >= 2, true, '手機要跳數字鍵盤');
// 使用者 2026-08-26 選定：單純的可輸入欄位（方案 C），不加單位後綴與自畫的箭頭 ——
// 後綴會佔掉右側寬度，且在 iPhone 上的手感與原生下拉選單不同，反而更容易誤會。
assertEqual(APP.includes('sqc-combo'), false, '不可再有 sqc-combo（含 CSS 也要一併移除，不留死碼）');
assertEqual(APP.includes('sqc-unit') || APP.includes('sqc-chev'), false, '不可再有單位後綴與箭頭');
assertEqual((APP.match(/placeholder="時"/g) || []).length, 1, '時欄位用 placeholder 標示');
assertEqual((APP.match(/placeholder="分"/g) || []).length, 1, '分欄位用 placeholder 標示');
// 清單第一列是空白＝可以把時間清掉（使用者要的「空白欄」，方案 C 也保留）
assertEqual(APP.includes('<datalist id="sqc-hours"><option value="" />'), true, '時的清單第一列是空白');
assertEqual(APP.includes('<datalist id="sqc-minutes"><option value="" />'), true, '分的清單第一列是空白');
// 沒有後綴佔位，w-16 的內容區足夠容納兩位數字（實測 D 案的 4.6rem 會把「16」裁成「1」）
assertEqual((APP.match(/w-16 px-2 py-2 border rounded-lg text-center tabular-nums/g) || []).length, 2,
  '兩個欄位都用同一組寬度與置中樣式');

const t = /const onTimeText = \(which, raw\) => \{[\s\S]*?\n      \};/.exec(APP);
const sh = /const timeShown = \(which\) => \{[\s\S]*?\n      \};/.exec(APP);
assertEqual(!!t && !!sh, true, '應能找到 onTimeText 與 timeShown');
const sb3 = { basic: { time: '2026-08-25' }, timeRaw: null, String, Number, pad2: (n) => String(n).padStart(2, '0') };
sb3.setBasic = (o) => { sb3.basic = o; };
sb3.setTimeRaw = (o) => { sb3.timeRaw = o; };
vm.createContext(sb3);
vm.runInContext(m[0] + '\n' + t[0] + '\n' + sh[0] + '; this.api = { onTimeText, timeShown };', sb3);
const { onTimeText, timeShown } = sb3.api;
// 逐鍵輸入「16」：第一下不可以被補零成 01，否則第二下會變成 016 而打不出來
onTimeText('h', '1');
assertEqual([timeShown('h'), sb3.basic.time], ['1', '2026-08-25T01:00'], '打第一個字時顯示原字串（時間先暫定 01）');
onTimeText('h', '16');
assertEqual([timeShown('h'), sb3.basic.time], ['16', '2026-08-25T16:00'], '打完第二個字才是想要的 16 時');
sb3.setTimeRaw(null);   // 離開欄位
assertEqual(timeShown('h'), '16', '離開欄位後顯示補零後的值');
onTimeText('m', '7');
assertEqual(sb3.basic.time, '2026-08-25T16:07', '分只打一位要補零成 07');
sb3.setTimeRaw(null);
assertEqual(timeShown('m'), '07', '顯示 07');
// 超出範圍的一鍵要被擋掉，不可讓時間變成 25 時
const before = sb3.basic.time;
onTimeText('h', '25');
assertEqual(sb3.basic.time, before, '25 時不可被接受（時上限 23）');
onTimeText('m', '60');
assertEqual(sb3.basic.time, before, '60 分不可被接受（分上限 59）');
onTimeText('h', 'a9');
assertEqual(sb3.basic.time, '2026-08-25T09:07', '非數字要被濾掉，只留數字');
onTimeText('h', '');
assertEqual(sb3.basic.time, '2026-08-25', '清空＝回到必填未填狀態');

// ===== 6. 查詢紀錄與彙總專區不再有「結果」欄，不及格分數改紅字 =====
assertEqual(APP.includes('<th>結果</th>'), false, '兩個表格都不再有「結果」欄');
assertEqual((APP.match(/r\.total < PASS_SCORE \? "text-red-600" : ""/g) || []).length, 2,
  '查詢紀錄與彙總專區各一處：不及格分數以粗體紅字呈現');
assertEqual(APP.includes('colSpan="6"'), true, '查詢紀錄少一欄，空狀態的 colSpan 要跟著改');
assertEqual(/<td className=\{"font-bold " \+ \(r\.total < PASS_SCORE/.test(APP), true, '分數本來就是粗體，只加紅色');

// ===== 7. 版本字串一律用台灣時間（使用者 2026-08-26 要求）=====
//   與部署關卡無關 —— 那道關卡看的是資安報告的檔名日期，而 GitHub runner 跑 UTC，兩者不可混用。
assertEqual(/const APP_VERSION = '20260826-1213'/.test(APP), true, '前端版本為台灣時間的標籤');
assertEqual(APP.includes('台灣時間'), true, '版本欄位要在畫面上標明是台灣時間');
assertEqual(/前端版本（YYYYMMDD-HHMM，台灣時間）/.test(APP), true, '前端版本的說明要註明時區');
assertEqual(/後端版本（YYYYMMDD-HHMM，台灣時間）/.test(APP), true, '後端版本的說明要註明時區');
const GS = fs.readFileSync(path.join(__dirname, '..', '程式碼.gs'), 'utf8');
assertEqual(/var GAS_VERSION = '20260826-1213'/.test(GS), true, '後端版本同步');
assertEqual(GS.includes('台灣時間'), true, '後端版本常數也要註明時區');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
