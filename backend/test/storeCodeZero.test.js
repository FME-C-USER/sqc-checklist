/**
 * 回歸測試：2026-09-03 現場「同一張照片在 Drive 上有 023661_… 和 23661_… 兩個名字」。
 *
 * 完整因果鏈（每一段都在程式碼裡確認過）：
 *   來源 xlsx 的店號是文字 '023661'
 *     → 匯入 店鋪名單_11509 有 setNumberFormat('@')，零保住了
 *       → 手機 STORE_ROSTER = '023661' → 新增點檢的檔名 023661_…（正確）
 *       → 送出時 程式碼.gs 的 appendRow 沒有鎖文字格式
 *         → Sheets 把 '023661' 轉成數字 23661，零掉了
 *           → 編輯時 rowToRecord 回傳 storeCode = 23661（數字）
 *             → app.html 的 inRoster 用嚴格字串比對，'023661' !== '23661' → 比對失敗
 *               → 落到 __custom，店號取自紀錄
 *                 → 重新上傳的檔名變成 23661_…
 *
 * 後果不只是檔名難看：
 *   1. Drive 多一份換了名字的檔案
 *   2. 後端「查同檔名就不重傳」這道防線失效 —— 名字不同，永遠查不到孿生檔
 *   3. 「照片連結修復」按 照片JSON 的檔名去找，找不到就報「Drive 沒有這個檔案」
 *
 * 本次修的是最上層的症狀（前端比對）。後端的 setNumberFormat 與既有資料的
 * 補零修復是另外兩步。
 *
 * ★ 這裡有一個容易踩的迴歸：
 *   光把 inRoster 改成 normCode 比對是不夠的。inRoster 命中後會把
 *   basic.storeCode 設進 state，而後面 store 是用「嚴格比對」再找一次
 *   （const store = STORE_ROSTER.find(s => s.code === basic.storeCode)）。
 *   如果存進去的是紀錄的 5 碼店號，那一次就會找不到 → store 是 undefined
 *   → effStore 也是 null（因為 inRoster 命中時 customInfo 被設成 null）
 *   → 編輯畫面會變成「請先在基本資料選擇店鋪」，整個編輯流程壞掉。
 *   所以命中之後要存「名單的店號」，不是紀錄的店號。
 *
 * 執行方式：node backend/test/storeCodeZero.test.js
 */
const fs = require('fs');
const path = require('path');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const GS = fs.readFileSync(path.join(ROOT, 'backend', '程式碼.gs'), 'utf8');
// 只去掉整行註解與 JSX 註解：一般的 // 規則會把 https:// 一起吃掉
const CODE = APP.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

/**
 * 抽出 app.html 裡真正的 normCode 實作來測 —— 不自己重寫一份，
 * 否則測的是我對它的印象，不是它的行為。
 */
const ncSrc = APP.match(/function normCode\(c\) \{[\s\S]*?\}\n/);
assertEqual(!!ncSrc, true, '前提：app.html 裡找得到 normCode');
const normCode = new Function(ncSrc[0] + '; return normCode;')();

// ===== 1. normCode 真的能把兩種形式統一 =====
assertEqual(normCode('023661'), '23661', 'normCode 去掉前導零');
assertEqual(normCode(23661), '23661', 'normCode 吃得下數字（Sheet 回傳的就是數字）');
assertEqual(normCode('023661') === normCode(23661), true,
  '★ 這就是統一的依據：名單的 023661 與紀錄的 23661 要被視為同一家店');
assertEqual(normCode('0'), '0', '單獨一個 0 不可被吃掉');
assertEqual(normCode(''), '', '空值不可爆掉');
assertEqual(normCode(null), '', 'null 不可爆掉');

