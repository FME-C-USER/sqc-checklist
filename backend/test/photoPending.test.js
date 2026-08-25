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

// ===== 5. 前端：標記、篩選、上傳進度畫面、持久化儲存 =====
assertEqual(APP.includes('pendingPhotos: Number(x.pendingPhotos) || 0'), true, '查詢結果要帶入未齊張數');
assertEqual(APP.includes('只看照片未齊'), true, '查詢紀錄要能篩選出未齊的紀錄');
assertEqual(APP.includes('r.pendingPhotos > 0 && <span'), true, '清單列要有紅色標記');
assertEqual(/setPostSubmit\(\{ store: storeName/.test(APP), true, '送出後要進上傳進度畫面');
assertEqual(APP.includes("const postDone = !!postSubmit && !((pendingUp.unfinished || 0) + (pendingUp.queuedRecords || 0))"), true,
  '照片與待送紀錄都清空才算完成');
assertEqual(APP.includes("SqcApi.logEvent('leaveWithPendingPhotos'"), true, '選擇提前離開要記軌跡');
assertEqual(APP.includes('navigator.storage.persist()'), true, '要向瀏覽器要求持久化儲存（iOS 會回收網站資料）');
// 出口必須存在：門市訊號差時硬擋會讓人做不完事情
assertEqual(APP.includes('我知道風險，稍後再傳'), true, '必須留一個出口，不可硬擋死');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
