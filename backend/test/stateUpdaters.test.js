// 回歸測試：會與非同步流程交錯的 setState 一律用「更新函式」，不可展開 render 快照
//
// 起因（2026-08-28）：PhotoUpload 的 handleFile 是 async —— 每張照片壓縮幾百毫秒、
// 最多 10 張。A 項目還在壓縮時去點 B 項目，B 拿到的是「還沒有 A 的照片」那份快照，
// 後完成的那次 onChange 就會把 A 的照片整包蓋掉。滿分照片區有 8 區、每區 10 張，
// 是最容易踩到的地方。症狀會是「明明傳了某一區，送出卻說那一區必須上傳照片」。
//
// 純點擊觸發的那些（setFilter／setSign／setEditing…）風險極低：真人一次點一個，
// 而瀏覽器把每次點擊當獨立任務派送，React 對 discrete event 會在事件結束前套用更新。
// 所以這支測試只鎖「會跟非同步流程交錯」的那幾個，不為了整齊去改二十幾處。
// 執行方式：node backend/test/stateUpdaters.test.js
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
const CODE = APP.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 照片的三個 map：由 async 的 handleFile 觸發，必須用 updater =====
[
  ['setKeyObs', 'keyObs', '重點觀察題'],
  ['setToiletPhotos', 'toiletPhotos', '廁所缺失照片'],
  ['setPerfectPhotos', 'perfectPhotos', '滿分照片區'],
].forEach(([setter, stateName, what]) => {
  assertEqual(new RegExp(setter + '\\(\\{ \\.\\.\\.' + stateName).test(CODE), false,
    `${what}（${setter}）不可展開 render 快照`);
  assertEqual(new RegExp(setter + '\\(prev => \\(\\{ \\.\\.\\.prev').test(CODE), true,
    `${what}（${setter}）要用 updater`);
});

// ===== 廁所選項／不合格項目：風險低，但既然在改就一起 =====
assertEqual(/setToilet\(\{ \.\.\.toilet/.test(CODE), false, 'setToilet 不可展開快照');
assertEqual((CODE.match(/setToilet\(prev => \(\{ \.\.\.prev/g) || []).length >= 2, true, 'setToilet 兩處都要用 updater');
assertEqual(/setToiletReasons\(\{ \.\.\.toiletReasons/.test(CODE), false, 'setToiletReasons 不可展開快照');
assertEqual(/setToiletReasons\(prev => \{/.test(CODE), true, 'setToiletReasons 要用 updater');
// 切換邏輯要改讀 prev，不可還在讀外層的 on／toiletReasons
assertEqual(/const cur = prev\[t\.id\] \|\| \[\];/.test(CODE), true, '不合格項目的切換要以 prev 為準');

// ===== ItemRow：兩層都要用 prev =====
assertEqual(/setState\(\{ \.\.\.s/.test(CODE), false, 'ItemRow 內不可再展開 s');
assertEqual(/const patch = \(fn\) => setState\(fn\);/.test(CODE), true, 'ItemRow 要有 patch(fn)');
assertEqual((CODE.match(/patch\(p =>/g) || []).length, 5,
  'toggleSub／setCustomName／合格／缺失／缺失照片 五處都要走 patch，實際 '
  + (CODE.match(/patch\(p =>/g) || []).length);
assertEqual(/const setItemState = \(id, fn\) => setScores\(prev => \(\{ \.\.\.prev, \[id\]: fn\(prev\[id\] \|\| \{\}\) \}\)\);/.test(CODE), true,
  '外層 map 與單一題目內容兩層都要用 prev');
// toggleSub 的清空邏輯也要讀 prev，否則會用舊的 customNames 判斷
assertEqual(/if \(on && p\.customNames && p\.customNames\[lbl\] != null\)/.test(CODE), true,
  'toggleSub 的「取消勾選就清掉名稱」要以 prev 判斷');

// ===== acceptCustomStore：在 await lookupStore() 之後才 setBasic =====
assertEqual(/setBasic\(prev => \(\{ \.\.\.prev, customInfo: \{ \.\.\.s, \.\.\.inRoster \}/.test(CODE), true,
  '查主檔是一次網路往返，回來後不可用等待前的 basic 快照覆蓋');

// ===== 已經安全的不要被改壞 =====
assertEqual(/setRemovedPhotos\(prev => \[\.\.\.prev/.test(CODE), true, 'setRemovedPhotos 本來就是 updater，要保持');
assertEqual(/onChange=\{setPaperForm\}/.test(CODE), true, '紙本是直接傳 setter（沒有 spread），保持原樣');

// ===== 模擬「A 壓縮中、B 完成」的交錯，確認 updater 真的救得回來 =====
{
  // 舊寫法：兩次都展開同一份快照
  const snapshot = { };
  let stateOld = { ...snapshot };
  const oldWay = (map, key, val) => ({ ...map, [key]: val });
  // A 與 B 都拿到 render 當下的空 map
  stateOld = oldWay(snapshot, 'A', ['a1']);      // A 先完成
  stateOld = oldWay(snapshot, 'B', ['b1']);      // B 用「同一份」舊快照完成
  assertEqual(Object.keys(stateOld).sort(), ['B'], '舊寫法：A 的照片被 B 蓋掉（重現問題）');

  // 新寫法：兩次都以「當下的 prev」為基礎
  let stateNew = {};
  const apply = (fn) => { stateNew = fn(stateNew); };
  apply(prev => ({ ...prev, A: ['a1'] }));
  apply(prev => ({ ...prev, B: ['b1'] }));
  assertEqual(Object.keys(stateNew).sort(), ['A', 'B'], 'updater：兩者都留下');
}

console.log(failed ? `\n✗ ${failed} 項未通過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);
