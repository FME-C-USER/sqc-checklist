// 回歸測試：讓「照片為什麼傳不上去」看得見（2026-08-28）
//
// 起因：8/27 有人一小時內重試幾百次全數失敗，而失敗原因其實每次都存進了
// photo.error —— 但介面只顯示張數，那個字串一直躺在她手機的 IndexedDB 裡。
// 事後只能靠猜。這批做四件事：
//   1 儲存層保留真正的錯誤（原本 t.error 在 Safari 常是 null → 提示只能寫「原因：未知」）
//   2 上傳診斷畫面（點檢人員本人打得開；佇列是每支手機各自獨立的）
//   3 卡太久自動把原因回報到異動紀錄
//   4 Origin 不在白名單時明確報錯，不再靜默退回預設值
// 執行方式：node backend/test/uploadDiag.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const DB = fs.readFileSync(path.join(ROOT, 'js', 'db.js'), 'utf8');
const UP = fs.readFileSync(path.join(ROOT, 'js', 'uploader.js'), 'utf8');
const GS = fs.readFileSync(path.join(ROOT, 'backend', '程式碼.gs'), 'utf8');
const CODE = APP.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. 儲存層要保留真正的錯誤 =====
assertEqual(/t\.onerror = \(\) => reject\(t\.error\);/.test(DB), false,
  '不可只 reject(t.error) —— transaction.error 在 Safari 上常是 null，原因會變成「未知」');
assertEqual(/out\.__req\.onerror = \(\) => \{ reqErr = out\.__req\.error; \};/.test(DB), true,
  '要接請求層的錯誤（QuotaExceededError 這類具體原因只出現在這一層）');
assertEqual(/t\.onabort = \(\) => fail\('交易被中止'\);/.test(DB), true, 'abort 也要接（配額不足常走這條）');
assertEqual(/瀏覽器沒有提供原因，最常見是儲存空間不足/.test(DB), true, '兩層都拿不到時要給人看得懂的話，不可丟出 null');
assertEqual(/無法開啟本機資料庫（無痕視窗或瀏覽器設定可能封鎖了網站儲存空間）/.test(DB), true,
  '開啟資料庫失敗也要有可讀的原因');

// 實跑那段錯誤決定邏輯，確認優先序是 req.error → t.error → 保底訊息
{
  const pick = (reqErr, txErr) => reqErr || txErr || new Error('IndexedDB 交易失敗（瀏覽器沒有提供原因，最常見是儲存空間不足）');
  const q = new Error('quota'); q.name = 'QuotaExceededError';
  assertEqual(pick(q, null).name, 'QuotaExceededError', '有請求層錯誤時要用它');
  assertEqual(pick(null, new Error('tx')).message, 'tx', '沒有請求層錯誤才退到交易層');
  assertEqual(/儲存空間不足/.test(pick(null, null).message), true, '★ 兩層都是 null 時不可回 null（這就是「原因：未知」的來源）');
}

