// 回歸測試：登入節流（2026-08 資安檢測 Medium 項目）
//   Web App 對外開放且 login 不需權杖，沒有節流就等於提供一支對公司 AD 做
//   密碼噴灑/暴力破解的代理（AD 端看到的來源 IP 還全是 Google 的伺服器）。
//   要求：帳密/AD 被拒絕才計次，達上限後直接擋下、不再打 AD；
//        服務本身異常(998/999)不可計次，否則驗證服務出問題會鎖住正常使用者。
// 執行方式：node backend/test/loginThrottle.test.js
const path = require('path');
const vm = require('vm');
const fs = require('fs');
const { loadGasFile } = require('./gas-fake-env');

const GS_PATH = path.join(__dirname, '..', '程式碼.gs');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const { ctx } = loadGasFile(GS_PATH);
// 假的 CacheService（含 remove，節流靠它記次）
const cache = {};
const puts = [];
ctx.CacheService = {
  getScriptCache: () => ({
    put: (k, v, ttl) => { cache[k] = String(v); puts.push({ k, v: String(v), ttl }); },
    get: (k) => (k in cache ? cache[k] : null),
    remove: (k) => { delete cache[k]; },
  }),
};
// 可切換回傳碼的假驗證服務，並記錄實際被呼叫幾次
let authCode = '100';
let authCalls = 0;
ctx.UrlFetchApp = {
  fetch: () => { authCalls++; return { getContentText: () => JSON.stringify({ MSG: authCode + ' MSG' }) }; },
};
vm.runInContext(fs.readFileSync(GS_PATH, 'utf8'), ctx, { filename: GS_PATH });
ctx.ensureSheetNamed('設定', ['參數', '值']);
ctx.upsertRow('staff', null, { 部別: '業務部', 課別: '業務課', 工號: '1', 姓名: '林秀真', AD帳號: 'jolin', 角色: '管理者' });

// ===== 1. 密碼錯誤會計次，並提示剩餘次數 =====
authCode = '100';
const r1 = ctx.login('jolin', 'bad');
assertEqual(r1.ok, false, '密碼錯誤應失敗');
assertEqual(r1.message.indexOf('帳號或密碼錯誤') >= 0, true, '應顯示帳密錯誤');
assertEqual(r1.message.indexOf('再失敗 4 次') >= 0, true, '應提示還剩幾次，讓使用者知道快被鎖了');
assertEqual(authCalls, 1, '未達上限時仍會去問 AD');

// ===== 2. 達上限後直接擋下，不再打 AD =====
for (let i = 0; i < 4; i++) ctx.login('jolin', 'bad');
assertEqual(authCalls, 5, '前 5 次都會問 AD');
const blocked = ctx.login('jolin', 'bad');
assertEqual(blocked.code, 'THROTTLED', '第 6 次應被節流擋下');
assertEqual(blocked.message.indexOf('15 分鐘') >= 0, true, '應告知要等多久');
assertEqual(authCalls, 5, '被擋下時不可再去打 AD（這是節流的重點）');

// 被鎖定期間即使密碼正確也擋（避免用正確密碼探測帳號是否存在）
authCode = '000';
assertEqual(ctx.login('jolin', 'good').code, 'THROTTLED', '鎖定期間即使密碼正確也應擋下');
assertEqual(authCalls, 5, '鎖定期間一律不打 AD');

// ===== 3. 鎖定是「按帳號」計，不可波及其他人 =====
authCode = '000';
ctx.upsertRow('staff', null, { 部別: '一部', 課別: '北一課', 工號: '2', 姓名: '趙千皓', AD帳號: 'zhao', 角色: '' });
const other = ctx.login('zhao', 'good');
assertEqual(other.ok, true, '別的帳號不受影響（不可全公司一起被鎖）');
assertEqual(authCalls, 6, '別的帳號會正常問 AD');

// ===== 4. 登入成功要把計數歸零 =====
delete cache['loginfail_jolin'];            // 模擬 15 分鐘後過期
authCode = '100';
ctx.login('jolin', 'bad');
ctx.login('jolin', 'bad');
assertEqual(Number(cache['loginfail_jolin']), 2, '失敗次數應累加');
authCode = '000';
assertEqual(ctx.login('jolin', 'good').ok, true, '密碼正確應可登入');
assertEqual(cache['loginfail_jolin'], undefined, '成功登入後計數要歸零');

// ===== 5. 服務異常不可計次（否則驗證服務出問題會鎖住所有人）=====
authCode = '998';
ctx.login('jolin', 'x'); ctx.login('jolin', 'x'); ctx.login('jolin', 'x');
ctx.login('jolin', 'x'); ctx.login('jolin', 'x'); ctx.login('jolin', 'x');
assertEqual(cache['loginfail_jolin'], undefined, '998 資料庫異常不可計入節流');
authCode = '999';
ctx.login('jolin', 'x');
assertEqual(cache['loginfail_jolin'], undefined, '999 其他錯誤不可計入節流');
authCode = '000';
assertEqual(ctx.login('jolin', 'good').ok, true, '服務恢復後應可正常登入，不該被誤鎖');

// ===== 6. 空白帳密不計次也不打 AD =====
const before = authCalls;
assertEqual(ctx.login('', 'x').ok, false, '空白帳號應擋下');
assertEqual(ctx.login('jolin', '').ok, false, '空白密碼應擋下');
assertEqual(authCalls, before, '空白輸入不應打 AD');
assertEqual(cache['loginfail_jolin'], undefined, '空白輸入不應計次');

// ===== 7. 封鎖時間設定 =====
const ttl = (puts.filter(p => p.k === 'loginfail_jolin').pop() || {}).ttl;
assertEqual(ttl, 900, '計數的存活時間應為 900 秒（15 分鐘）');

// ===== 8. 代碼 200 的訊息要能讓使用者知道怎麼處理 =====
delete cache['loginfail_jolin'];
authCode = '200';
const ad = ctx.login('jolin', 'x');
assertEqual(ad.message.indexOf('鎖定') >= 0 && ad.message.indexOf('EIP') >= 0, true,
  'AD 認證錯誤(200) 應說明可能原因與處置，不能只寫「AD 認證錯誤」');
assertEqual(Number(cache['loginfail_jolin']), 1, '200 屬帳號類拒絕，要計入節流');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
