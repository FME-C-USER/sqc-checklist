/**
 * 回歸測試：自動更新機制，以及缺失照片連結的退路。
 *
 * 為什麼需要自動更新：加到主畫面的 PWA 只要不關、不重新整理，可以掛好幾天；
 * 手機也常把分頁留在背景。結果是「修好了但現場沒拿到」—— 2026-08-31 那一整天的
 * 修正，隔天還有人停在舊版，而舊版遇到連線階段過期會直接跳轉回登入頁，
 * 正在填的表單當場消失。
 *
 * 但自動更新本身有個致命的失手方向：**在有人正在填表時重新載入**。
 * 重新載入不會弄丟照片（IndexedDB）或待送紀錄（recordQueue），
 * 但「填了還沒送出的表單」會全部消失，而那是同事在店裡花二十分鐘做出來的東西。
 * 所以 formDirty 的判斷一律從嚴，這支測試主要就在釘那件事。
 *
 * 缺失照片退路：報表原本只用 photoGroups[`${題名}/缺失`] 精準比對，
 * 而那個鍵是「送出當時的題名」、報表用的是「產出當時的題庫」。
 * 兩者差一個字，連結就靜默消失 —— pendingPhotos 是 0、同步狀態是「已同步」，
 * 完全沒有警訊。2026-09-01 板橋金鑽店就是在換月匯入新題庫那天出現這個現象。
 *
 * 執行方式：node backend/test/autoUpdate.test.js
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
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

// ===== 1. 版本偵測：用 Range 只抓開頭，且版本號只有一個來源 =====
assertEqual(/headers: \{ Range: 'bytes=0-4095' \}/.test(APP), true,
  '★ 只抓開頭 4KB —— 每 10 分鐘抓整份 app.html 是浪費');
assertEqual(/cache: 'no-store'/.test(APP), true, '不可讀到快取的舊版本，那會永遠偵測不到新版');
assertEqual(/const m = head\.match\(\/const APP_VERSION = '\(\[0-9-\]\+\)'\/\);/.test(APP), true,
  '★ 直接從 app.html 解析 APP_VERSION —— 不另外放 version.json，版本號只有一個來源就不會走味');
assertEqual(/if \(!res\.ok && res\.status !== 206\) return;/.test(APP), true,
  'Range 成功時是 206，不可把它當失敗');
{
  // APP_VERSION 必須真的落在抓取範圍內，否則永遠比對不到
  const i = APP.indexOf('const APP_VERSION');
  const bytes = Buffer.byteLength(APP.slice(0, i), 'utf8');
  assertEqual(bytes < 4096, true, '★ APP_VERSION 必須在前 4096 位元組內（目前 ' + bytes + '）');
}
assertEqual(/const VER_CHECK_MS = 600000;/.test(APP), true, '檢查間隔 10 分鐘');
assertEqual(/const first = setTimeout\(check, 30000\);/.test(APP), true,
  '開場先讓 App 載入完才問，不要跟開場資料搶頻寬');
assertEqual(/if \(!alive \|\| !navigator\.onLine\) return;/.test(APP), true, '離線時不要白打');

// ===== 2. ★ 表單有內容時絕對不可以重新載入 =====
assertEqual(/if \(formDirty\) return;/.test(APP), true, '★ 有未送出內容就不重新載入');
assertEqual(/\}, \[newVer, formDirty\]\);/.test(APP), true,
  '★ 依賴 formDirty —— 狀態變乾淨（送出完成）時要自己再跑一次，這就是「送出後才更新」');

/**
 * 把 formDirty 的算式抽出來實際跑一遍。
 * 只驗「有沒有寫這一行」不夠 —— 漏掉任何一個欄位，那個狀態下的人就會被弄掉表單。
 */
{
  const m = APP.match(/const formDirty = !!\(([\s\S]*?)\n      \);/);
  assertEqual(!!m, true, '應能取出 formDirty 的算式');
  const expr = m[1];
  const fn = new Function(
    'editingRecordId', 'submitting', 'postSubmit', 'basic', 'scores', 'toilet',
    'paperForm', 'keyObs', 'toiletPhotos', 'perfectPhotos', 'anyPhotos',
    'return !!(' + expr + ')');
  const anyPhotos = (obj) => Object.keys(obj || {}).some((k) => (obj[k] || []).length > 0);
  const CLEAN = {
    editingRecordId: null, submitting: false, postSubmit: null,
    basic: { time: '2026-09-02', storeCode: '', customStore: '' },
    scores: {}, toilet: {}, paperForm: [], keyObs: {}, toiletPhotos: {}, perfectPhotos: {},
  };
  const dirty = (over) => {
    const s = { ...CLEAN, ...over };
    return fn(s.editingRecordId, s.submitting, s.postSubmit, s.basic, s.scores, s.toilet,
      s.paperForm, s.keyObs, s.toiletPhotos, s.perfectPhotos, anyPhotos);
  };

  // 乾淨狀態才可以更新
  assertEqual(dirty({}), false, '剛開 App、什麼都沒填 → 可以更新');
  // 點檢時間有預設值，不可以拿它當依據，否則永遠都是 dirty、永遠不會更新
  assertEqual(dirty({ basic: { time: '2026-09-02', storeCode: '', customStore: '' } }), false,
    '★ 只有預設的點檢時間不算有內容（否則永遠不會更新）');

  // 以下每一種都必須算「有內容」—— 漏掉哪一個，那個狀態的人就會被弄掉表單
  [
    ['選了店鋪', { basic: { time: 'x', storeCode: '100001', customStore: '' } }],
    ['新增了店鋪', { basic: { time: 'x', storeCode: '', customStore: '某店' } }],
    ['勾了題目', { scores: { A1: { ngSubs: ['OC'] } } }],
    ['答了觀察區', { toilet: { O1: '有' } }],
    ['拍了紙本', { paperForm: [{ blob: 1 }] }],
    ['拍了重點觀察題', { keyObs: { KO1: [{ blob: 1 }] } }],
    ['拍了廁所缺失', { toiletPhotos: { T1: [{ blob: 1 }] } }],
    ['拍了滿分照片', { perfectPhotos: { A: [{ blob: 1 }] } }],
    ['正在編輯既有紀錄', { editingRecordId: 'R1' }],
    ['正在送出', { submitting: true }],
    ['送出後面板還開著', { postSubmit: { store: '某店' } }],
  ].forEach(([label, over]) => {
    assertEqual(dirty(over), true, '★ ' + label + ' → 不可重新載入');
  });

  // 空陣列不算有內容（清空照片後應該又可以更新）
  assertEqual(dirty({ keyObs: { KO1: [] }, toiletPhotos: { T1: [] } }), false,
    '照片都移除後不算有內容');
}

