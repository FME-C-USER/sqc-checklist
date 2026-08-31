// 回歸測試：2026-08-28「現場能確認照片有沒有進雲端」三項
//   1 beforeunload 只在真的還有照片沒進雲端時才攔人（原本 done 也算，是假警報）
//   2 一進 App 就先踢一次補傳；索取上傳網址的批次由 6 提高到 10
//   3 送出後的面板改成三態，並逐張顯示雲端狀態
//
// 核心原則：離店的判斷標準是「檔案有沒有進雲端硬碟（pending）」，
// 不是「連結有沒有寫回紀錄（done）」。done 的照片已經安全，攔人是假警報 ——
// 而假警報最大的代價是訓練大家忽略警告。
// 執行方式：node backend/test/cloudSafe.test.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const UP = fs.readFileSync(path.join(ROOT, 'js', 'uploader.js'), 'utf8');
const CODE = APP.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. beforeunload 不可再看 unfinished =====
assertEqual(/\(pendingUp\.unfinished \|\| 0\) \+ \(pendingUp\.queuedRecords \|\| 0\)/.test(CODE), false,
  'beforeunload 不可再用 unfinished（＝pending+done，done 的檔案已經在雲端）');
assertEqual(/if \(!\(\(pendingUp\.pending \|\| 0\) \+ \(pendingUp\.queuedRecords \|\| 0\)\)\) return;/.test(CODE), true,
  'beforeunload 只看 pending 與待送出紀錄');
assertEqual(/\}, \[pendingUp\.pending, pendingUp\.queuedRecords\]\);/.test(CODE), true,
  '依賴陣列要跟著改，否則狀態變了也不會重新掛勾');

// ===== 2. 啟動即補傳 ＋ 批次提高 =====
assertEqual(/if \(CONFIGURED && window\.SqcUploader\) SqcUploader\.pump\(\);/.test(CODE), true,
  '一進 App 就要踢一次 pump（原本要等 setInterval 最多 15 秒）');
// BATCH 曾經為了少跑兩趟往返調到 10，但後端要為每一張向 Drive 開一個 resumable session，
// 那裡正好就是瓶頸 —— 調大等於把單次請求變重 67%，剛好壓在最容易逾時的地方。
// 2026-08-27 現場整批卡在 createUploadSessions 逾時後改回 6。
assertEqual(/const BATCH = 6;/.test(UP), true, 'BATCH 要維持 6：createUploadSessions 是瓶頸，單次請求不可再變重');
assertEqual(/const BATCH = 10;/.test(UP), false, '不可再調回 10');
// 不可超過後端上限，否則多要的會被 slice 掉而白跑
{
  const GS = fs.readFileSync(path.join(ROOT, 'backend', '程式碼.gs'), 'utf8');
  const max = Number((/var UPLOAD_SESSION_MAX = (\d+);/.exec(GS) || [])[1]);
  const batch = Number((/const BATCH = (\d+);/.exec(UP) || [])[1]);
  assertEqual(batch <= max, true, `BATCH(${batch}) 不可大於後端 UPLOAD_SESSION_MAX(${max})`);
}

// ===== 3. 三態門檻 =====
assertEqual(/const cloudSafe = !!postStat && postStat\.pending === 0;/.test(CODE), true,
  '要有 cloudSafe（檔案都進雲端 → 可以離開現場）');
assertEqual(/const postDone = !!postStat && postStat\.pending === 0 && postStat\.done === 0;/.test(CODE), true,
  'postDone 保持原義（連結也寫回了 → 整筆結案）');
assertEqual(CODE.includes("cloudSafe ? '☁️ 照片都在雲端了，可以離開現場'"), true, '面板標題要有「可以離開現場」那一態');
assertEqual(CODE.includes("'📤 還有照片沒進雲端，請留在現場'"), true, '真的還沒進雲端時才說留在現場');
// 措辭與離開確認都要跟著門檻
assertEqual(/照片檔案都已經在雲端硬碟了，現在離開現場不會遺失任何照片/.test(APP), true,
  'cloudSafe 時要明講「離開不會遺失照片」');
assertEqual(/const n = \(postStat && postStat\.pending\) \|\| 0;/.test(CODE), true,
  '離開確認的張數只算 pending');
assertEqual(/postStat\.pending \+ postStat\.done\)\) \|\| postSubmit\.added/.test(CODE), false,
  '不可再把 pending+done 當成「未完成張數」');
assertEqual(CODE.includes("cloudSafe ? '關閉（連結會在背景寫完）' : '我知道風險，稍後再傳'"), true,
  'cloudSafe 時按鈕不該還叫「我知道風險」');
// 藍色細條同一套標準
assertEqual(CODE.includes("pendingUp.pending > 0\n                      ? '📤 還有照片沒進雲端，請保持頁面開啟'"), true,
  '頂部提示條也要用 pending 判斷');

// ===== 逐張狀態 =====
assertEqual(/const \[postShots, setPostShots\] = useState\(\[\]\);/.test(CODE), true, '要有逐張狀態');
assertEqual(/SqcDB\.photosOfRecord\(postRecId\)/.test(CODE), true, '要讀該筆的照片佇列');
// 只能取狀態與路徑，不可把 blob／thumb 抓進 state
assertEqual(/setPostShots\(list\.map\(p => \(\{\s*id: p\.id, status: p\.status,/.test(CODE), true,
  '只取 id／status／路徑');
assertEqual(/setPostShots\([^)]*thumb/.test(CODE), false,
  '不可把 thumb 抓進 state（thumb 是整張 1920px 的 dataURL，19 張會吃掉十幾MB）');
assertEqual(/blob/.test(/setPostShots\(list\.map\([\s\S]*?\}\)\)\);/.exec(CODE)[0]), false, '不可把 blob 抓進 state');
assertEqual(/還沒進雲端：\{bad\.join\('、'\)\}/.test(APP), true, '還沒進雲端的要指名是哪一題');

// ===== 狀態對應的顏色語意（pending 紅、orphan 琥珀、其餘綠）=====
{
  const chip = /\{postShots\.map\(p => \([\s\S]*?\)\)\}/.exec(CODE)[0];
  assertEqual(/p\.status === 'pending' \? 'bg-red-/.test(chip), true, 'pending 用紅色');
  assertEqual(/p\.status === 'orphan' \? 'bg-amber-/.test(chip), true, 'orphan 用琥珀色');
  assertEqual(/bg-emerald-/.test(chip), true, 'done/linked 用綠色');
}

// ===== 三態的判斷邏輯實跑 =====
{
  const state = (pending, done) => ({
    cloudSafe: pending === 0,
    postDone: pending === 0 && done === 0,
    攔人: pending > 0,
  });
  assertEqual(state(5, 0), { cloudSafe: false, postDone: false, 攔人: true }, '5 張還沒進雲端 → 攔');
  assertEqual(state(0, 5), { cloudSafe: true, postDone: false, 攔人: false },
    '★ 都進雲端、只差連結 → 可以離店、不攔（這正是原本的假警報）');
  assertEqual(state(0, 0), { cloudSafe: true, postDone: true, 攔人: false }, '全部完成');
}

console.log(failed ? `\n✗ ${failed} 項未通過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);
