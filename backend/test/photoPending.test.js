// 回歸測試：「照片未齊」要在當天就看得見
//   起因（使用者 2026-08-25）：報表照片欄空白，是因為照片只存在點檢人員那一台裝置上，
//   人離開、裝置失聯就再也兌現不了。硬擋住送出不可行（門市訊號常常很差），
//   所以做三件事：
//     C 主管當天就看得到「照片未齊」→ 這支測試
//     B 送出後擋在上傳進度畫面，唯一的出口要留下軌跡
//     D 向瀏覽器要求持久化儲存，降低資料被回收的機率
// 執行方式：node backend/test/photoPending.test.js
const fs = require('fs');
const path = require('path');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const { ctx } = loadGasFile(GS_PATH);
// logEvent 有每小時次數限制，需要 CacheService
const _cache = {};
ctx.CacheService = { getScriptCache: () => ({ put: (k, v) => { _cache[k] = String(v); }, get: (k) => (k in _cache ? _cache[k] : null), remove: (k) => { delete _cache[k]; } }) };
ctx.ensureMonth('11508');

// ===== 1. 計算未齊張數 =====
const P = ctx.photoPendingCount;
assertEqual(P({}), 0, '沒有照片＝沒有未齊');
assertEqual(P(null), 0, 'null 不可爆掉');
assertEqual(P({ a: [{ name: 'x.jpg', fileId: 'F1' }] }), 0, '有 fileId 就是齊了');
assertEqual(P({ a: ['x.jpg'] }), 1, '只有檔名（剛送出、還在手機佇列裡）算未齊');
assertEqual(P({ a: [{ name: 'x.jpg' }] }), 1, '物件但缺 fileId 也算未齊');
assertEqual(P({ a: ['x.jpg', { name: 'y.jpg', fileId: 'F' }], b: ['z.jpg'] }), 2, '跨多個項目累加');
assertEqual(P({ a: [{ fileId: 'F' }] }), 0, '沒有檔名的雜項不計（不是待傳的照片）');

// ===== 2. 同步狀態欄要反映實情（原本寫死「已同步」等於騙人）=====
assertEqual(ctx.syncStateOf({ a: [{ name: 'x.jpg', fileId: 'F' }] }), '已同步', '齊了就是已同步');
assertEqual(ctx.syncStateOf({ a: ['x.jpg', 'y.jpg'] }), '照片未齊（缺2張）', '未齊要寫出缺幾張');
assertEqual(ctx.syncStateOf({}), '已同步', '沒有照片的紀錄不算未齊');

// ===== 3. 送出→回寫連結 的整段流程 =====
const rec = (id, photos) => ({
  id: id, month: '11508', time: '2026-08-25 09:00', dept: '一部', section: '北一課',
  empId: 'A1', staffName: '測試員', storeCode: '000001', storeName: '測試店', storeType: '可拍照',
  total: 90, grade: '合格', staffCount: '1', identity: '店長', note: '',
  detail: {}, observation: {}, photos: photos, paperPhotos: [],
});
const KEY = '115年08月/1.店外海報/缺失';
ctx.submitRecord(rec('R1', { [KEY]: ['a.jpg', 'b.jpg'] }));
const sh = ctx.ssBook().getSheetByName('點檢紀錄_11508');
const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
const rowOf = (id) => {
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) if (String(data[i][head.indexOf('紀錄ID')]) === id) return data[i];
  return null;
};
assertEqual(rowOf('R1')[head.indexOf('同步狀態')], '照片未齊（缺2張）', '剛送出時照片還沒上傳，狀態就該是未齊');
assertEqual(ctx.queryRecords('11508', {}).find(r => r.id === 'R1').pendingPhotos, 2, '查詢要帶出未齊張數供前端標記');

ctx.shareLinkedPhotos = () => ({ ok: 1, failed: 0 });
ctx.attachPhotoLinks('11508', 'R1', { [KEY]: [{ name: 'a.jpg', fileId: 'F_A' }] });
assertEqual(rowOf('R1')[head.indexOf('同步狀態')], '照片未齊（缺1張）', '補一張後剩一張');
ctx.attachPhotoLinks('11508', 'R1', { [KEY]: [{ name: 'b.jpg', fileId: 'F_B' }] });
assertEqual(rowOf('R1')[head.indexOf('同步狀態')], '已同步', '全部補齊才改回已同步');
assertEqual(ctx.queryRecords('11508', {}).find(r => r.id === 'R1').pendingPhotos, 0, '補齊後不再標記');

// 舊紀錄那一欄寫死「已同步」，所以查詢一定要現算，不可沿用欄位值
const bad = rowOf('R1');
sh.getRange(2, head.indexOf('同步狀態') + 1).setValue('已同步');
sh.getRange(2, head.indexOf('照片JSON') + 1).setValue(JSON.stringify({ [KEY]: ['c.jpg'] }));
assertEqual(ctx.queryRecords('11508', {}).find(r => r.id === 'R1').pendingPhotos, 1,
  '欄位寫著「已同步」但照片JSON 其實缺連結時，仍要算出未齊（舊紀錄就是這種）');

