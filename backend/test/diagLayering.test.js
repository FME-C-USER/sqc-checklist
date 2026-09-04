/**
 * 回歸測試：2026-09-03 現場反映「關閉沒有用、關不掉」，以及
 * 「明明照片已經在雲端，App 卻說還沒進雲端」。
 *
 * 一、兩個彈窗相撞（看起來像「關閉關不掉」）
 *   上傳診斷與「送出後的上傳進度面板」都是 fixed inset-0，原本兩個同為 z-50，
 *   而面板在 DOM 裡比較後面 —— 同層時 CSS 依 DOM 順序疊，面板永遠蓋在診斷上面。
 *   而「查看原因」那顆按鈕就長在面板裡，於是實際發生的是：
 *     按「查看原因」→ 診斷確實開了，但被面板整片蓋住，畫面看起來毫無反應
 *     → 去按面板的「關閉」→ 面板消失，底下的診斷突然浮出來
 *     → 看起來像關不掉，其實是關掉一個、露出另一個。
 *
 *   附帶問題：診斷的「關閉」原本不在最下面 —— 下面還有兩顆清理按鈕。
 *   42 張照片的佇列滑到底，最後看到的是「🗑 清空整個佇列（會遺失照片）」。
 *   把破壞性最強的按鈕擺在畫面終點是不對的。
 *
 * 二、「還沒進雲端」是在斷言一件手機無法驗證的事
 *   那一行讀的是 p.status，而 status 要靠 IndexedDB 寫入才會前進。
 *   檔案已經 PUT 成功、狀態卻寫不回去時，它仍然是 pending ——
 *   於是畫面說「還沒進雲端」，而 Drive 上那個檔案明明就在。
 *
 *   ★ 只改逐張的診斷標籤。其他寫著「還沒進雲端」的地方刻意不改：
 *     那些是「刪掉會永久遺失」的警告，在那裡保守（假設真的還沒上去）才是對的。
 *
 * 執行方式：node backend/test/diagLayering.test.js
 */
const fs = require('fs');
const path = require('path');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
/**
 * 只移除 /* *\/ 區塊與整行 // 註解。
 * 不要用 /\{\s*\/\*[\s\S]*?\*\/\s*\}/ 想一次抓 JSX 註解 —— 非貪婪比對接不上 }
 * 時會回溯去找下一個 *\/}，於是從某個 `=> {` 一路吃掉幾千行（2026-09-04 踩過）。
 * 也不要順手清掉殘留的空 { }：有測試會把去註解後的原始碼實際執行。
 */
const CODE = APP.replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');

// ===== 1. ★ 兩個彈窗不可以同層 =====
const diagZ = /\{diag && \(\s*\n\s*<div className="fixed inset-0 (z-\[?\d+\]?)/.exec(CODE);
const panelZ = /\{postSubmit && \(\s*\n\s*<div className="fixed inset-0 (z-\[?\d+\]?)/.exec(CODE);
assertEqual(!!diagZ, true, '前提：找得到診斷彈窗的層級');
assertEqual(!!panelZ, true, '前提：找得到送出面板的層級');
assertEqual(diagZ[1], 'z-[60]', '★ 診斷要在上層（否則被面板蓋住，「查看原因」看起來沒反應）');
assertEqual(panelZ[1], 'z-50', '面板維持 z-50');
assertEqual(diagZ[1] === panelZ[1], false,
  '★ 兩者絕對不可以同層 —— 同層時依 DOM 順序疊，而面板在後面，必定蓋住診斷');
// 前提：確認診斷真的在 DOM 裡比面板前面（所以同層時會輸）
assertEqual(CODE.indexOf('{diag && (') < CODE.indexOf('{postSubmit && ('), true,
  '前提：診斷在 DOM 裡比面板前面 —— 這正是同層會被蓋住的原因');

// ===== 1b. ★ 「關閉」必須是診斷彈窗的最後一個按鈕 =====
{
  const start = CODE.indexOf('{diag && (');
  const end = CODE.indexOf('{postSubmit && (');
  const block = CODE.slice(start, end);
  const iPurgeAll = block.indexOf("purgeQueue('all')");
  const iClose = block.lastIndexOf('setDiag(null)');
  assertEqual(iPurgeAll > 0 && iClose > 0, true, '前提：兩顆按鈕都在診斷彈窗裡');
  assertEqual(iClose > iPurgeAll, true,
    '★ 「關閉」要排在「清空整個佇列」之後 —— 破壞性最強的按鈕不可以是畫面終點');
}

// ===== 2. ★ 診斷標籤不可以斷言雲端狀態 =====
assertEqual(/p\.stalled \? '一直傳不上去' : '尚未確認進雲端'/.test(CODE), true,
  '★ 逐張標籤改成「尚未確認進雲端」—— 它讀的是本機紀錄，不是問過 Drive');
assertEqual(/p\.status === 'pending' \? \(p\.stalled \? '一直傳不上去' : '還沒進雲端'\)/.test(CODE), false,
  '★ 逐張標籤不可再寫「還沒進雲端」');
assertEqual(/不是去問雲端/.test(APP), true,
  '★ 診斷抬頭要說清楚這些狀態的來源，否則使用者仍會把它讀成雲端的事實');

/**
 * ★ 其他地方刻意保留「還沒進雲端」—— 這幾條是防止我日後「順手統一措辭」而改壞。
 * 那些是刪除前的遺失警告：本機說 pending 就刪掉，確實可能真的丟，
 * 所以在那裡假設「還沒上去」才是安全的。
 */
assertEqual(/⚠ ' \+ lost \+ ' 張還沒進雲端的照片會永久遺失/.test(CODE), true,
  '清空佇列的確認訊息要保留「還沒進雲端」（保守才安全）');
assertEqual(/還沒進雲端的照片會<b>永久遺失、無法補回<\/b>/.test(CODE), true,
  '「清空整個佇列」按鈕的說明要保留');
assertEqual(/'📤 還有照片沒進雲端，請留在現場'/.test(CODE), true,
  '「請留在現場」要保留 —— 這裡寧可多留一會兒');

console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
process.exit(failed ? 1 : 0);
