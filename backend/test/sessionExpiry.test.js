/**
 * 回歸測試：連線階段過期的處理。
 *
 * 2026-08-31 林秀真在查詢時跳出「11508 讀取失敗（未登入或連線逾時，請重新登入）」，
 * 而畫面同時還顯示著上一次查詢的 4 筆資料與統計。三個問題：
 *
 *   1. token 存在 CacheService 且效期固定 6 小時、沒有任何續期 ——
 *      早上登入的人下午會突然被踢出去，不管中間一直在用。
 *   2. 前端遇到 AUTH 直接 location.href = 'index.html'。這條路徑對「任何」呼叫
 *      都成立，包含 setInterval(pump, 15000) 的背景補傳 —— 有人正在填點檢表、
 *      連線階段剛好過期，15 秒內就會被整頁換掉，表單全部消失
 *      （本系統沒有草稿保存，是真的全沒）。
 *   3. 提示說「請重新查詢一次」—— 但 AUTH 重查一定也失敗，現場就是照著這句話重查。
 *
 * 執行方式：node backend/test/sessionExpiry.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadGasFile } = require('./gas-fake-env');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const ROOT = path.join(__dirname, '..', '..');
/**
 * 「不可以再出現某段舊寫法」這類斷言一定要先去掉註解。
 * 說明「原本錯在哪」的註解本身就會引用那段舊寫法 —— 不去掉就會命中自己的註解，
 * 看起來像永遠沒修好。（今天已經因此誤判三次。）
 * 只處理 /* *\/、{/* *\/} 與「整行只有 //」——
 * 用一般的 // 規則會把字串裡的 https:// 之後整行吃掉。
 */
