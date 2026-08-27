// 回歸測試：重送同一筆紀錄不可被誤判成「同店已有紀錄」
//   現場（2026-08-26）：同事只按一次上傳，等了很久卻被告知「這家店本月已有其他人送出點檢紀錄」，
//   而查詢紀錄顯示那筆就是他自己幾分鐘前送出的。
//   成因：api.js 的 call() 對逾時一律自動重送（submitRecord 是 12 秒 × 4 次），
//   而後端 submitRecord 先檢查「同店是否已有紀錄」、才用 rec.id 寫入 ——
//   第一次其實寫入成功但回應沒在 12 秒內回來，用戶端重送，第二次就撞到自己剛寫的那一列。
//   對策：先檢查「同一個紀錄ID 是否已存在」，是同一筆就回成功（等冪），並帶 resent 供前端說明。
//   順序不可顛倒：若邊掃邊回 DUPLICATE，同 ID 的那一列排在後面就永遠看不到。
// 執行方式：node backend/test/submitIdempotent.test.js
const path = require('path');
const fs2 = require('fs');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const { ctx } = loadGasFile(GS_PATH);
ctx.ensureMonth('11508');
const rec = (id, code, name, staff, time) => ({
  id: id, month: '11508', time: time || '2026-08-26 10:00', dept: '一部', section: '北一課',
  empId: 'A1', staffName: staff || '甲', storeCode: code, storeName: name, storeType: '可拍照',
  total: 90, grade: '合格', staffCount: '1', identity: '店長', note: '',
  detail: {}, observation: {}, photos: {}, paperPhotos: [],
});
const countRows = () => ctx.queryRecords('11508', {}).length;

// ===== 1. 第一次送出：正常成功 =====
const r1 = ctx.submitRecord(rec('REC_A', '000001', 'A店', '林秀真'));
assertEqual(r1.ok, true, '第一次送出成功');
assertEqual(r1.id, 'REC_A', '回傳前端帶上來的紀錄ID');
assertEqual(!!r1.resent, false, '第一次不是重送');
assertEqual(countRows(), 1, '寫入一列');

// ===== 2. 重送同一筆（回應遺失後 api.js 自動重試）=====
const r2 = ctx.submitRecord(rec('REC_A', '000001', 'A店', '林秀真'));
assertEqual(r2.ok, true, '重送同一筆要回成功，不可回 DUPLICATE');
assertEqual(r2.resent, true, '要標明是重送被確認，前端才能說明「先前的回應遺失」');
assertEqual(r2.id, 'REC_A', '回同一個紀錄ID');
assertEqual(countRows(), 1, '不可變成兩列');

// 連續重送多次（最壞情況：四次嘗試都逾時後又靠佇列重送）
ctx.submitRecord(rec('REC_A', '000001', 'A店', '林秀真'));
ctx.submitRecord(rec('REC_A', '000001', 'A店', '林秀真'));
assertEqual(countRows(), 1, '重送幾次都只有一列');

// ===== 3. 真的重複（不同紀錄ID、同一家店）=====
const r3 = ctx.submitRecord(rec('REC_B', '000001', 'A店', '陳紀源'));
assertEqual(r3.ok, false, '不同紀錄ID、同一家店 → 才是真的重複');
assertEqual(r3.code, 'DUPLICATE', '要回 DUPLICATE 供前端提示');
assertEqual(countRows(), 1, '被擋下時不可寫入');
// 訊息要帶出「誰、什麼時候」，才知道要找誰確認
assertEqual(r3.message.indexOf('林秀真') >= 0, true, '訊息要帶出是誰送的');
assertEqual(r3.message.indexOf('2026-08-26') >= 0, true, '訊息要帶出日期');
assertEqual(r3.message.indexOf('其他人') < 0, true,
  '不可寫死「其他人」—— 也可能是自己在另一台裝置送的，講死反而誤導');

// ===== 4. 順序：同 ID 的列排在同店那一列「後面」時也要判成重送 =====
//   這是最容易寫錯的地方：邊掃邊回 DUPLICATE 就永遠看不到後面那一列
ctx.ensureMonth('11509');
ctx.submitRecord(Object.assign(rec('REC_X', '000009', 'X店', '甲'), { month: '11509' }));   // 第 1 列：同店
ctx.submitRecord(Object.assign(rec('REC_Y', '000008', 'Y店', '甲'), { month: '11509' }));   // 第 2 列
// 現在重送 REC_Y（它的店號與第 1 列不同，但若把 REC_Y 的店號改成 000009 就會先撞到第 1 列）
const r4 = ctx.submitRecord(Object.assign(rec('REC_Y', '000009', 'Y店', '甲'), { month: '11509' }));
assertEqual(r4.ok, true, '同 ID 排在後面也要判成重送（不可先回 DUPLICATE）');
assertEqual(r4.resent, true, '仍要標明是重送');
assertEqual(ctx.queryRecords('11509', {}).length, 2, '不可新增列');

// ===== 5. 沒有帶紀錄ID 時的行為不變（後端自己產生）=====
ctx.ensureMonth('11510');
const r5 = ctx.submitRecord(Object.assign(rec('', '000007', 'Z店', '甲'), { month: '11510' }));
assertEqual(r5.ok, true, '沒帶 ID 也要能送出');
assertEqual(typeof r5.id === 'string' && r5.id.length > 0, true, '後端自己產生 ID');
assertEqual(!!r5.resent, false, '不是重送');

// ===== 6. 不同店照舊可以送 =====
const r6 = ctx.submitRecord(rec('REC_C', '000002', 'B店', '甲'));
assertEqual(r6.ok, true, '不同店不受影響');
assertEqual(countRows(), 2, '正常新增一列');

// ===== 7. 前端要把「重送被確認」當成成功並說明原因 =====
const APP = fs2.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
assertEqual(APP.includes('result && result.resent'), true, '前端要判斷 resent');
assertEqual(APP.includes('先前的回應在網路上遺失，已確認資料只有一筆'), true,
  '要向使用者說明為什麼等這麼久，而且資料沒有變成兩筆');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