// ===== 4. logEvent：只允許白名單事件 =====
assertEqual(ctx.logEvent('leaveWithPendingPhotos', 'A店：還有 3 張未上傳', '測試員').ok, true, '白名單事件可記錄');
assertEqual(ctx.logEvent('anythingElse', 'x', '測試員').ok, false,
  '未列白名單的事件要拒絕（否則任何登入者都能往異動紀錄塞任意文字）');
const log = ctx.getChangeLog(10).rows;
assertEqual(log.some(r => r.action === '照片未傳完即離開'), true, '離開的決定要留在異動紀錄裡');
assertEqual(log.some(r => r.action === 'anythingElse'), false, '被拒絕的事件不可寫入');
// 這是前端可任意呼叫的寫入點，沒有上限就能把異動紀錄淹掉（2026-08-26 掃描發現）
const before = ctx.getChangeLog(500).rows.length;
for (let i = 0; i < ctx.LOGEVENT_MAX_PER_HOUR + 5; i++) ctx.logEvent('leaveWithPendingPhotos', 'spam' + i, 'flooder');
const after = ctx.getChangeLog(500).rows.length;
assertEqual(after - before, ctx.LOGEVENT_MAX_PER_HOUR, '同一使用者每小時最多寫入上限筆數，超過的略過');
assertEqual(ctx.logEvent('leaveWithPendingPhotos', 'x', 'flooder').ok, false, '超過上限後回 ok:false');
assertEqual(ctx.logEvent('leaveWithPendingPhotos', 'x', '另一個人').ok, true, '上限只針對該使用者，不影響其他人');
// 長度要截斷，避免單筆塞進超長內容
ctx.logEvent('leaveWithPendingPhotos', 'A'.repeat(900), '長度測試');
assertEqual(ctx.getChangeLog(1).rows[0].note.length, 500, '說明欄截到 500 字');

// ===== 5. 前端：標記、篩選、上傳進度畫面、持久化儲存 =====
assertEqual(APP.includes('pendingPhotos: Number(x.pendingPhotos) || 0'), true, '查詢結果要帶入未齊張數');
assertEqual(APP.includes('只看照片未齊'), true, '查詢紀錄要能篩選出未齊的紀錄');
assertEqual(APP.includes('r.pendingPhotos > 0 && <span'), true, '清單列要有紅色標記');
// 進度畫面不再每家店都彈：緩衝期內傳完只顯示一行提示，還沒完成才擋人
assertEqual(APP.includes('const POST_GRACE_MS = 4000;'), true, '要有送出後的緩衝期');
assertEqual(/if \(c\.pending \|\| c\.done\) \{ setPostSubmit\(info\); return; \}/.test(APP), true,
  '緩衝期後仍有未完成才彈進度畫面');
assertEqual(/setToast\(c\.orphan[\s\S]{0,200}張照片已全部完成/.test(APP), true, '傳完只顯示一行提示，不再彈畫面');
// 完成判斷只看「這一筆」，且 orphan 不可被當成沒事
assertEqual(APP.includes('const postDone = !!postStat && postStat.pending === 0 && postStat.done === 0;'), true,
  '完成判斷只看本筆的 pending 與 done（全域數字會被別筆污染）');
assertEqual(APP.includes('SqcUploader.countsOfRecord(postRecId)'), true, '要向 uploader 查本筆的狀態');
assertEqual(/if \(!postDone \|\| !postStat \|\| postStat\.orphan\) return;/.test(APP), true,
  '有需要人工處理的照片時不可自動關閉，要讓人看到');
assertEqual(APP.includes('已上傳，但有照片需人工處理'), true, 'orphan 要明講，不可顯示成「全部完成」');
assertEqual(APP.includes("SqcApi.logEvent('leaveWithPendingPhotos'"), true, '選擇提前離開要記軌跡');
assertEqual(APP.includes('navigator.storage.persist()'), true, '要向瀏覽器要求持久化儲存（iOS 會回收網站資料）');
// 出口必須存在：門市訊號差時硬擋會讓人做不完事情
assertEqual(APP.includes('我知道風險，稍後再傳'), true, '必須留一個出口，不可硬擋死');

// ===== 6. 「立即重試」不可以是空操作（現場回報按不動）=====
const UP = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'uploader.js'), 'utf8');
assertEqual(/if \(_running\) \{ _again = true; emit\(\); return; \}/.test(UP), true,
  '正在跑時要記下待重跑，不可直接 return（原本按了毫無反應）');
assertEqual(/do \{ _again = false; await pumpOnce\(\); \} while \(_again && navigator\.onLine\)/.test(UP), true,
  '跑完要接著把待重跑的那一輪跑掉');
