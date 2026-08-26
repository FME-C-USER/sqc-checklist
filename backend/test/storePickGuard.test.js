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
// 選店要等兩件事：門市名單（改為背景載入後才多這一項）與「本月已點檢」確認
assertEqual(APP.includes('const pickReady = (inspectedState.loaded && storesState.loaded) || !!editingRecordId;'), true,
  '選店的開關要同時綁名單與確認狀態（編輯既有紀錄例外，那時店鋪是固定的）');
assertEqual(APP.includes('正在載入本月店鋪名單'), true, '名單還沒到要說在載名單，不要說在確認已點檢');
assertEqual(APP.includes('店鋪名單載入失敗'), true, '名單載入失敗要單獨顯示並可重試');
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
assertEqual(/setBasic\(b => \(\{[\s\S]{0,300}\}\)\);\s*\n\s*setTimeParts\(\{ h: '', m: '' \}\);/.test(APP), true,
  '時分欄位的狀態也要清掉，否則下一家會顯示上一家的時分');
assertEqual(APP.includes('dept:') && !/\.\.\.b, time: b\.time\.slice\(0, 10\),[\s\S]{0,200}(dept|section|staffId): ''/.test(APP), true,
  '部別/課別/點檢人員不可清掉：同一個人接著點下一家店');
// 已點檢清單要向後端重查（別人同時送出的店，本機樂觀更新看不到）
assertEqual(/loadRecords\(\);\s*\n(\s*\/\/[^\n]*\n)*\s*loadInspected\(workMonth\);/.test(APP), true,
  '送出後要重查已點檢清單，不能只靠本機樂觀更新');
assertEqual(APP.includes('重新向後端取店鋪名單、人員與「本月已點檢」清單'), true,
  '要有隨時可按的「重新載入」：名單與人員只在開 App 時載入一次');

