// 回歸測試：「紙本照片」欄不可以被寫成 [object Object]
//   現場現象：Sheet 的「紙本照片」欄在幾筆紀錄上是 [object Object]，而且都是被編輯過的那幾筆。
//   成因：這一欄存的是逗號分隔的檔名字串，而編輯既有紀錄時照片JSON 的項目是
//         {name, fileId} 物件，前端把整個陣列丟過來、後端 join(',') 就變成 [object Object]。
//   兩端都要處理：前端送出前取檔名，後端寫入前再取一次（舊版前端還在跑的機器會繼續送物件）。
// 執行方式：node backend/test/paperPhotos.test.js
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

// ===== 1. photoNamesOf：字串與物件混在一起也要只留檔名 =====
assertEqual(ctx.photoNamesOf(['a.jpg', 'b.jpg']), 'a.jpg,b.jpg', '純檔名照舊');
assertEqual(ctx.photoNamesOf([{ name: 'a.jpg', fileId: 'X' }, { name: 'b.jpg', fileId: 'Y' }]), 'a.jpg,b.jpg',
  '物件要取出 name（這就是 [object Object] 的來源）');
assertEqual(ctx.photoNamesOf(['a.jpg', { name: 'b.jpg', fileId: 'Y' }]), 'a.jpg,b.jpg', '混合格式');
assertEqual(ctx.photoNamesOf([{ fileId: 'X' }]), '', '沒有檔名的項目要丟掉，不可留下空字串');
assertEqual(ctx.photoNamesOf([]), '', '空陣列');
assertEqual(ctx.photoNamesOf(null), '', 'null 不可爆掉');

// ===== 2. 實際寫入路徑：編輯時送物件進來也不能寫爛 =====
const rec = (id, paper) => ({
  id: id, month: '11508', time: '2026-08-25 09:00', dept: '一部', section: '北一課',
  empId: 'A1', staffName: '測試員', storeCode: '000001', storeName: '測試店', storeType: '可拍照',
  total: 90, grade: '合格', staffCount: '1', identity: '店長', note: '',
  detail: {}, observation: {},
  photos: { '115年08月/SQC點檢表完成照片': paper },
  paperPhotos: paper,
});
const objForm = [{ name: '000001_2026-08-25_SQC點檢表完成照片_1.jpg', fileId: 'FID1' }];
const sh = ctx.ssBook().getSheetByName('點檢紀錄_11508');
const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
const row = ctx.recordToRow(sh, rec('R1', objForm));
assertEqual(row[head.indexOf('紙本照片')], '000001_2026-08-25_SQC點檢表完成照片_1.jpg',
  '前端送 {name,fileId} 物件時，紙本照片欄仍要是檔名');
assertEqual(String(row[head.indexOf('紙本照片')]).indexOf('[object Object]'), -1, '絕對不可出現 [object Object]');

ctx.submitRecord(rec('R1', objForm));
const back = ctx.queryRecords('11508', {}).find(x => x.id === 'R1');
assertEqual(back.paperPhotos, ['000001_2026-08-25_SQC點檢表完成照片_1.jpg'], '讀回來要能還原成檔名清單');

// 更新（就是出問題的那條路徑：編輯既有紀錄）
ctx.updateRecord('11508', 'R1', rec('R1', objForm), '');
const back2 = ctx.queryRecords('11508', {}).find(x => x.id === 'R1');
assertEqual(back2.paperPhotos, ['000001_2026-08-25_SQC點檢表完成照片_1.jpg'], '編輯後仍然是檔名清單');

// ===== 3. 前端也要在送出前取檔名（不能只靠後端；報表與離線佇列都吃這個物件）=====
assertEqual(/paperPhotos: \(photosJson\[\[monthFolder, 'SQC點檢表完成照片'\]\.join\('\/'\)\] \|\| \[\]\)[\s\S]{0,160}\.map\(e => \(e && typeof e === 'object'\) \? e\.name : e\)/.test(APP),
  true, '前端送出前要把照片項目轉成檔名');

// ===== 4. 維護專區要有整月修復的入口（不能只能靠 Apps Script 編輯器）=====
assertEqual(APP.includes('照片連結修復'), true, '維護專區應有「照片連結修復」');
assertEqual(APP.includes('SqcApi.repairPhotoLinks(repairMonth, write)'), true, '應呼叫整月修復 API');
assertEqual(/if \(!write \|\| !\(r\.touchedRows \|\| 0\)\) break;/.test(APP), true,
  '後端一次只處理 40 筆，前端要自動接續直到沒有可補的');
const gs = fs.readFileSync(GS_PATH, 'utf8');
assertEqual(/ADMIN_ONLY = \{[^}]*repairPhotoLinks: 1/.test(gs), true, '整月修復會寫入紀錄，必須限管理者');
const setupGs = fs.readFileSync(path.join(__dirname, '..', 'setup.gs'), 'utf8');
assertEqual(setupGs.includes('shared = shareLinkedPhotos(toShare)'), true,
  '補回來的照片也要設成「知道連結就能看」，否則報表收件人還是打不開');
assertEqual(setupGs.includes("indexOf('[object Object]') >= 0"), true,
  '整月修復要順便把已經寫爛的紙本照片欄還原');
// 只回報「找不到 N 張」等於沒用 —— 使用者無從知道要找哪家店重拍
assertEqual(setupGs.includes('missingList.push(where'), true, '找不到的檔案要指名到列號、店名與項目');
assertEqual(setupGs.includes('以下找不到對應檔案，需請點檢人員重新上傳'), true, '明細要明講該怎麼處理');
assertEqual(APP.includes('lines.length < 80'), true, '前端明細上限要夠大，否則「找不到」那幾行會被砍掉');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
