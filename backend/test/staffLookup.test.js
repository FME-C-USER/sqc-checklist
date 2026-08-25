// 回歸測試：編輯舊紀錄時不可以因為「找不到點檢人員」就把人卡在現場
//   現場回報：同事編輯完成送出後跳「找不到所選點檢人員的資料，請重新選擇「點檢人員」」。
//   兩個成因都要處理：
//     1. 工號格式不一致 —— 點檢人員活頁是文字「012345」，紀錄的員編是數字 12345，
//        嚴格字串比對就找不到人。
//     2. 該員編真的已不在名單（離職、名單重匯）—— 編輯時沿用紀錄原本存的點檢人員即可，
//        既不會誤植成登入者，也不會擋住編輯。新增紀錄時仍必須擋下。
// 執行方式：node backend/test/staffLookup.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

// ===== 1. 工號正規化 =====
const m = /const normEmp = \(v\) => [^\n]+/.exec(APP);
assertEqual(!!m, true, '應能在 app.html 找到 normEmp');
const sb = { String };
vm.createContext(sb);
vm.runInContext(m[0] + '; this.fn = normEmp;', sb);
const normEmp = sb.fn;
assertEqual(normEmp('012345'), '12345', '去掉前導0（Sheet 存成文字時常有）');
assertEqual(normEmp(12345), '12345', '數字轉字串（Sheet 存成數字時）');
assertEqual(normEmp(' A123 '), 'A123', '去頭尾空白');
assertEqual(normEmp('0'), '0', '單獨一個 0 不可被吃掉');
assertEqual(normEmp(''), '', '空值');
assertEqual(normEmp(null), '', 'null 不可變成字串 "null"');

// ===== 2. findStaff 先精準比對、再用正規化比對 =====
const f = /const findStaff = \(id\) => \{[\s\S]*?\n      \};/.exec(APP);
assertEqual(!!f, true, '應能在 app.html 找到 findStaff');
const sb2 = { String, STAFFS: [{ id: '012345', name: '甲' }, { id: 12345, name: '乙' }, { id: 'A9', name: '丙' }] };
vm.createContext(sb2);
vm.runInContext(m[0] + ';\n' + f[0] + '\nthis.fn = findStaff;', sb2);
const findStaff = sb2.fn;
assertEqual(findStaff('012345').name, '甲', '完全相同的工號優先（不可被正規化搶走）');
assertEqual(findStaff(12345).name, '乙', '數字型工號也要找得到');
assertEqual(findStaff('12345').name, '乙', '紀錄存成 12345 時要對上名單（不必在意前導0）');
assertEqual(findStaff('A9').name, '丙', '非數字工號照舊');
assertEqual(findStaff(''), undefined, '空工號不可誤中任何人');
assertEqual(findStaff('99'), undefined, '真的不存在就回 undefined');

// ===== 3. 送出時的處理：編輯沿用原紀錄、新增仍要擋 =====
assertEqual(APP.includes('setEditOrigStaff({ id: rec.empId || \'\', name: rec.staffName || \'\' })'), true,
  '進入編輯時要記下該筆原本的點檢人員');
assertEqual(/if \(!staff && isEdit && editOrigStaff/.test(APP), true,
  '只有「編輯」時才沿用原紀錄的點檢人員');
assertEqual(/String\(editOrigStaff\.id\) === String\(basic\.staffId\)/.test(APP), true,
  '必須確認使用者沒有改過員編才沿用，否則會把紀錄掛到錯的人身上');
assertEqual(APP.includes('找不到所選點檢人員的資料（員編'), true,
  '真的要擋下時，訊息要帶出員編才查得出是哪一筆資料有問題');

console.log(failed === 0 ? '\n✅ 全部通過' : `\n❌ ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