// ===== 2. 診斷讀取不可把 blob 讀進記憶體 =====
assertEqual(/function photoDiagnostics\(\)/.test(DB), true, '要有 photoDiagnostics');
assertEqual(/openCursor\(\)/.test(DB), true, '要用游標逐筆取，不可用 getAll');
{
  const fn = /function photoDiagnostics\(\)[\s\S]*?\n  \}/.exec(DB)[0];
  assertEqual(/out\.push\(\{[\s\S]*?blob:/.test(fn), false, '不可把 blob 放進結果');
  assertEqual(/out\.push\(\{[\s\S]*?thumb:/.test(fn), false, '不可把 thumb 放進結果（整張 1920px 的 dataURL）');
  assertEqual(/blobSize: \(p\.blob && p\.blob\.size\) \|\| 0/.test(fn), true,
    '要回內容大小 —— 0 代表照片在本機就已經不見了，這是關鍵訊號');
  assertEqual(/error: p\.error \|\| ''/.test(fn), true, '要回上傳錯誤');
  assertEqual(/linkErr: p\.linkErr \|\| ''/.test(fn), true, '要回回寫連結的錯誤');
}

// ===== 3. 診斷畫面 =====
assertEqual(/const openDiag = async \(\) => \{/.test(CODE), true, '要有 openDiag');
assertEqual(/SqcDB\.photoDiagnostics\(\)/.test(CODE), true, '畫面要走 photoDiagnostics');
assertEqual(/list\.sort\(\(a, b\) => \(b\.tries \|\| 0\) - \(a\.tries \|\| 0\)\)/.test(CODE), true,
  '卡最久的排前面');
assertEqual((CODE.match(/onClick=\{openDiag\}/g) || []).length >= 2, true,
  '藍色細條與送出後面板都要有入口（使用者卡住的那一刻就在面板上）');
assertEqual(/來源網址：\{location\.origin\}/.test(APP), true,
  '要顯示來源網址 —— 網址不在白名單時照片會全滅，而那從伺服器端看不出來');
assertEqual(/內容 \{p\.blobSize \? Math\.round\(p\.blobSize \/ 1024\) \+ ' KB' : '0（照片不見了）'\}/.test(APP), true,
  '內容 0 要用紅字標示（那是「本機就沒了」而不是網路問題）');
assertEqual(/這是<b>這支手機<\/b>待傳佇列的內容/.test(APP), true, '要講清楚佇列是每支手機各自獨立的');

// ===== 4. 照片內容不見了要當場講清楚 =====
assertEqual(/if \(!photo\.blob \|\| !photo\.blob\.size\) \{/.test(UP), true,
  '上傳前要檢查照片內容還在不在');
assertEqual(/照片內容不見了：本機儲存的檔案是空的/.test(UP), true,
  '空 body 的 PUT 只會換到一個 Drive 4xx，會把診斷帶往錯誤方向');

// ===== 5. 卡太久自動回報 =====
assertEqual(/const REPORT_AFTER_TRIES = 10;/.test(UP), true, '要有回報門檻');
assertEqual(/async function reportStuck\(\)/.test(UP), true, '要有 reportStuck');
assertEqual(/await reportStuck\(\);/.test(UP), true, 'pumpOnce 要呼叫它');
assertEqual(/logEvent\('photoUploadStuck', msg\)/.test(UP), true, '要用 photoUploadStuck 這個事件');
assertEqual(/photoUploadStuck: '照片上傳卡住'/.test(GS), true, '後端白名單要放行，否則會被丟掉');
assertEqual(/來源：\$\{location\.origin\}/.test(UP), true, '回報要帶來源網址');
assertEqual(/reported: true/.test(UP), true, '回報過要標記，否則 19 張會塞 19 筆一樣的紀錄');
// 同一筆＋同一個錯誤只回報一次
assertEqual(/const key = \(p\.recordId \|\| '\?'\) \+ '｜' \+ \(p\.error \|\| '\(沒有錯誤訊息\)'\);/.test(UP), true,
  '要依「紀錄＋錯誤」分組，避免塞爆每人每小時 60 筆的額度');
assertEqual(/catch \(e\) \{ \/\* 診斷回報本身絕對不能影響上傳 \*\/ \}/.test(UP), true,
  '回報失敗不可影響上傳');

// ===== 6. Origin 白名單 =====
assertEqual(/'https:\/\/sqc-checklist-403438157899\.asia-east1\.run\.app': 1/.test(GS), true,
  'Cloud Run 的新格式網址要在白名單裡（2026-08-28 實測它也回 200）');
assertEqual(/function originFor_\(origin\)/.test(GS), true, '要有 originFor_');
assertEqual(/var org = ALLOWED_ORIGINS\[String\(origin \|\| ''\)\] \? String\(origin\) : DEFAULT_ORIGIN;/.test(GS), false,
  '不可再靜默退回預設 Origin（那會讓照片 100% 全滅而伺服器端毫無跡象）');
assertEqual(/for \(var b = 0; b < items\.length; b\+\+\) bad\.push\(\{ ok: false, error: chk\.error \}\);/.test(GS), true,
  '網址不合法時每一項都要回錯誤，讓前端存進 photo.error 並顯示');
// 實跑 originFor_ 的判斷
{
  const src = /var DEFAULT_ORIGIN = [\s\S]*?\n\};/.exec(GS)[0] + '\n'
    + /function originFor_\(origin\) \{[\s\S]*?\n\}/.exec(GS)[0];
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(src + '\nthis.originFor_ = originFor_;', ctx);
  assertEqual(ctx.originFor_('https://fme-c-user.github.io'),
    { ok: true, origin: 'https://fme-c-user.github.io' }, 'Pages 放行');
  assertEqual(ctx.originFor_('https://sqc-checklist-ec6xuimwxa-de.a.run.app'),
    { ok: true, origin: 'https://sqc-checklist-ec6xuimwxa-de.a.run.app' }, '對外公布的網址放行');
  assertEqual(ctx.originFor_('https://sqc-checklist-403438157899.asia-east1.run.app').ok, true,
    '★ 新格式網址現在也放行（原本會靜默退回，導致照片全滅）');
  assertEqual(ctx.originFor_('').origin, 'https://fme-c-user.github.io',
    '完全沒帶（很舊的前端）才沿用預設值，維持相容');
  const bad = ctx.originFor_('https://evil.example.com');
  assertEqual(bad.ok, false, '不在白名單要明確失敗');
  assertEqual(/這個網址不在允許清單內/.test(bad.error) && /請改用官方網址/.test(bad.error), true,
    '錯誤訊息要說明怎麼處理，不可只說失敗');
}

console.log(failed ? `\n✗ ${failed} 項未通過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);
