// 回歸測試：門市名單改為「分開、精簡」地載入
//   起因（2026-08-26）：開場的 getBootstrap 一併搬 1500+ 家店（近 200KB、伺服器端六次整表
//   讀取），常常撞上逾時 → 畫面顯示載入失敗，其實只是太慢。
//   對策兩件：
//     C 分兩段 —— 題庫/觀察題/人員先回（1~2 秒畫面就能用），名單另一支 API 在背景補
//     A 精簡格式 —— 「欄位名一次 + 每列一個陣列」，並砍掉前端沒用到的三欄
//   相容性要求：舊版前端不會帶 light 參數，必須照舊拿到完整資料；
//   舊版後端不認得 getStoreList，前端要能靠 getBootstrap 仍帶回的名單運作。
// 執行方式：node backend/test/storeListSplit.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'api.js'), 'utf8');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const { ctx } = loadGasFile(GS_PATH);
ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.ensureMonth('11508');
const ros = (code, name, section, type) => ({
  店號: code, 店名: name, 課別: section, 店鋪型態: type,
  遠程店: '否', 假日店: 'V', 預排梯次: '第二梯',
});
ctx.upsertRow('roster', '11508', ros('025129', '基隆新大慶店', '北三課', '一般店'));
ctx.upsertRow('roster', '11508', ros('019962', '基隆樂利店', '訓練課', '隨盤點點檢店'));

// ===== 1. 精簡格式：欄位名一次、每列一個陣列，且不含前端沒用到的欄位 =====
const list = ctx.getStoreList('11508', '');
assertEqual(list.cols, ['code', 'name', 'section', 'type'], '只回前端真正用到的四欄');
assertEqual(list.cols.indexOf('remote'), -1, 'remote 前端沒用到，不傳');
assertEqual(list.cols.indexOf('holiday'), -1, 'holiday 前端沒用到，不傳');
assertEqual(list.cols.indexOf('batch'), -1, 'batch 前端沒用到，不傳');
assertEqual(list.rows, [
  ['025129', '基隆新大慶店', '北三課', '一般店'],
  ['019962', '基隆樂利店', '訓練課', '隨盤點點檢店'],
], '每列是陣列（省掉重複 1500 次的鍵名）');
assertEqual(ctx.getStoreList('11508', '訓練課').rows.length, 1, '可依課別過濾（目前前端傳空字串取全部）');
assertEqual(ctx.getStoreList('11599', '').rows, [], '沒有該月活頁時回空陣列，不可拋錯');

// 體積要真的有省下來
const compact = JSON.stringify(list).length;
const verbose = JSON.stringify(ctx.getStores('11508', '')).length;
assertEqual(compact < verbose, true, `精簡格式要比物件格式小（精簡 ${compact} < 物件 ${verbose}）`);

// ===== 2. getBootstrap 的 light 參數（雙向相容）=====
const full = ctx.getBootstrap('11508', '');            // 舊版前端：不帶參數
assertEqual(full.stores.length, 2, '不帶 light 時照舊回完整名單（舊版前端不會壞）');
const lightBoot = ctx.getBootstrap('11508', '', true); // 新版前端
assertEqual(lightBoot.stores, [], 'light=true 時不回名單');
assertEqual(lightBoot.checklist !== undefined && lightBoot.staffs !== undefined && lightBoot.depts !== undefined, true,
  'light 只省名單，其他照舊回');
assertEqual(lightBoot.gasVersion, full.gasVersion, '版本號兩種模式都要回（前端靠它判斷後端版本）');
assertEqual(ctx.getBootstrap('11508', '', false).stores.length, 2, 'light=false 等同不帶');

// ===== 3. 路由與用戶端 =====
const GS = fs.readFileSync(GS_PATH, 'utf8');
assertEqual(GS.includes('getStoreList: function () { return getStoreList(p.month, p.section); },'), true, '要有 getStoreList 路由');
assertEqual(GS.includes('getBootstrap(p.month, p.section, p.light === true)'), true, 'getBootstrap 要接 light');
assertEqual(/getStoreList: \(month, section\) => call\('getStoreList'/.test(API), true, 'api.js 要有 getStoreList');
assertEqual(/getStoreList: 45000/.test(API), true, 'getStoreList 是重的動作，要有較長的逾時');

// ===== 4. 前端：還原、背景載入、月份防護 =====
const m = /const expandStores = \(r\) => \{[\s\S]*?\n      \};/.exec(APP);
assertEqual(!!m, true, '應能找到 expandStores');
const sb = {};
vm.createContext(sb);
vm.runInContext(m[0] + '; this.fn = expandStores;', sb);
const expandStores = sb.fn;
assertEqual(expandStores(list), [
  { code: '025129', name: '基隆新大慶店', section: '北三課', type: '一般店' },
  { code: '019962', name: '基隆樂利店', section: '訓練課', type: '隨盤點點檢店' },
], '照 cols 還原成物件');
assertEqual(expandStores(null), [], 'null 不可爆掉');
assertEqual(expandStores({ cols: [], rows: [] }), [], '空資料');
// cols 由後端決定 → 日後增減欄位不必兩邊一起改
assertEqual(expandStores({ cols: ['code', 'x'], rows: [['1', 'y']] }), [{ code: '1', x: 'y' }],
  '欄位順序與名稱都以 cols 為準，不可寫死');

assertEqual(APP.includes("SqcApi.getBootstrap(mo, '', true)"), true, '開場用 light 模式');
assertEqual(APP.includes('if (!hasStores) loadStores(mo)'), true, '後端沒帶名單才另外抓（舊版後端仍會帶，就不必多打一次）');
assertEqual(APP.includes('const hasStores = !!(b.stores && b.stores.length);'), true, '要判斷後端有沒有帶名單');
// 切月份時前一個月的名單可能晚到
assertEqual(APP.includes("const storesReq = useRef('');"), true, '要記住現在要的是哪個月');
assertEqual(APP.includes("if (storesReq.current !== mo) return [];"), true, '月份已變就丟掉這份結果');
// 名單也要進快取，下次開 App 才能立刻畫出來
assertEqual(APP.includes('if (c && c.b) writeBootCache(mo, { ...c.b, stores });'), true, '名單要併回快取');
assertEqual(APP.includes('if (cached.b.stores && cached.b.stores.length) setStoresState({ loaded: true, err: \'\' });'), true,
  '快取裡有名單就算已載入，選店不必等背景那一趟');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
