/**
 * 回歸測試：2026-09-04 現場「竹南博愛店缺 6 張，但那 6 張在手機上全是『完成』」。
 *
 * 手機端 6 張都是 linked（＝後端確實回報過 attachPhotoLinks 成功，blob 也已釋放），
 * 但紀錄的照片JSON 一個 fileId 都沒有。全專案只有 recordToRow 會覆寫那一欄，
 * 而它的呼叫端只有 submitRecord（同 id 直接 return，不覆寫）與 updateRecord。
 * 所以是編輯覆蓋掉的：
 *
 *   開啟編輯（此時紀錄裡只有檔名，快照存進 existingPhotos）
 *     → 中途照片上傳完成，attachPhotoLinks 把 fileId 寫回紀錄
 *       → 她按送出 → 那份舊快照把剛寫好的 fileId 全部蓋成空的
 *
 * 而修復工具只填空值、不會無中生有，所以這種覆蓋是真的會弄丟連結。
 *
 * 三項修正：
 *   1 後端 updateRecord 改為合併（本檔主要測這個）
 *   2 「照片沒有雲端連結」的指示改成「先跑修復試算」—— 原本叫人去重開 App 是死路
 *   3 orphan 每次開 App 給一次重送機會，並把放棄時的訊息改成「該做什麼」
 *
 * 執行方式：node backend/test/photoJsonMerge.test.js
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
const UP = fs.readFileSync(path.join(ROOT, 'js', 'uploader.js'), 'utf8');
// 只移除 /* */ 區塊與整行 //。不要用 /\{\s*\/\*...\*\/\s*\}/ 想一次抓 JSX 註解 ——
// 非貪婪比對接不上 } 時會回溯到下一個 */}，從某個 `=> {` 一路吃掉幾千行。
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
const CODE = strip(APP);
const GSC = strip(GS);

// 抽出後端真正的 mergePhotoJson_ 來跑，不自己重寫一份
const m = /function mergePhotoJson_\(stored, incoming, removed\) \{[\s\S]*?\n\}/.exec(GSC);
assertEqual(!!m, true, '前提：抓得到 mergePhotoJson_ 全文');
const merge = new Function(m[0] + '; return mergePhotoJson_;')();

const K = '115年09月/重點觀察題1.【店外全景照】';
const K2 = '115年09月/SQC點檢表完成照片';

// ===== 1. ★ 現場那個情境：舊快照不可以蓋掉已寫好的 fileId =====
{
  const stored = { [K]: [{ name: 'a_1.jpg', fileId: 'F1' }, { name: 'a_2.jpg', fileId: 'F2' }] };
  const incoming = { [K]: ['a_1.jpg', 'a_2.jpg'] };   // 開啟編輯時的快照：只有檔名
  assertEqual(merge(stored, incoming, []), stored,
    '★ 前端送來只有檔名時，必須沿用後端已經寫好的 fileId（這就是竹南博愛店那 6 張）');
}

/**
 * ===== 1b. ★ 兩邊都有 fileId 時，後端現存的優先 =====
 * 上面那條測不出優先順序 —— 現場那個情境裡 incoming 一個 fileId 都沒有，
 * 所以「stored 優先」和「incoming 優先」得到相同結果。要分辨得讓兩邊都有值。
 *
 * 真實情境：照片連結修復或重複照片清理把 fileId 換成了新的檔案，
 * 而使用者手上那份編輯快照還帶著舊的 fileId —— 送出時不可以把舊的推回去。
 */
{
  const stored = { [K]: [{ name: 'a_1.jpg', fileId: 'F_NEW' }] };
  const incoming = { [K]: [{ name: 'a_1.jpg', fileId: 'F_OLD' }] };
  assertEqual(merge(stored, incoming, []), stored,
    '★ 兩邊都有 fileId 時要用後端現存的（前端的可能是過期快照，例如修復後才送出的編輯）');
}

