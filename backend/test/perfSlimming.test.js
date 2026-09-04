// 回歸測試：速度改善的四項（使用者 2026-08-26「普遍反應速度慢要一直等」）
//   1 xlsx／exceljs（合計 1.81MB、佔前端資源 37%）改為用到才載入
//   2 「本月已點檢」改用只回店號的輕量路由（原本抓回整月完整紀錄，只為了取店號一欄）
//   4 照片分享（每張三次 Drive 呼叫）移到背景，不再讓使用者等
//   5 ssBook() 不再每次 openById
// 執行方式：node backend/test/perfSlimming.test.js
const fs = require('fs');
const path = require('path');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
const GS = fs.readFileSync(GS_PATH, 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'api.js'), 'utf8');
const UP = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'uploader.js'), 'utf8');
const SW = fs.readFileSync(path.join(__dirname, '..', '..', 'service-worker.js'), 'utf8');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. xlsx／exceljs 用到才載入 =====
assertEqual(/<script src="vendor\/xlsx/.test(APP), false, 'xlsx 不可在 head 直接載入');
assertEqual(/<script src="vendor\/exceljs/.test(APP), false, 'exceljs 不可在 head 直接載入');
assertEqual(APP.includes('function ensureLib(name)'), true, '要有用到才載入的載入器');
assertEqual(APP.includes("XLSX: 'vendor/xlsx-0.20.3.full.min.js'"), true, '路徑要對得上 vendor 的實際檔名');
assertEqual(APP.includes("ExcelJS: 'vendor/exceljs-4.4.0.min.js'"), true, '路徑要對得上 vendor 的實際檔名');
assertEqual(APP.includes('if (_libLoading[name]) return _libLoading[name];'), true, '同一支重複呼叫要共用同一個 Promise，不可載入兩次');
assertEqual(APP.includes('delete _libLoading[name];'), true, '載入失敗要允許重試（例如剛好斷線）');
assertEqual(APP.includes('無法載入 '), true, '載入失敗要有看得懂的訊息');
// 四個使用點都要先 await
assertEqual((APP.match(/ensureLib\('XLSX'\)/g) || []).length, 2, 'XLSX 的兩個使用點（尚未點檢清單、匯入解析）都要先載入');
assertEqual((APP.match(/ensureLib\('ExcelJS'\)/g) || []).length, 2, 'ExcelJS 的兩個使用點（產報表、請款金額）都要先載入');
assertEqual(/const parseFile = \(file\) => ensureLib\('XLSX'\)\.then/.test(APP), true, '匯入解析要在建立 FileReader 之前載入');
// 檔案實際存在，才不會 onerror
['vendor/xlsx-0.20.3.full.min.js', 'vendor/exceljs-4.4.0.min.js'].forEach(f => {
  assertEqual(fs.existsSync(path.join(__dirname, '..', '..', f)), true, f + ' 必須存在');
});
// Service Worker：不再預先下載這 1.81MB，但仍會在第一次真的用到時回填快取
assertEqual(/'\.\/vendor\/xlsx/.test(SW), false, 'SW 不再預先快取 xlsx');
assertEqual(/'\.\/vendor\/exceljs/.test(SW), false, 'SW 不再預先快取 exceljs');
assertEqual(SW.includes("const CACHE = 'sqc-shell-v4'"), true, '殼層清單改了就要換 CACHE 版本，舊快取才會被清掉');
assertEqual(SW.includes('c.put(e.request, copy)'), true, 'fetch 仍會回填快取（第一次用到之後就有離線版本）');

// ===== 2. 已點檢清單改用輕量路由 =====
const { ctx } = loadGasFile(GS_PATH);
ctx.ensureMonth('11508');
const rec = (id, code) => ({
  id: id, month: '11508', time: '2026-08-26 10:00', dept: '一部', section: '北一課',
  empId: 'A1', staffName: '甲', storeCode: code, storeName: code + '店', storeType: '可拍照',
  total: 90, grade: '合格', staffCount: '1', identity: '店長', note: '',
  detail: {}, observation: {}, photos: { 'k': ['a.jpg'] }, paperPhotos: [],
});
/**
 * 2026-09-04 起一併回傳店名。
 * 門市會重新編號（2026-09 有 13 家），只比店號的話改號後那家店會重新變成
 * 「可點檢」而被重複點檢，且沒有任何提示。店名是這時唯一還可靠的鍵。
 * 多讀一欄不違背這支存在的理由 —— 它要避免的是「為了一個欄位讀整張活頁」。
 *
 * 註：這裡的假資料 storeName 是 code + '店'，而 normName 會砍掉尾字「店」，
 * 所以正規化後的店名剛好等於原始店號（帶前導零），不是巧合也不是錯誤。
 */
assertEqual(ctx.getInspectedCodes('11508'), { codes: [], names: [] }, '沒有紀錄時回空陣列');
ctx.submitRecord(rec('R1', '025129'));
ctx.submitRecord(rec('R2', '019962'));
assertEqual(ctx.getInspectedCodes('11508'), { codes: ['25129', '19962'], names: ['025129', '019962'] },
  '店號去前導0、店名去尾字「店」（兩者都已正規化，前端可直接比對）');
assertEqual(ctx.getInspectedCodes('11599'), { codes: [], names: [] }, '沒有該月活頁時回空，不可拋錯');
// 回傳量要遠小於整包紀錄 —— 這就是這一項的目的
const light = JSON.stringify(ctx.getInspectedCodes('11508')).length;
const heavy = JSON.stringify({ records: ctx.queryRecords('11508', {}) }).length;
assertEqual(light < heavy / 5, true, `輕量路由要小一個量級（${light} vs ${heavy}）`);
assertEqual(GS.includes('getInspectedCodes: function () { return getInspectedCodes(p.month); },'), true, '要有路由');
assertEqual(/getInspectedCodes: \(month\) => call\('getInspectedCodes'/.test(API), true, 'api.js 要有這一支');
// 前端要用它，且舊版後端要能退回舊做法
assertEqual(APP.includes('SqcApi.getInspectedCodes(mo)'), true, '前端改用輕量路由');
assertEqual(APP.includes("(/未知動作/.test(e.message || '') ? viaRecords() : Promise.reject(e))"), true,
  '舊版後端沒這支時要退回 queryRecords，不可讓防重複機制失效');

// ===== 4. 照片分享移到背景 =====
assertEqual(/function attachPhotoLinks\(month, recordId, links, deferShare\)/.test(GS), true, 'attachPhotoLinks 要能跳過分享');
assertEqual(GS.includes('if (deferShare === true) {'), true, 'deferShare 時不做分享');
assertEqual(GS.includes('return { ok: true, deferredShare: true, pending: photoPendingCount(photos) };'), true,
  '要回報「分享已延後」，前端才知道要另外呼叫');
assertEqual(GS.includes('function sharePhotoLinks(links) {'), true, '要有獨立的分享路由');
assertEqual(GS.includes('sharePhotoLinks: function () { return sharePhotoLinks(p.links); },'), true, '要註冊路由');
assertEqual(UP.includes('attachPhotoLinks(month, recordId, links, true)'), true, '上傳器要帶 deferShare');
// 順序很重要：先標記 linked 再分享，且不等它
// （標記動作現在是 released(p, 'linked') —— 那支同時把 blob/thumb 卸掉，
//   因為完成的照片留在本機只是白佔配額，見 uploader.js 的 released()）
const idxLinked = UP.indexOf("safeUpdate(released(p, 'linked'))");
const idxShare = UP.indexOf('SqcApi.sharePhotoLinks(links)');
assertEqual(idxLinked > 0 && idxShare > idxLinked, true, '要先標記 linked 才分享（分享失敗不該讓照片回到未完成）');
assertEqual(UP.includes('window.SqcApi.sharePhotoLinks(links).catch(() => { });'), true, '分享不等它、失敗也不影響流程');
assertEqual(UP.includes('if (res && res.deferredShare) {'), true, '只有後端真的延後了才需要補呼叫（舊版後端已同步分享）');
// 舊版前端不帶參數時必須照舊同步分享，否則後端先更新會讓照片沒被分享
assertEqual(/deferShare === true/.test(GS), true, '必須是「明確要求才延後」，預設仍同步分享');

// ===== 5. ssBook 不再每次 openById =====
assertEqual(GS.includes('var _book = null;'), true, '要有快取變數');
assertEqual(/function ssBook\(\) \{\s*\n\s*if \(!_book\) _book = SpreadsheetApp\.openById\(SPREADSHEET_ID\);/.test(GS), true,
  'ssBook 要快取');
// 全檔只能有一處 openById（在 ssBook 裡）。原本有三處直接呼叫，繞過快取等於白做。
assertEqual((GS.match(/SpreadsheetApp\.openById\(SPREADSHEET_ID\)/g) || []).length, 1,
  'openById 只能出現在 ssBook 裡，其他地方一律走 ssBook()');
const SETUP = fs.readFileSync(path.join(__dirname, '..', 'setup.gs'), 'utf8');
assertEqual(SETUP.includes('if (!_ss) _ss = SpreadsheetApp.openById(SPREADSHEET_ID);'), true,
  'setup.gs 的 ss() 也要快取（repairPhotoLinks 現在是 App 會呼叫的路由）');

// ===== 3. submitRecord 只讀需要的欄位（別再把整張表含大 JSON 讀進來）=====
const sub = /function submitRecord\(rec\) \{[\s\S]*?\n\}/.exec(GS);
assertEqual(!!sub, true, '應能找到 submitRecord');
// 只比對實際呼叫，不要比對到註解裡提到的字（第一版斷言就踩到這個）
assertEqual(/\bsh\.getDataRange\(\)/.test(sub[0]), false, 'submitRecord 不可再用 getDataRange（會把明細/照片JSON 全讀進來）');
assertEqual(sub[0].includes("sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues()"), true, '只讀紀錄ID 那一欄');
assertEqual(sub[0].includes("sh.getRange(2, storeCol + 1, lastRow - 1, 1).getValues()"), true, '只讀店號那一欄');
assertEqual(sub[0].includes('sh.getRange(dupAt + 2, 1, 1, head.length).getValues()[0]'), true,
  '只有真的重複時才讀那一列的細節');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