// ===== 5. 點檢時間：時與分各自獨立（使用者 2026-08-26 回報的兩個問題）=====
//   問題一：只填了「時」會被硬湊成 00 分
//   問題二：把「分」清掉會連帶把「時」也清掉
//   成因：basic.time 的格式（'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:mm'）沒有「有時、沒分」這個狀態。
//   對策：timeParts 保存使用者實際填的內容，兩邊都填了才組成 basic.time。
assertEqual(/const HOURS = Array\.from\(\{ length: 24 \}/.test(APP), true, '時為 00~23');
assertEqual(/const MINUTES = Array\.from\(\{ length: 60 \}/.test(APP), true, '分為 00~59');
assertEqual(APP.includes("const [timeParts, setTimeParts] = useState({ h: '', m: '' });"), true,
  '時與分要有各自的狀態');
assertEqual(APP.includes('const timeShown'), false, '舊的 timeShown 已被取代，不可留死碼');
assertEqual(APP.includes('setTimeRaw'), false, '舊的 timeRaw 已被取代，不可留死碼');
assertEqual(APP.includes('const setTimePart ='), false, '舊的 setTimePart 已被取代，不可留死碼');

const grabFn = (name, arg) => {
  const re = new RegExp('const ' + name + ' = \\(' + arg + '\\) => \\{[\\s\\S]*?\\n      \\};');
  const hit = re.exec(APP);
  if (!hit) throw new Error('找不到 ' + name);
  return hit[0];
};
const srcSync = grabFn('syncTime', 'parts, dateStr');
const srcText = grabFn('onTimeText', 'which, raw');
const srcBlur = grabFn('onTimeBlur', 'which');
const sb = {
  basic: { time: '2026-08-25' }, timeParts: { h: '', m: '' },
  String, Number, pad2: (n) => String(n).padStart(2, '0'),
};
sb.setBasic = (fn) => { sb.basic = typeof fn === 'function' ? fn(sb.basic) : fn; };
sb.setTimeParts = (o) => { sb.timeParts = o; };
vm.createContext(sb);
vm.runInContext(srcSync + '\n' + srcText + '\n' + srcBlur + '; this.api = { onTimeText, onTimeBlur };', sb);
const { onTimeText, onTimeBlur } = sb.api;
const state = () => [sb.timeParts.h, sb.timeParts.m, sb.basic.time];

// 只填「時」→ 不可幫「分」湊 00，而且時間尚未成立（必填檢查要擋下）
onTimeText('h', '16');
assertEqual(state(), ['16', '', '2026-08-25'], '只填時：分維持空白，basic.time 只有日期');
assertEqual(sb.basic.time.length <= 10, true, '只填一邊時必填檢查要擋下');
// 補上「分」才成立
onTimeText('m', '27');
assertEqual(state(), ['16', '27', '2026-08-25T16:27'], '兩邊都填才組成時間');
// 把「分」清掉：時必須留著（這就是現場回報的 bug）
onTimeText('m', '');
assertEqual(state(), ['16', '', '2026-08-25'], '清掉分不可連帶清掉時');
// 把「時」清掉：分留著
onTimeText('m', '27');
onTimeText('h', '');
assertEqual(state(), ['', '27', '2026-08-25'], '清掉時不可連帶清掉分');

// 打字途中不補零（打「16」的第一下若變成 01，第二下會成為 016）
sb.timeParts = { h: '', m: '' }; sb.basic = { time: '2026-08-25' };
onTimeText('h', '1');
assertEqual(sb.timeParts.h, '1', '打第一個字時顯示原字串');
onTimeText('h', '16');
assertEqual(sb.timeParts.h, '16', '打完第二個字');
// 離開欄位才補零，而且只補自己那一邊
sb.timeParts = { h: '9', m: '' }; sb.basic = { time: '2026-08-25' };
onTimeBlur('h');
assertEqual(state(), ['09', '', '2026-08-25'], '離開欄位補零；沒填的分維持空白');
onTimeText('m', '5');
onTimeBlur('m');
assertEqual(state(), ['09', '05', '2026-08-25T09:05'], '兩邊都補零後組成時間');
onTimeBlur('h');
assertEqual(state(), ['09', '05', '2026-08-25T09:05'], '已是兩位數時 blur 不改變任何東西');

// 超出範圍的那一鍵不接受
sb.timeParts = { h: '16', m: '27' }; sb.basic = { time: '2026-08-25T16:27' };
onTimeText('h', '25');
assertEqual(state(), ['16', '27', '2026-08-25T16:27'], '25 時不被接受（時上限 23）');
onTimeText('m', '60');
assertEqual(state(), ['16', '27', '2026-08-25T16:27'], '60 分不被接受（分上限 59）');
onTimeText('h', 'a9');
assertEqual(sb.timeParts.h, '9', '非數字被濾掉，只留數字');

// 紅框要標在「還沒填的那一邊」，使用者才知道少填哪個
assertEqual(APP.includes('(timeParts.h ? "border-slate-300" : "border-red-300 bg-red-50")'), true, '時欄位的紅框看自己有沒有填');
assertEqual(APP.includes('(timeParts.m ? "border-slate-300" : "border-red-300 bg-red-50")'), true, '分欄位的紅框看自己有沒有填');
// 進入編輯時要還原時分（否則畫面空白卻通得過必填檢查）
assertEqual(APP.includes("setTimeParts(t.length > 10 ? { h: t.slice(11, 13), m: t.slice(14, 16) } : { h: '', m: '' });"), true,
  '載回舊紀錄要還原時分欄位');
// 改日期不可影響已填的時分
assertEqual(APP.includes('onChange={e => syncTime(timeParts, e.target.value)}'), true, '改日期時沿用已填的時分');

// ===== 5b. 可打字的欄位＋datalist 清單（方案 C）=====
assertEqual(APP.includes('<datalist id="sqc-hours">') && APP.includes('<datalist id="sqc-minutes">'), true,
  '時/分要用 datalist（同時提供下拉與自行輸入）');
assertEqual((APP.match(/inputMode="numeric"/g) || []).length >= 2, true, '手機要跳數字鍵盤');
assertEqual(APP.includes('sqc-combo'), false, '不可有 sqc-combo（單位後綴與箭頭已移除，不留死碼）');
assertEqual((APP.match(/placeholder="時"/g) || []).length, 1, '時欄位用 placeholder 標示');
assertEqual((APP.match(/placeholder="分"/g) || []).length, 1, '分欄位用 placeholder 標示');
assertEqual(APP.includes('<datalist id="sqc-hours"><option value="" />'), true, '時的清單第一列是空白');
assertEqual(APP.includes('<datalist id="sqc-minutes"><option value="" />'), true, '分的清單第一列是空白');
assertEqual((APP.match(/w-16 px-2 py-2 border rounded-lg text-center tabular-nums/g) || []).length, 2,
  '兩個欄位都用同一組寬度與置中樣式');

// ===== 6. 查詢紀錄與彙總專區不再有「結果」欄，不及格分數改紅字 =====
assertEqual(APP.includes('<th>結果</th>'), false, '兩個表格都不再有「結果」欄');
assertEqual((APP.match(/r\.total < PASS_SCORE \? "text-red-600" : ""/g) || []).length, 2,
  '查詢紀錄與彙總專區各一處：不及格分數以粗體紅字呈現');
assertEqual(APP.includes('colSpan="6"'), true, '查詢紀錄少一欄，空狀態的 colSpan 要跟著改');
assertEqual(/<td className=\{"font-bold " \+ \(r\.total < PASS_SCORE/.test(APP), true, '分數本來就是粗體，只加紅色');

// ===== 7. 版本字串一律用台灣時間（使用者 2026-08-26 要求）=====
//   與部署關卡無關 —— 那道關卡看的是資安報告的檔名日期，而 GitHub runner 跑 UTC，兩者不可混用。
assertEqual(/const APP_VERSION = '202\d{5}-\d{4}'/.test(APP), true, '前端版本為 YYYYMMDD-HHMM 格式（台灣時間）');
assertEqual(APP.includes('台灣時間'), true, '版本欄位要在畫面上標明是台灣時間');
assertEqual(/前端版本（YYYYMMDD-HHMM，台灣時間）/.test(APP), true, '前端版本的說明要註明時區');
assertEqual(/後端版本（YYYYMMDD-HHMM，台灣時間）/.test(APP), true, '後端版本的說明要註明時區');
const GS = fs.readFileSync(path.join(__dirname, '..', '程式碼.gs'), 'utf8');
assertEqual(/var GAS_VERSION = '202\d{5}-\d{4}'/.test(GS), true, '後端版本同為 YYYYMMDD-HHMM 格式');
assertEqual(GS.includes('台灣時間'), true, '後端版本常數也要註明時區');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