// ===== 3. 橫幅要說清楚現在會不會動 =====
assertEqual(/有新版本，送出後會自動更新/.test(APP), true, '有內容時要講「送出後才更新」');
assertEqual(/正在更新到新版本…/.test(APP), true, '乾淨時要講正在更新');
assertEqual(/立即更新/.test(APP), true, '要能自己決定馬上更新');
// 「稍後」只能清掉這一輪，不可變成永久關閉
assertEqual(/onClick=\{\(\) => setNewVer\(''\)\}/.test(APP), true,
  '★「稍後」只清這一輪 —— 下一次檢查還會再問，不可按一次就永遠不更新');
assertEqual(/\{APP_VERSION\} → \{newVer\}/.test(APP), true, '要顯示新舊版本，回報時才對得上');

// ===== 4. ★ 缺失照片連結要有退路 =====
assertEqual(/const itemNoOf = \(name\) =>/.test(APP), true, '要能取出題號');
assertEqual(/line\.push\(joinLinks\(itemDefectLinks\(r, it\)\)\);/.test(APP), true, '報表要改用有退路的版本');
assertEqual(/joinLinks\(\(r\.photoGroups \|\| \{\}\)\[`\$\{it\.name\}\/缺失`\]\)/.test(APP), false,
  '★ 不可再只用題名精準比對');
{
  // 把退路的算式抽出來跑：題號比對不可誤中鄰近的題號
  const noOf = new Function('name',
    "return (String(name || '').match(/^(\\d+(?:-\\d+)?)\\./) || [])[1] || '';");
  assertEqual(noOf('1.招牌'), '1', '取得題號 1');
  assertEqual(noOf('10.商品豐富陳列'), '10', '取得題號 10');
  assertEqual(noOf('15-1.落地陳列'), '15-1', '拆題的題號要完整');
  assertEqual(noOf('沒有題號的題目'), '', '沒題號就回空字串（不做退路，避免亂配）');

  const groupLinks = (groups, pred) => Object.keys(groups || {}).filter(pred)
    .reduce((acc, k) => acc.concat(groups[k] || []), []);
  const fallback = (groups, name) => {
    const no = noOf(name);
    if (!no) return [];
    return groupLinks(groups, (k) => k.indexOf(no + '.') === 0 && /\/缺失$/.test(k));
  };
  const G = {
    '1.招牌/缺失': ['u1'],
    '10.商品豐富陳列/缺失': ['u10'],
    '15-1.落地陳列/缺失': ['u151'],
    '15.舊的落地陳列/缺失': ['u15'],
    'SQC點檢表完成照片': ['paper'],
  };
  assertEqual(fallback(G, '1.招牌（改過名字）'), ['u1'], '題名改了、題號沒改 → 仍找得到');
  assertEqual(fallback(G, '1.招牌'), ['u1'], '★ 題號 1 不可誤中 10.');
  assertEqual(fallback(G, '15-1.落地陳列'), ['u151'], '★ 15-1 不可誤中 15.');
  assertEqual(fallback(G, '15.落地陳列'), ['u15'], '★ 15 不可誤中 15-1.');
  assertEqual(fallback(G, '99.不存在的題目'), [], '找不到就回空陣列，不可亂配一個');
}

console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
process.exit(failed ? 1 : 0);
