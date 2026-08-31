/**
 * 回歸測試：匯入官方評核表時，「其他…」子項要被轉成填寫型。
 *
 * 為什麼需要：官方表上只寫一個「其他貨架」或「其他」，但一家店可能有好幾個貨架、
 * 好幾台機器同時有缺失，每一個都要各自扣分。填寫型（`標籤:填寫`）就是讓點檢人員
 * 填入名稱、填幾個算幾個缺失 —— 10~12 題的「其他貨架」用的就是這個原則。
 *
 * 原本解析器只硬編了「其他貨架」一個字串，第13題的「其他」會被當成單一子項：
 * 不管實際有幾台機器有缺失都只扣一次，而且與文件記載的 `其他:填寫` 對不上。
 *
 * 執行方式：node backend/test/officialFormSubs.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');

/** 從 app.html 取出 officialFormToRows 的完整原始碼（數大括號找結尾） */
function pickFunction(name) {
  const start = APP.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到 ' + name);
  let i = APP.indexOf('{', start), depth = 0;
  for (; i < APP.length; i++) {
    if (APP[i] === '{') depth++;
    else if (APP[i] === '}') { depth--; if (depth === 0) return APP.slice(start, i + 1); }
  }
  throw new Error(name + ' 的大括號不平衡');
}

const sb = { String, Number, Math, Array, Object, parseFloat, JSON, RegExp };
vm.createContext(sb);
vm.runInContext(pickFunction('officialFormToRows') + '; this.officialFormToRows = officialFormToRows;', sb);
const { officialFormToRows } = sb;

/**
 * 組一份最小的「官方評核表」二維陣列。
 * 版面依 app.html 的 halves[0] = { 大分類:0, 題號名稱:1, 規範說明:2, 分數:6 }。
 */
function form(rows) {
  const head = ['大分類', '題號名稱', '評核內容與規範', '', '', '', '分數'];
  const out = [head];
  rows.forEach((r) => {
    const line = new Array(7).fill('');
    line[0] = r.cat || '';
    line[1] = r.name || '';
    line[2] = r.spec || '';
    line[6] = r.score == null ? '' : r.score;
    out.push(line);
  });
  return out;
}
const subsOf = (rows, 編號) => (rows.find((x) => x.編號 === 編號) || {}).子項清單;

// ===== 1. 第13題：沒有主詞的「其他」要正名並轉成填寫型 =====
{
  const rows = officialFormToRows(form([
    { cat: '商品陳列', name: '13.FF區商品陳列', score: 9,
      spec: 'FF區商品應充足陳列\n每項 3 分\n番薯機/馬鈴薯機/夯番麥/熱狗機/蒸包機/其他' },
  ]));
  const subs = subsOf(rows, 'B13');
  assertEqual(/其他機台:填寫$/.test(subs || ''), true,
    '★ 第13題的「其他」要變成「其他機台:填寫」（比照 10~12 題的其他貨架）');
  assertEqual((subs || '').indexOf('|其他:填寫') >= 0, false, '不可留下沒有主詞的「其他」');
  assertEqual((subs || '').split('|')[0], '番薯機', '其餘子項不可被動到');
  assertEqual((subs || '').split('|').length, 6, '子項數量不變（只是最後一項換名）');
}

// ===== 2. 10~12 題的「其他貨架」行為不變 =====
{
  const rows = officialFormToRows(form([
    { cat: '商品陳列', name: '12.價格清楚標示', score: 12,
      spec: '價格標示應清楚\n每項 2 分\nOC/WI/冷凍櫃/口巧/零食/加工/TM前貨架/其他貨架' },
  ]));
  const subs = subsOf(rows, 'B12');
  assertEqual(/其他貨架:填寫$/.test(subs || ''), true, '「其他貨架」仍要是填寫型');
  assertEqual((subs || '').indexOf('其他機台') >= 0, false, '★ 不可把「其他貨架」誤改成「其他機台」');
}

// ===== 3. ★ 正名只限第13題 =====
//   「其他」兩個字在別題可能有完全不同的意思，不可一律改成機台。
//   （這裡刻意避開 15、16、17 —— 那三題另有寫死的拆題／垃圾桶覆寫規則，
//     用它們測不到本條想測的東西。）
{
  const rows = officialFormToRows(form([
    { cat: '商品陳列', name: '11.商品排面整齊', score: 8,
      spec: '商品排面應整齊\n每項 1 分\nOC/WI/冷凍櫃/其他' },
  ]));
  const subs = subsOf(rows, 'B11');
  assertEqual((subs || '').indexOf('其他機台') >= 0, false, '★ 別題的「其他」不可被改成「其他機台」');
  assertEqual(/其他:填寫$/.test(subs || ''), true, '但仍應轉成填寫型（其他＝請填寫，語意本來就一樣）');
}

// ===== 4. 合格0分題不受影響 =====
{
  const rows = officialFormToRows(form([
    { cat: '活動告示&清潔維護', name: '1.店外海報', score: 4, spec: '海報應張貼完整、無破損' },
  ]));
  const r = rows.find((x) => x.編號 === 'A1');
  assertEqual(r.計分方式, '合格0分', '沒有「每項N分」就不是分區扣分題');
  assertEqual(r.子項清單, '', '合格0分題不應產生子項清單');
}

// ===== 5. 非官方表要回傳 null（避免把一般試算表誤判成評核表）=====
assertEqual(officialFormToRows([['店號', '店名'], ['024623', '後壁安溪店']]), null, '非官方表回傳 null');
assertEqual(officialFormToRows([]), null, '空表回傳 null');

console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
process.exit(failed ? 1 : 0);
