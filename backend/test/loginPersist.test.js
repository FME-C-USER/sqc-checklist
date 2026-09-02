/**
 * 回歸測試：登入身分要跨分頁、跨重啟保留，且升級時不可把人登出。
 *
 * 2026-09-01 現場狀況：點檢一天要跑十幾家店（9:00~18:00），但登入身分存在
 * sessionStorage —— 那是「一個分頁一份、分頁關掉就消失」：
 *   ・關掉瀏覽器、開新分頁都要重新登入
 *   ・Android Chrome 會回收背景分頁，回來時登入資料可能已經不見
 * 有位同事 13:58 還正常、14:29 就被要求重新登入（遠短於後端的 6 小時效期）。
 * 更糟的是照片佇列存在 IndexedDB（永久保留），但送照片需要 token ——
 * 沒登入時照片就安靜地躺著沒人送。
 *
 * 這支測試釘住三件事：
 *   1. 寫入與讀取都走 localStorage（跨分頁、跨重啟）
 *   2. ★ 升級相容：舊登入還在 sessionStorage 時要能讀到並搬過去，
 *      否則所有人在拿到新版的那一刻會被登出一次 —— 那正是要消除的事
 *   3. 登出要把兩邊都清掉
 *
 * 執行方式：node backend/test/loginPersist.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const ROOT = path.join(__dirname, '..', '..');
const API = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 極簡的 Storage 假物件（記錄每一次寫入，用來驗證搬移確實發生） */
function store(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    __map: m,
  };
}

/** 載入 api.js，注入指定的 localStorage / sessionStorage 內容 */
function load(localInit, sessionInit) {
  const local = store(localInit), session = store(sessionInit);
  const sandbox = {
    console, setTimeout, clearTimeout, AbortController,
    localStorage: local, sessionStorage: session,
    location: { origin: 'https://x.test', pathname: '/app.html', href: '/app.html' },
    navigator: { onLine: true },
    window: null,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: {} }) }),
  };
  sandbox.window = sandbox;
  sandbox.window.SQC_CONFIG = { GAS_URL: 'https://gas.test/exec' };
  vm.createContext(sandbox);
  vm.runInContext(API, sandbox, { filename: 'api.js' });
  return { S: sandbox.SqcSession, api: sandbox.SqcApi, local, session, sandbox };
}

const USER = { name: '林秀真', empId: 'E1', role: '管理者', dept: '一部', section: '北一課', token: 'TOK123' };

// ===== 1. 寫入與讀取都在 localStorage =====
{
  const t = load({}, {});
  t.S.write(USER);
  assertEqual(!!t.local.getItem('sqc_user'), true, '★ 登入身分要寫進 localStorage（跨分頁、跨重啟才留得住）');
  assertEqual(t.session.getItem('sqc_user'), null, '不可再寫進 sessionStorage');
  assertEqual(t.S.read().name, '林秀真', '讀得回來');

  // 模擬「關掉瀏覽器再開」：sessionStorage 清空、localStorage 留著
  const t2 = load(Object.fromEntries(t.local.__map), {});
  assertEqual(t2.S.read().token, 'TOK123', '★ 重啟瀏覽器後仍是登入狀態（這就是不必一天登入十幾次的關鍵）');
}

// ===== 2. ★ 升級相容：舊登入在 sessionStorage 時要讀得到，並搬過去 =====
{
  const t = load({}, { sqc_user: JSON.stringify(USER) });
  assertEqual(t.S.read().token, 'TOK123',
    '★ 升級前登入的人不可被登出 —— 舊位置還有資料時要讀得到');
  assertEqual(!!t.local.getItem('sqc_user'), true, '★ 讀到舊位置時要順手搬到新位置');
  assertEqual(JSON.parse(t.local.getItem('sqc_user')).token, 'TOK123', '搬過去的內容要正確');
}