function stripComments(src) {
  const out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return out.split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
}
const read = (...p) => stripComments(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const APP = read('app.html');
const API = read('js', 'api.js');
const UP = read('js', 'uploader.js');
// 原始碼（未去註解）—— 給「必須存在」的斷言用，避免去註解時誤刪程式碼造成假通過
const API_RAW = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');

// ===== 1. 後端：滑動效期 =====
{
  const { ctx } = loadGasFile(path.join(ROOT, 'backend', '程式碼.gs'));
  const puts = [];
  const mem = {};
  ctx.CacheService = {
    getScriptCache: () => ({
      get: (k) => (mem[k] === undefined ? null : mem[k]),
      put: (k, v, ttl) => { puts.push({ k, ttl }); mem[k] = v; },
      remove: (k) => { delete mem[k]; },
    }),
  };
  mem['sess_TOK'] = JSON.stringify({ role: '點檢員', name: '林秀真', empId: 'E1', ad: 'lin' });

  puts.length = 0;
  const sess = ctx.getSession('TOK');
  assertEqual(sess && sess.name, '林秀真', '前提：能讀出連線階段');
  assertEqual(puts.length, 1, '★ 每次讀取都要把效期重新寫回去（滑動效期）');
  assertEqual(puts[0].ttl, 21600, '★ 續期要給滿 6 小時');
  assertEqual(puts[0].k, 'sess_TOK', '續期的是同一個鍵');

  // 不存在的 token 不可以被「續期」成存在
  puts.length = 0;
  assertEqual(ctx.getSession('NOPE'), null, '不存在的 token 要回 null');
  assertEqual(puts.length, 0, '★ 不存在時不可寫入任何東西（否則等於憑空發出一個階段）');
  assertEqual(ctx.getSession(''), null, '空 token 要回 null');
  assertEqual(ctx.getSession(null), null, 'null token 要回 null');
}

// ===== 2. 前端：AUTH 絕不自己跳轉 =====
assertEqual(/location\.href = 'index\.html'/.test(API), false,
  '★ api.js 不可再自己跳轉 —— 那條路徑對背景補傳也成立，會把正在填的表單整頁換掉');
// 前提：確認去註解沒有把程式碼一起刪掉（否則上面那條會假通過）
assertEqual(/_authLost = true;/.test(API), true, 'AUTH 要記下狀態');
assertEqual(/onAuthLost, authLost,/.test(API), true, '要把狀態與訂閱都對外公開');
assertEqual(/location\.href/.test(API_RAW), true,
  '前提：原始碼裡確實還有 location.href 字樣（在註解裡），證明上面那條靠的是去註解而不是碰巧');
// 也不可清掉 sessionStorage：橫幅要講得出是誰的連線過期了
assertEqual(/if \(data\.code === 'AUTH'\) \{\s*\n\s*_authLost = true;/.test(API), true,
  'AUTH 分支只做「記狀態 + 通知」兩件事');

// 行為驗證：AUTH 之後 authLost() 要為真，且訂閱者要被通知
{
  const sandbox = {
    console, setTimeout, clearTimeout, AbortController,
    sessionStorage: { getItem: () => JSON.stringify({ token: 'T' }), removeItem: () => {}, setItem: () => {} },
    location: { origin: 'https://x.test', pathname: '/app.html', href: '/app.html' },
    navigator: { onLine: true },
    window: null,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, code: 'AUTH', error: '未登入或連線逾時，請重新登入' }) }),
  };
  sandbox.window = sandbox;
  sandbox.window.SQC_CONFIG = { GAS_URL: 'https://gas.test/exec' };
  vm.createContext(sandbox);
  vm.runInContext(API, sandbox, { filename: 'api.js' });
  const A = sandbox.SqcApi;
  let notified = 0;
  A.onAuthLost(() => { notified++; });
  assertEqual(A.authLost(), false, '一開始不是過期狀態');
  (async () => {
    let msg = '';
    try { await A.queryRecords('11508', {}); } catch (e) { msg = e.message; }
    assertEqual(msg, '未登入或連線逾時，請重新登入', '仍要把後端的原文丟出來');
    assertEqual(A.authLost(), true, '★ AUTH 之後 authLost() 要為真');
    assertEqual(notified, 1, '★ 訂閱者要被通知一次');
    assertEqual(sandbox.location.href, '/app.html', '★ 不可被改寫（等於沒有跳轉）');

    // ===== 3. 上傳器：過期後停手，但仍要清本機空間 =====
    assertEqual(/window\.SqcApi\.authLost\(\)\) \{/.test(UP), true,
      '★ pump 要檢查連線階段 —— 打了也是白打，每 15 秒一輪等於用註定失敗的請求消耗後端');
    const idxAuth = UP.indexOf('SqcApi.authLost()');
    const idxRun = UP.indexOf('if (_running) { _again = true;');
    assertEqual(idxAuth > 0 && idxAuth < idxRun, true, '要在真正開跑之前就擋掉');
    assertEqual(/authLost\(\)\) \{\s*\n\s*await releaseFinished\(\)/.test(UP), true,
      '★ 但清理本機空間不需要後端，過期時仍要做（否則手機永遠騰不出空間）');

    // ===== 4. 畫面：橫幅與正確的指示 =====
    assertEqual(/const \[authLost, setAuthLost\] = useState\(false\);/.test(APP), true, '要有橫幅狀態');
    assertEqual(/return SqcApi\.onAuthLost\(mark\);/.test(APP), true, '要訂閱');
    assertEqual(/if \(SqcApi\.authLost\(\)\) mark\(\);/.test(APP), true,
      '掛載前就過期的情況也要顯示（訂閱是掛載後才建立的）');
    assertEqual(/setAuthReason\(SqcApi\.authReason \? SqcApi\.authReason\(\) : ''\);/.test(APP), true,
      '同時要記下是哪一種原因');
    assertEqual(/連線階段已過期，需要重新登入/.test(APP), true, '橫幅要講清楚發生什麼事');
    assertEqual(/已經拍好的照片與已排入的紀錄都還留在這支手機上/.test(APP), true,
      '★ 要先講「東西沒不見」—— 否則現場會以為白做了一家店');
    // 清除改走 SqcSession.clear()（localStorage 與 sessionStorage 都要清），見 loginPersist.test.js
    assertEqual(/onClick=\{\(\) => \{ SqcSession\.clear\(\); location\.href = 'index\.html'; \}\}/.test(APP), true,
      '跳轉改由使用者自己按');
    // 查詢失敗的指示不可再叫人重查
    assertEqual(/請按畫面上方的「重新登入」，登入後再查詢。/.test(APP), true,
      '★ AUTH 時要說「重新登入」；說「請重新查詢一次」會讓人一直重查一定失敗的動作');
    assertEqual(/const isAuth = bad\.some\(b => \/未登入\|連線逾時\/\.test/.test(APP), true,
      '要能分辨這次失敗是不是 AUTH');

    console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
    process.exit(failed ? 1 : 0);
  })();
}
