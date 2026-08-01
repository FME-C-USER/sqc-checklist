// 回歸測試：照片直傳 Drive 完成後回寫連結(attachPhotoLinks)
// 執行方式：node backend/test/attachPhotoLinks.test.js
const path = require('path');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const { ctx } = loadGasFile(GS_PATH);
ctx.ensureMonth('11507');
ctx.submitRecord({
  id: 'R1', month: '11507', time: '2026-07-15 10:00', dept: '一部', section: '北三課',
  empId: 'A001', staffName: '測試員', storeCode: '017246', storeName: '基隆武勝店', storeType: '可拍照',
  total: 90, grade: '合格', staffCount: '2', identity: '店長', note: '',
  detail: {}, observation: {},
  photos: { '115年07月/1.店外海報/缺失': ['017246_2026-07-15_店外海報缺失_1.jpg'] },
  paperPhotos: [],
});

// 第一批連結回寫
let r1 = ctx.attachPhotoLinks('11507', 'R1', {
  '115年07月/1.店外海報/缺失': [{ name: '017246_2026-07-15_店外海報缺失_1.jpg', fileId: 'FILE_A' }],
});
assertEqual(r1.ok, true, '第一次回寫應成功');

let recs = ctx.queryRecords('11507', {});
assertEqual(recs[0].photos['115年07月/1.店外海報/缺失'], [{ name: '017246_2026-07-15_店外海報缺失_1.jpg', fileId: 'FILE_A' }], '連結應正確寫入照片JSON');

// 第二批：不同資料夾的連結，應累加合併而非覆蓋掉第一批
let r2 = ctx.attachPhotoLinks('11507', 'R1', {
  '115年07月/2.物流籃/缺失': [{ name: '017246_2026-07-15_物流籃缺失_1.jpg', fileId: 'FILE_B' }],
});
assertEqual(r2.ok, true, '第二次回寫應成功');
recs = ctx.queryRecords('11507', {});
assertEqual(recs[0].photos['115年07月/1.店外海報/缺失'][0].fileId, 'FILE_A', '第一批連結應保留(不被第二批覆蓋)');
assertEqual(recs[0].photos['115年07月/2.物流籃/缺失'][0].fileId, 'FILE_B', '第二批連結應正確加入');

// 找不到紀錄時應回傳明確錯誤，不拋例外
let r3 = ctx.attachPhotoLinks('11507', 'NOT_EXIST', { x: [{ name: 'a.jpg', fileId: 'F' }] });
assertEqual(r3.ok, false, '找不到紀錄應回傳 ok:false');

// photoUrlOf：舊資料(純檔名字串，尚未回寫連結)應回傳空字串，不應噴錯
assertEqual(ctx.photoUrlOf('legacy_filename.jpg'), '', '純檔名(舊資料/尚未連結)應回傳空字串');
assertEqual(ctx.photoUrlOf({ name: 'a.jpg', fileId: 'FILE_A' }), 'https://drive.google.com/open?id=FILE_A', '已回寫連結應組出正確網址');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