assertEqual(UP.includes('async function clearBackoff(recordId)'), true, 'force 要能清掉退避時間');
assertEqual(/nextAt: 0, linkNextAt: 0/.test(UP), true, '上傳退避與連結回寫退避都要清');
assertEqual(UP.includes('busy: _running'), true, '要對外回報忙碌狀態，按鈕才有回饋');
// 不寫死顆數（2026-08-28 又多了診斷視窗裡的一顆），改成表達真正的意圖：
// 畫面上每一顆「立即重試」都必須帶忙碌狀態。原本正在跑時按下去毫無反應，像壞掉。
{
  const all = (APP.match(/'立即重試'/g) || []).length;
  const withBusy = (APP.match(/pendingUp\.busy \? '正在重試…' : '立即重試'/g) || []).length;
  assertEqual(withBusy >= 2, true, '至少要有進度畫面與橫幅兩顆重試按鈕，實際 ' + withBusy);
  assertEqual(all, withBusy, '每一顆「立即重試」都要帶忙碌狀態，不可有裸的（總共 ' + all + ' 顆、帶狀態 ' + withBusy + ' 顆）');
}
assertEqual((APP.match(/SqcUploader\.pump\(\{ force: true/g) || []).length >= 3, true,
  '重試與送出後的踢一次都要用 force（否則還是要等退避結束）');
// 送出成功後立刻踢一次：照片比紀錄早傳完時第一次回寫必然失敗，不踢就要等 15 秒的輪詢
assertEqual(/SqcUploader\.pump\(\{ force: true, recordId: recId \}\);/.test(APP), true,
  '紀錄寫入後端後要立刻踢一次上傳');

// ===== 6b. 照片傳完後「缺 N 張」要自己消失（現場 2026-08-26 回報）=====
//   那個數字是後端從照片JSON 現算的；回寫連結成功的瞬間伺服器就已經是對的，
//   但前端手上的清單是上一次查詢的快照，不重查就會一直掛著紅字。
assertEqual(APP.includes('const prevUnfinished = useRef(null);'), true, '要記住上一次的待處理張數才知道有沒有變少');
assertEqual(/if \(prev === null \|\| cur >= prev\) return;/.test(APP), true,
  '只在佇列「變少」時刷新（歸零才刷會等太久：其他筆可能還在傳）');
assertEqual(/if \(!pendingCount\) return;/.test(APP), true, '畫面上沒有紅字就不必打擾後端');
assertEqual(/setTimeout\(\(\) => loadRecords\(true\), 1500\)/.test(APP), true, '稍等一下再查，留餘裕給後端寫完');
// 背景刷新必須沿用上一次查詢的條件，否則使用者改了日期還沒按查詢時會被偷偷換掉
assertEqual(APP.includes('const appliedFilter = useRef(null);'), true, '要記住這份清單是用哪組條件查的');
// 2026-08-27 改為 silent === true 嚴格比對：原本的 (useApplied && ...) 會被 click 事件物件
// 騙過去，按「查詢」時沿用上一次的條件、使用者剛改的日期被忽略。詳見 queryFilter.test.js。
assertEqual(APP.includes('const silent = useApplied === true;'), true,
  '要用 === true 嚴格比對（truthy 判斷會被 click 事件物件騙過）');
assertEqual(APP.includes('const src = (silent && appliedFilter.current) || filter;'), true,
  '背景刷新用已套用的條件，手動查詢用當下的條件');
// 背景刷新不可彈視窗、不可閃進度條 —— 使用者沒按查詢，跳「查詢失敗」只會讓人以為自己做錯事
assertEqual(APP.includes('if (!silent) setQueryLoading(true);'), true, '背景刷新不顯示進度條');
assertEqual(APP.includes("catch(e => { if (!silent) alert('查詢失敗：' + e.message); })"), true,
  '背景刷新失敗不彈視窗');
// 送出後自動關閉那條路徑也要刷新（原本只有手動按「關閉」才刷）
assertEqual(/setPostSubmit\(null\);\s*\n\s*loadRecords\(true\);/.test(APP), true, '自動關閉時順手刷新清單');

// ===== 7. 數字的說法不可以誤導 =====
//   done 的照片檔案已經在雲端硬碟，只差回寫連結；跟 pending 合稱「未完成／待上傳」會讓人以為傳不上去
assertEqual(APP.includes('待上傳 <b className="text-red-600">'), false, '不可再用「待上傳」稱呼 pending+done');
assertEqual(APP.includes('照片未完成 <b>'), false, '橫幅不可再用「照片未完成」合稱');
assertEqual(APP.includes('已上傳、等寫入連結'), true, 'done 要單獨講清楚');
assertEqual(APP.includes('postStat.uploaded'), true, '進度條的分子要用「已在雲端硬碟的張數」');
assertEqual(UP.includes("uploaded: by.done + by.linked + by.orphan"), true,
  'uploaded 要含 done/linked/orphan（三者的檔案都已在雲端硬碟）');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