// ===== 3. 新位置優先，不會被舊位置的殘值蓋掉 =====
{
  const t = load({ sqc_user: JSON.stringify({ ...USER, token: 'NEW' }) },
                 { sqc_user: JSON.stringify({ ...USER, token: 'OLD' }) });
  assertEqual(t.S.read().token, 'NEW', '★ localStorage 優先（否則登出後又被舊殘值救回來）');
}

// ===== 4. 登出要把兩邊都清掉 =====
{
  const t = load({ sqc_user: JSON.stringify(USER) }, { sqc_user: JSON.stringify(USER) });
  t.S.clear();
  assertEqual(t.local.getItem('sqc_user'), null, '要清 localStorage');
  assertEqual(t.session.getItem('sqc_user'), null,
    '★ 也要清 sessionStorage —— 留著殘值會在下一次讀取時被搬回來，等於登不出去');
  assertEqual(t.S.read(), {}, '清完之後讀出空物件，不可拋錯');
}

// ===== 5. 壞資料不可讓 App 掛掉 =====
{
  const t = load({ sqc_user: '{壞掉的 JSON' }, {});
  assertEqual(t.S.read(), {}, '解析失敗要回空物件（否則整個 App 起不來）');
}

// ===== 6. C：兩種 AUTH 原因要分得出來 =====
(async () => {
  // 有帶 token → expired
  {
    const t = load({ sqc_user: JSON.stringify(USER) }, {});
    t.sandbox.fetch = async () => ({ ok: true, status: 200,
      text: async () => JSON.stringify({ ok: false, code: 'AUTH', error: '未登入或連線逾時，請重新登入' }) });
    try { await t.api.queryRecords('11508', {}); } catch (e) {}
    assertEqual(t.api.authReason(), 'expired', '★ 有帶 token 被打回 → expired（後端說失效）');
  }
  // 沒有登入資料 → missing
  {
    const t = load({}, {});
    t.sandbox.fetch = async () => ({ ok: true, status: 200,
      text: async () => JSON.stringify({ ok: false, code: 'AUTH', error: '未登入或連線逾時，請重新登入' }) });
    try { await t.api.queryRecords('11508', {}); } catch (e) {}
    assertEqual(t.api.authReason(), 'missing',
      '★ 完全沒帶 token → missing（這支手機上沒有登入資料，多半是開了新分頁）');
  }

  // ===== 7. 原始碼層面：不可有人繞過 SqcSession 直接碰 sessionStorage =====
  const strip = (src) => src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
  const appCode = strip(APP), idxCode = strip(IDX);
  assertEqual(/sessionStorage/.test(appCode), false,
    '★ app.html 不可直接碰 sessionStorage —— 一定要走 SqcSession，否則升級搬移會漏');
  assertEqual(/sessionStorage/.test(idxCode), false, '★ index.html 也不可直接碰');
  assertEqual(/window\.SqcSession\.write\(r\.user\)/.test(idxCode), true, '登入成功要用 SqcSession.write');
  assertEqual(/const currentUser = \(window\.SqcSession \? SqcSession\.read\(\) : \{\}\) \|\| \{\};/.test(appCode), true,
    'app.html 要用 SqcSession.read');
  assertEqual((appCode.match(/SqcSession\.clear\(\)/g) || []).length, 2,
    '★ 兩個登出入口（登出鈕、連線過期橫幅）都要用 SqcSession.clear');
  // 前提：確認去註解沒把程式碼一起刪掉，否則上面兩條會假通過
  assertEqual(/sessionStorage/.test(APP), true, '前提：原始碼的註解裡確實還提到 sessionStorage');

  // ===== 8. 橫幅要依原因改標題 =====
  assertEqual(/這支手機上沒有登入資料，需要登入/.test(APP), true, 'missing 要有自己的標題');
  assertEqual(/authReason === 'missing'/.test(APP), true, '要依原因分支');

  console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
  process.exit(failed ? 1 : 0);
})();
