// 回歸測試：照片已在 Drive、但紀錄裡只剩檔名時要能補回 fileId
//   上傳完成後才會呼叫 attachPhotoLinks 回寫 fileId；若當下網路斷掉或使用者直接關頁面，
//   照片其實已經在 Drive，紀錄裡卻只有檔名 —— 編輯畫面顯示「無雲端連結」、報表也沒有連結。
//   檔名是固定規則（店號_日期_題目_序號），所以能依「資料夾＋檔名」把 fileId 找回來。
// 執行方式：node backend/test/repairRecordPhotos.test.js
const path = require('path');
// stubExisting 而不是直接指派：打樁前先確認該函式在 backend/*.gs 裡真的存在。
// 這支測試原本自己補了一個 ctx.ensureFolderId，而正式碼裡根本沒有那支函式 ——
// 邏輯驗過了，正式環境卻一執行就 ReferenceError。
const { loadGasFile, stubExisting } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const { ctx } = loadGasFile(GS_PATH);
ctx.ensureMonth('11508');

// 假的 Drive：資料夾路徑 → { 檔名: fileId }
const DRIVE = {
  '115年08月/1.店外海報/缺失': { '000001_0825_店外海報_1.jpg': 'FID_A' },
  '115年08月/重點觀察題1.【店外全景照】': { '000001_0825_店外全景_1.jpg': 'FID_B' },
  '115年08月/重點觀察題2.【櫃台全景照】': {},   // 資料夾在，但檔案真的不存在
};
let folderCalls = 0;
// folderIdOfPath_ 吃的是「資料夾/子資料夾」路徑字串（自己 split），不是陣列。
// 修復流程必須用它這種「只查不建」的版本 —— getUploadFolderId 找不到就會建資料夾、
// 還會拿 script lock，兩者在修復情境下都是錯的。
stubExisting(ctx, 'folderIdOfPath_', (pathStr) => {
  folderCalls++;
  return DRIVE[pathStr] ? 'FOLDER:' + pathStr : '';
});
stubExisting(ctx, 'findFileIdByName', (folderId, name) => {
  const k = String(folderId).replace(/^FOLDER:/, '');
  return (DRIVE[k] && DRIVE[k][name]) || '';
});
const shared = [];
stubExisting(ctx, 'shareLinkedPhotos', (links) => {
  Object.keys(links || {}).forEach(k => (links[k] || []).forEach(l => shared.push(l.fileId)));
  return { ok: shared.length, failed: 0 };
});

const rec = (id, photos) => ({
  id: id, month: '11508', time: '2026-08-25 09:00', dept: '一部', section: '北一課',
  empId: 'A1', staffName: '測試員', storeCode: '000001', storeName: '測試店', storeType: '可拍照',
  total: 90, grade: '合格', staffCount: '1', identity: '店長', note: '',
  detail: {}, observation: {}, photos: photos, paperPhotos: [],
});

// 舊格式：照片項目是純字串（只有檔名，沒有 fileId）
ctx.submitRecord(rec('R1', {
  '115年08月/1.店外海報/缺失': ['000001_0825_店外海報_1.jpg'],
  '115年08月/重點觀察題1.【店外全景照】': [{ name: '000001_0825_店外全景_1.jpg' }],   // 物件但缺 fileId
  '115年08月/重點觀察題2.【櫃台全景照】': ['000001_0825_櫃台_1.jpg'],                 // Drive 裡找不到
}));

const r = ctx.repairRecordPhotos('11508', 'R1');
assertEqual(r.ok, true, '修復應成功');
assertEqual(r.filled, 2, '找回 2 張（字串格式與缺 fileId 的物件都要處理）');
assertEqual(r.missing, 1, 'Drive 裡真的沒有的那張要回報 missing，不可假裝成功');

const back = ctx.queryRecords('11508', {}).find(x => x.id === 'R1');
assertEqual(back.photos['115年08月/1.店外海報/缺失'], [{ name: '000001_0825_店外海報_1.jpg', fileId: 'FID_A' }],
  '字串格式應被換成含 fileId 的物件');
assertEqual(back.photos['115年08月/重點觀察題1.【店外全景照】'],
  [{ name: '000001_0825_店外全景_1.jpg', fileId: 'FID_B' }], '觀察題照片同樣要補上（使用者遇到的就是這一區）');
assertEqual(back.photos['115年08月/重點觀察題2.【櫃台全景照】'], ['000001_0825_櫃台_1.jpg'],
  '找不到的維持原狀，不可寫入空的 fileId（否則縮圖會變成「無法預覽」更難查）');
assertEqual(shared.sort(), ['FID_A', 'FID_B'], '補回來的照片也要設成「知道連結就能看」');

// 已經有 fileId 的不必再查 Drive（縮圖載入是逐筆呼叫，多餘的 Drive 查詢很貴）
folderCalls = 0;
const again = ctx.repairRecordPhotos('11508', 'R1');
assertEqual(again.filled, 0, '第二次修復沒有可補的');
assertEqual(folderCalls, 1, '只會為那個「還缺 fileId」的資料夾查一次，已完成的不再查');

// 找不到紀錄要明確回報，不可安靜地成功
assertEqual(ctx.repairRecordPhotos('11508', '不存在').ok, false, '找不到紀錄應回 ok:false');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