// ===== 2. ★ 中途被 attachPhotoLinks 附加進來的照片不可以被抹掉 =====
{
  const stored = {
    [K]: [{ name: 'a_1.jpg', fileId: 'F1' }, { name: 'a_2.jpg', fileId: 'F2' }],
    [K2]: [{ name: 'p_1.jpg', fileId: 'F9' }],   // 快照之後才完成的
  };
  const incoming = { [K]: ['a_1.jpg', 'a_2.jpg'] };
  const out = merge(stored, incoming, []);
  assertEqual(out[K2], [{ name: 'p_1.jpg', fileId: 'F9' }],
    '★ 快照裡沒有的那一組要留下 —— 只取 incoming 會讓檔案還在 Drive 但紀錄沒有那一筆，連修復都救不回來');
  assertEqual(Object.keys(out).sort(), [K, K2].sort(), '兩組都要在');
}
{
  const stored = { [K]: [{ name: 'a_1.jpg', fileId: 'F1' }, { name: 'a_2.jpg', fileId: 'F2' }] };
  const incoming = { [K]: ['a_1.jpg'] };   // 快照只有第一張（第二張是中途附加的）
  assertEqual(merge(stored, incoming, []), stored,
    '★ 同一組裡「快照沒有但現存有」的也要留下');
}

// ===== 3. ★ 刪除要生效，但必須是明示的 =====
{
  const stored = { [K]: [{ name: 'a_1.jpg', fileId: 'F1' }, { name: 'a_2.jpg', fileId: 'F2' }] };
  const incoming = { [K]: ['a_1.jpg'] };
  assertEqual(merge(stored, incoming, ['a_2.jpg']),
    { [K]: [{ name: 'a_1.jpg', fileId: 'F1' }] },
    '★ 明確刪除的要真的移除（不可以被聯集救回來）');
}
{
  // 沒有 fileId 的照片（「無雲端連結」那些）也要刪得掉 —— 這正是現場會被刪的那一種
  const stored = { [K]: ['a_1.jpg', 'a_2.jpg'] };
  assertEqual(merge(stored, { [K]: ['a_1.jpg'] }, ['a_2.jpg']), { [K]: ['a_1.jpg'] },
    '★ 沒有 fileId 的也要刪得掉');
}
{
  // 整組刪光時那個鍵要消失，不可以留一個空陣列（photoStateOf 會把空陣列當成有東西）
  const stored = { [K]: [{ name: 'a_1.jpg', fileId: 'F1' }] };
  assertEqual(merge(stored, {}, ['a_1.jpg']), {}, '整組刪光時鍵要消失，不留空陣列');
}

// ===== 4. 新增、順序與型別 =====
{
  const stored = { [K]: [{ name: 'a_1.jpg', fileId: 'F1' }] };
  const incoming = { [K]: ['a_1.jpg', 'a_2.jpg'] };   // a_2 是這次新拍的，還沒上傳
  assertEqual(merge(stored, incoming, []),
    { [K]: [{ name: 'a_1.jpg', fileId: 'F1' }, 'a_2.jpg'] },
    '新增的照片沒有 fileId，要以純字串保留（等 attachPhotoLinks 補）');
}
{
  // 前端的順序優先（使用者看到的排列），現存但前端沒送的接在後面
  const stored = { [K]: [{ name: 'a_1.jpg', fileId: 'F1' }, { name: 'a_9.jpg', fileId: 'F9' }] };
  const incoming = { [K]: ['a_2.jpg', 'a_1.jpg'] };
  assertEqual(merge(stored, incoming, []).map ? null : merge(stored, incoming, [])[K],
    ['a_2.jpg', { name: 'a_1.jpg', fileId: 'F1' }, { name: 'a_9.jpg', fileId: 'F9' }],
    '前端的順序優先，現存而前端沒送的接在後面');
}
assertEqual(merge(null, null, null), {}, '三個都是空的不可爆掉');
assertEqual(merge({}, { [K]: [] }, []), {}, '空陣列不產生鍵');
{
  // 同一個檔名重複送不可以變成兩筆
  const stored = { [K]: [{ name: 'a_1.jpg', fileId: 'F1' }] };
  assertEqual(merge(stored, { [K]: ['a_1.jpg', 'a_1.jpg'] }, [])[K].length, 1, '同檔名不可重複');
}

// ===== 5. 接線：updateRecord 要用它，submitRecord 不必 =====
assertEqual(/rec\.photos = mergePhotoJson_\(safeJson\(orig\['照片JSON'\]\), rec\.photos, rec\.removedNames\);/.test(GSC), true,
  '★ updateRecord 寫入前要先合併');
assertEqual(/removedNames: removedPhotos\.map\(x => \(x && \(x\.name \|\| x\)\)\)\.filter\(Boolean\),/.test(CODE), true,
  '★ 前端要把「明確刪除的檔名」送出去');