/**
 * ===== 2. ★ 編輯路徑：用真正的原始碼跑一次 =====
 * 把 app.html 裡那兩行原封不動抽出來執行，餵現場的資料形狀：
 * 名單是文字 '023661'（正確），紀錄是數字 23661（被 Sheet 轉掉的）。
 */
{
  // 檔案裡有多個 inRoster，要抓的是「拿紀錄去比名單」那一個（回填編輯畫面用的）。
  // 另一處 1963 行的 `normCode(x.code) === code` 早就用了正規化 —— 正確的寫法
  // 本來就在這個檔案裡，2039 是唯一的例外。
  const mFind = CODE.match(/const inRoster = STORE_ROSTER\.find\((s => [^;]*rec\.storeCode[^;]*)\);/);
  assertEqual(!!mFind, true, '前提：找得到「拿紀錄比名單」的 inRoster 那一行');
  const mPick = CODE.match(/storeCode: inRoster \? ([^:]+?) : '__custom',/);
  assertEqual(!!mPick, true, '前提：找得到 storeCode 指定那一行');

  const run = new Function('STORE_ROSTER', 'rec', 'normCode', `
    const inRoster = STORE_ROSTER.find(${mFind[1]});
    return { hit: !!inRoster, storeCode: inRoster ? ${mPick[1]} : '__custom' };
  `);

  const ROSTER = [{ code: '023661', name: '關廟旺萊店' }, { code: '016950', name: '高雄新豐店' }];
  const out = run(ROSTER, { storeCode: 23661, storeName: '關廟旺萊店' }, normCode);

  assertEqual(out.hit, true,
    '★ 紀錄是 23661、名單是 023661 時必須認得出來 —— 認不出來就會落到 __custom 而換掉檔名');
  assertEqual(out.storeCode, '023661',
    '★ 命中後要存「名單的店號」（6 碼），不是紀錄的 5 碼 —— 見檔頭的迴歸說明');

  // 真的是自訂店（不在名單裡）時，仍然要落到 __custom
  const custom = run(ROSTER, { storeCode: '099999', storeName: '測試自訂店' }, normCode);
  assertEqual(custom.storeCode, '__custom', '不在名單裡的店仍要走自訂店路徑');
}

/**
 * ===== 3. ★ 迴歸防護：store 那一次嚴格比對必須跟著成立 =====
 * inRoster 命中時 customInfo 會是 null，所以 effStore 只剩 store 一個來源。
 * store 找不到 → effStore 為 null → 編輯畫面直接被「請先選擇店鋪」擋住。
 */
{
  const mStore = CODE.match(/const store = STORE_ROSTER\.find\((.*?)\);/);
  assertEqual(!!mStore, true, '前提：找得到 store 那一行');
  const run = new Function('STORE_ROSTER', 'basic', `
    const store = STORE_ROSTER.find(${mStore[1]});
    return !!store;
  `);
  const ROSTER = [{ code: '023661', name: '關廟旺萊店' }];
  assertEqual(run(ROSTER, { storeCode: '023661' }), true,
    '★ 存進 basic.storeCode 的值要能讓 store 也找得到（否則編輯畫面會說「請先選擇店鋪」）');
  assertEqual(run(ROSTER, { storeCode: '23661' }), false,
    '前提：存 5 碼進去就會找不到 —— 這正是不可以存紀錄店號的原因');
}

// ===== 4. ★ 檔名必須用名單的店號 =====
{
  const mName = CODE.match(/const name = `\$\{(.*?)\}_\$\{basic\.time/);
  assertEqual(!!mName, true, '前提：找得到檔名組裝那一行');
  const run = new Function('storeCode', `return \`\${${mName[1]}}_x.jpg\`;`);
  assertEqual(run('023661'), '023661_x.jpg', '★ 檔名前綴就是 storeCode，所以 storeCode 錯檔名就錯');
}

// ===== 5. 原始碼層面：舊的嚴格比對不可再出現 =====
assertEqual(/String\(s\.code\) === String\(rec\.storeCode\)/.test(CODE), false,
  '★ 不可再用嚴格字串比對名單與紀錄的店號');
assertEqual(/storeCode: inRoster \? rec\.storeCode : '__custom',/.test(CODE), false,
  '★ 不可再把紀錄的店號存進 basic.storeCode');
// 前提：確認上面兩條不是因為抓錯字串而假通過
assertEqual(/const inRoster = STORE_ROSTER\.find/.test(CODE), true,
  '前提：inRoster 這一行還在（不是整段被刪掉才通過的）');

/**
 * ===== 6. 記錄下游還沒修的兩步 =====
 * 這兩條刻意固定住「壞的現況」，修好之後它們會失敗 —— 那時請更新。
 */
assertEqual(/sh\.appendRow\(row\);/.test(GS), true,
  '待修（後端）：submitRecord 仍用 appendRow，沒有先 setNumberFormat(\'@\') → 店號與員編會被轉成數字掉前導零');
assertEqual(/storeCode: r\['店號'\],/.test(GS), true,
  '待修（後端）：rowToRecord 直接回傳儲存格，型別可能是數字 —— 應加 String()');

console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
process.exit(failed ? 1 : 0);
