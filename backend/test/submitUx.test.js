// 回歸測試：2026-08-28 的四項 UX 改動
//   1 送出被必填擋下時要跳到出問題的地方並閃紅框（原本點檢作業頁只有 alert，不捲動）
//   2 自行新增店鋪：不在本月名單內不可點檢；已點檢擋下；跨課放行但告知
//   3 廁所觀察題的選項按鈕放大、窄螢幕改上下兩行
//   4 不可拍照店鋪的報表備註自動註記「無法拍照」
// 執行方式：node backend/test/submitUx.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
// 註解裡會提到舊寫法，掃程式碼時先剝掉
const CODE = APP.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. 送出跳轉 =====
assertEqual(/const jumpTo = \(id, msg, toTab\) => \{/.test(CODE), true, '要有 jumpTo');
// 點檢作業頁的必填檢查不可再只有 alert 就 return
const submitBlock = /const doSubmit = async \(\) => \{[\s\S]*?\n        const observation = /.exec(CODE)[0];
const bareAlerts = (submitBlock.match(/alert\(/g) || []).length;
assertEqual(bareAlerts, 2, '送出檢查裡只剩「題庫載入中」「題庫為空」兩個純 alert（那兩個沒有可跳的目標），實際 ' + bareAlerts);
[
  ["jumpTo('sign-count'", '在店店員人數'],
  ["jumpTo('sign-identity'", '簽名身分別'],
  ["jumpTo('paper-form'", '紙本點檢表'],
  ['jumpTo(`toilet-${o.id}`', '廁所觀察必填'],
  ['jumpTo(`toilet-${t.id}`', '廁所觀察符合/不符合'],
  ['jumpTo(`toilet-reasons-${t.id}`', '廁所不合格項目'],
  ['jumpTo(`keyobs-${k.id}`', '重點觀察題'],
  ['jumpTo(`perfect-${z}`', '滿分照片區'],
  ['jumpTo(`item-${it.id}`', '缺失照片張數'],
  ["jumpTo('basic-time'", '點檢時間'],
  ["jumpTo('basic-store'", '店鋪'],
  ["jumpTo('basic-phototype'", '可否拍照'],
  ["jumpTo('basic-staff'", '點檢人員'],
].forEach(([needle, what]) => assertEqual(CODE.includes(needle), true, `${what} 要能跳轉`));

// 對應的 id 與閃框 class 都要真的掛在畫面上
['basic-time', 'basic-store', 'basic-phototype', 'basic-staff', 'sign-count', 'sign-identity', 'paper-form']
  .forEach(id => assertEqual(CODE.includes(`id="${id}"`) && CODE.includes(`flashCls('${id}')`), true, `${id} 要有 id 與 flashCls`));
['toilet-${o.id}', 'toilet-${t.id}', 'toilet-reasons-${t.id}', 'keyobs-${k.id}', 'perfect-${z}']
  .forEach(t => assertEqual(CODE.includes('id={`' + t + '`}') && CODE.includes('flashCls(`' + t + '`)'), true, `${t} 要有 id 與 flashCls`));
assertEqual(CODE.includes('id={`item-${item.id}`}') && CODE.includes('flash={flashCls(`item-${it.id}`)}'), true,
  'ItemRow 要有 id 並接收 flash');

// 捲動不可只靠 behavior:'smooth'：它由 rAF 驅動，頁面不可見時完全不會前進（實測 scrollY 停在 0）
assertEqual(/behavior: smooth \? 'smooth' : 'auto'/.test(CODE), true, '不可見或 reduced-motion 時要改用直接捲動');
assertEqual(/document\.visibilityState === 'visible'/.test(CODE), true, '要檢查頁面可見性');
assertEqual(/prefers-reduced-motion: reduce/.test(CODE), true, '要尊重「減少動態效果」');
// keyframes 要定義在 <style>（module scope），不可放在條件式渲染的區塊裡
assertEqual(/@keyframes sqc-flash \{/.test(APP.slice(0, APP.indexOf('</style>'))), true,
  'sqc-flash 的 keyframes 要定義在 <style> 內');

// ===== 2. 自行新增店鋪的檢查 =====
assertEqual(/const acceptCustomStore = \(s\) => \{/.test(CODE), true, '要有 acceptCustomStore');
assertEqual(/if \(!pickReady\) \{ alert\('本月店鋪名單還在載入中/.test(CODE), true,
  '名單還沒載完不可放行（否則又把「空窗期選到已點檢店」的競態搬回來）');
assertEqual(/const inRoster = STORE_ROSTER\.find\(x => normCode\(x\.code\) === code\);/.test(CODE), true,
  '要比對本月名單');
assertEqual(/不在本月（\$\{monthFolderOf\(workMonth\)\}）的店鋪名單內，不可點檢/.test(CODE), true,
  '名單外要明確擋下');
// 2026-09-04 起改用 isInspected（店號或店名任一命中）—— 門市會重新編號，
// 只比店號的話改號後那家店會重新變成可點檢而被重複點檢。
assertEqual(/if \(isInspected\(code, inRoster\.name\)\) \{/.test(CODE), true, '已點檢要當場擋下，不必等到送出');
assertEqual(/if \(inspectedCodes\[code\]\) \{/.test(CODE), false, '不可再只比店號');
assertEqual(/inRoster\.section !== basic\.section/.test(CODE), true, '跨課要告知（這是本功能的主要用途）');
assertEqual(/customInfo: \{ \.\.\.s, \.\.\.inRoster \}/.test(CODE), true, '要用名單裡那一筆（帶課別與店鋪型態）');
// 兩個入口都要走同一支
assertEqual(CODE.includes('if (exact.length === 1) acceptCustomStore(exact[0]);'), true, '精準命中要走 acceptCustomStore');
assertEqual(CODE.includes('onClick={() => acceptCustomStore(s)}'), true, '從搜尋結果點選也要走 acceptCustomStore');
assertEqual(/customInfo: exact\[0\]/.test(CODE), false, '不可再直接把主檔那筆設為已選');
// 編輯舊紀錄不可被這道檢查擋住（名單可能已經改過）
assertEqual(/customInfo: inRoster \? null : \{ code: rec\.storeCode/.test(CODE), true,
  '編輯既有紀錄仍直接帶入，不經過 acceptCustomStore');
// 按鈕文字不可再說「名單外」
assertEqual(/自行新增店鋪（名單外）/.test(APP), false, '按鈕文字不可再暗示可以點名單外的店');
assertEqual(/不在本月名單內的店不可點檢/.test(APP), true, '畫面上要寫清楚規則');

// ===== 3. 廁所觀察題的按鈕尺寸 =====
assertEqual(/"px-3 py-1 text-xs rounded border " \+ \(toilet\[o\.id\] === v/.test(CODE), false, '有無按鈕不可再是 py-1 text-xs');
assertEqual(/"px-5 py-2\.5 text-sm rounded-lg border " \+ \(toilet\[o\.id\] === v/.test(CODE), true, '有無按鈕要放大（實測 55x41）');
assertEqual(/"px-5 py-2\.5 text-sm rounded-lg border " \+ \(toilet\[t\.id\] === v/.test(CODE), true, '符合/不符合按鈕要放大（實測 69x41）');
assertEqual(/"text-sm px-3 py-2 rounded-full border "/.test(CODE), true, '不合格項目按鈕要放大（實測 53x37）');
assertEqual(/flex flex-col sm:flex-row sm:items-center sm:justify-between/.test(CODE), true,
  '窄螢幕要改成上下兩行（題目長時按鈕會被壓窄）');

// ===== 4. 報表備註自動註記「無法拍照」 =====
{
  const src = /const noteCell = \(r\) => [\s\S]*?;\n/.exec(APP)[0];
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(src + 'this.noteCell = noteCell;', ctx);
  assertEqual(ctx.noteCell({ 拍照類型: '不可拍照', 備註: '廠區店' }), '無法拍照｜廠區店', '不可拍照＋有原因');
  assertEqual(ctx.noteCell({ 拍照類型: '不可拍照', 備註: '' }), '無法拍照', '不可拍照但備註空白');
  assertEqual(ctx.noteCell({ 拍照類型: '不可拍照', 備註: '廠區店｜備註：熱狗機報修' }), '無法拍照｜廠區店｜備註：熱狗機報修',
    '不可拍照＋原因＋使用者備註');
  assertEqual(ctx.noteCell({ 拍照類型: '可拍照', 備註: '｜備註：蕃薯機調理中' }), '｜備註：蕃薯機調理中', '可拍照店不加註');
  assertEqual(ctx.noteCell({ 拍照類型: '可拍照', 備註: '' }), '', '可拍照且無備註 → 空字串');
  assertEqual(ctx.noteCell({ 備註: undefined }), '', '舊資料沒有拍照類型也不可變成 undefined');
}
assertEqual(CODE.includes('noteCell(r), joinLinks((r.photoGroups || {})[\'SQC點檢表完成照片\'])'), true,
  '產表要用 noteCell 而不是直接 r.備註');
assertEqual(/'備註\(例：廠區店無法拍照\)'/.test(CODE), true, '欄位標題保持原樣（本來就是這個意思）');

console.log(failed ? `\n✗ ${failed} 項未通過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);