// submitRecord 遇到同一個紀錄ID 是直接 return，不覆寫那一列 —— 所以不需要合併
assertEqual(/if \(sameId\) \{[\s\S]*?return \{ ok: true, id: recId, resent: true \};/.test(GSC), true,
  '前提：submitRecord 同 id 是直接返回、不覆寫，所以新增／重送那條路沒有這個問題');

// ===== 6. ★ removedPhotos 不可以再只記「有 fileId」的 =====
assertEqual(/if \(gone && gone\.fileId\) setRemovedPhotos/.test(CODE), false,
  '★ 不可再只記有 fileId 的 —— 「無雲端連結」那些正好沒有，漏記就刪不掉');
assertEqual(/setRemovedPhotos\(prev => \[\.\.\.prev, \{ fileId: \(gone && gone\.fileId\) \|\| '', name: nm \}\]\);/.test(CODE), true,
  '沒有 fileId 的也要記，fileId 留空');
assertEqual(/const toTrash = removedPhotos\.map\(x => x\.fileId\)\.filter\(Boolean\);/.test(CODE), true,
  '★ 丟垃圾桶時要過濾掉沒有 fileId 的（那些不必也不能丟）');

// ===== 7. 第 2 項：指示要改成「先跑修復試算」 =====
assertEqual(/請當天就聯絡他，用原本那支手機、原本那個瀏覽器開一次 App<\/b>，\s*\n\s*佇列會自動傳完並補上連結。放久了/.test(CODE), false,
  '★ 不可再把「重開 App」當成第一步 —— 照片已在雲端時那是死路');
assertEqual(/先到「維護專區 → 照片連結修復」按試算/.test(CODE), true,
  '★ 第一步要改成唯讀的修復試算（那是唯一能分辨「在雲端」與「還在手機」的動作）');
assertEqual(/修復期間請點檢人員先不要編輯那一筆/.test(CODE), true,
  '★ 要警告修復期間不要編輯 —— 否則舊快照會把剛補好的連結蓋掉');
assertEqual(/沒有雲端連結/.test(CODE), true, '標題改成「沒有雲端連結」（原本說「還沒上傳完成」是在斷言照片的位置）');

// ===== 8. 第 3 項：orphan 的出口 =====
assertEqual(/const _orphanTried = new Set\(\);/.test(UP), true, '★ 要有「本次開 App 已試過」的集合');
assertEqual(/p\.status === 'orphan'\s*\n\s*&& !_orphanTried\.has\(p\.id\) && dueLink\(p\)/.test(UP), true,
  '★ orphan 每次開 App 給一次機會，並各自過退避');
assertEqual(/\.filter\(\(p\) => p\.status === 'done' \|\| p\.status === 'orphan'\)/.test(UP), true,
  '★ reconcileLinks 也要收 orphan，否則「整筆都是 orphan」的紀錄永遠不會被拜訪');
assertEqual(/照片本身已經在雲端硬碟，不會遺失 —— 重試不會有用，可以清空佇列。/.test(UP), true,
  '★ 放棄時的訊息要說「該做什麼」，不是只寫後端原文「找不到紀錄」');
// ★ 不可以把 orphan 併進 done 的整筆退避檢查（那會讓一張 orphan 擋住同一筆的 done）
assertEqual(/if \(doneOnes\.length && doneOnes\.some\(\(p\) => p\.linkNextAt && p\.linkNextAt > now\)\) return;/.test(UP), true,
  '★ 整筆退避只看 done，不含 orphan —— 否則會把 2026-09-03 修掉的隊首堵塞搬回來');
assertEqual(/if \(toLink\.some\(\(p\) => p\.linkNextAt && p\.linkNextAt > now\)\) return;/.test(UP), false,
  '不可再對整個 toLink（含 orphan）做整批退避檢查');

/**
 * ===== 9. 版本 =====
 * 不寫死版號（那會變成每次改版都要回來改的無意義維護）。
 * 不變式是「這批動了後端，所以 NEEDS_GAS 必須等於後端版號」——
 * 落後就等於前端不會提醒管理者去貼後端。
 */
{
  const gas = (GS.match(/var GAS_VERSION = '([0-9-]+)'/) || [])[1];
  const needs = (APP.match(/const NEEDS_GAS = '([0-9-]+)'/) || [])[1];
  assertEqual(needs, gas, '★ NEEDS_GAS 要等於後端版號（這批動了後端）');
  assertEqual(gas >= '20260904-1445', true, '後端版號不可低於本批（' + gas + '）');
}

console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
process.exit(failed ? 1 : 0);
