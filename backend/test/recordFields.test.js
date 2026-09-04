/**
 * 回歸測試：查詢紀錄清單只能用「映射真的產生出來的欄位」。
 *
 * 2026-08-31 使用者回報「跨週刪除功能無效」。原因是刪除按鈕寫成
 *   delRecord(r.id, r.version, r.time)
 * 但 loadRecords 的映射產生的是 { id, date, store, section, staff, version,
 * total, grade, pendingPhotos, _raw } —— 沒有 time。
 *
 * 於是 r.time 是 undefined → 前端 isCrossWeek(undefined) 判成「同一週」
 * → 不問密碼就送出 → 後端正確擋下 → 使用者只看到
 * 「需輸入正確密碼才能修改或刪除」，卻永遠沒有輸入密碼的機會。
 * （編輯沒事，因為 openEdit 走的是 row._raw || row。）
 *
 * 這種錯誤完全靜默：JS 讀不存在的屬性只會得到 undefined，不會拋錯，
 * Babel 也編譯得過。所以用掃描把它擋住。
 *
 * 執行方式：node backend/test/recordFields.test.js
 */
const fs = require('fs');
const path = require('path');

let failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : `\n  預期: ${JSON.stringify(expected)}\n  實際: ${JSON.stringify(actual)}`));
  if (!ok) failed++;
}

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');

/**
 * 去掉註解後再掃。
 * 一定要做這一步：說明「原本錯在 r.time」的註解本身就含有 r.time，
 * 不去掉的話掃描器會命中自己的註解，永遠報告修不好。
 * 只處理 /* *\/ 區塊與「整行只有 //」的情形 ——
 * 用一般的 // 規則會把字串裡的 https:// 之後整行吃掉。
 *
 * ★ 不要再試圖「一次抓整個 JSX 註解」。原本第一步是
 *   /\{\s*\/\*[\s\S]*?\*\/\s*\}/ ，那是錯的：非貪婪比對到第一個 *\/ 之後
 *   若接不上 } ，正規引擎會回溯去找下一個 *\/} —— 於是從某個
 *   `=> {` 開頭的箭頭函式一路吃到幾千行之後。
 *   2026-09-03 就是這樣：新加的 `.catch(e => {` 緊接一段 JSDoc 註解，
 *   讓它一口吞掉 14,541 個字元，害三條無關的斷言假失敗。
 *   單純拿掉 /* *\/ 就夠了；殘留的空 { } 對掃描無害，
 *   而且千萬不要順手清掉 —— 有的測試會把去註解後的原始碼實際執行，
 *   把 `catch (e) {}` 清成 `catch (e)` 是語法錯誤。
 */
function stripComments(src) {
  const out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return out.split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
}

/** 取出 setRecords(all.map(x => ({ ... }))) 產生的欄位名 */
function mappedFields(src) {
  const i = src.indexOf('setRecords(all.map(x => ({');
  if (i < 0) throw new Error('找不到 loadRecords 的映射');
  const j = src.indexOf('})));', i);
  return Array.from(new Set((src.slice(i, j).match(/(\w+):/g) || []).map((s) => s.slice(0, -1))));
}

/** 取出 {filtered.map(r => ( ... )} 區塊內用到的 r.X */
function usedFields(src, marker) {
  const k = src.indexOf(marker);
  if (k < 0) throw new Error('找不到清單區塊：' + marker);
  let depth = 0, m = k;
  for (; m < src.length; m++) {
    if (src[m] === '(') depth++;
    else if (src[m] === ')') { depth--; if (depth === 0) break; }
  }
  return Array.from(new Set((src.slice(k, m).match(/\br\.(\w+)/g) || []).map((s) => s.slice(2))));
}

const SRC = stripComments(APP);
const fields = mappedFields(SRC);

// 前提：確認掃描器真的抓到了東西，否則下面全部會「假通過」
assertEqual(fields.indexOf('date') >= 0 && fields.indexOf('version') >= 0, true, '前提：應能解析出映射欄位');
assertEqual(fields.indexOf('_raw') >= 0, true, '前提：映射要保留 _raw（未映射的原始紀錄）');
assertEqual(fields.indexOf('time') < 0, true,
  '前提：映射刻意沒有 time —— 完整時間只在 _raw 裡（清單顯示只需要日期）');

// ===== ★ 清單裡用到的每一個欄位都必須真的存在 =====
['{filtered.map(r => (', '<tbody>{filtered.map(r => <tr'].forEach((marker) => {
  const used = usedFields(SRC, marker);
  assertEqual(used.length > 0, true, '應能解析出用到的欄位：' + marker.slice(0, 24));
  const missing = used.filter((u) => fields.indexOf(u) < 0);
  assertEqual(missing, [],
    '★ 這些欄位映射根本沒產生，讀出來會是 undefined 而且不會拋錯：' + marker.slice(0, 24));
});

// ===== 跨週保護的兩個入口都要拿到真的時間 =====
assertEqual(/delRecord\(r\.id, r\.version, \(r\._raw \|\| r\)\.time\)/.test(SRC), true,
  '★ 刪除要從 _raw 取點檢時間（映射後的物件沒有 time）');
assertEqual(/const rec = row\._raw \|\| row;/.test(SRC), true, '編輯也是走 _raw');
assertEqual(/askCrossWeekPass\(rec\.time, '編輯'\)/.test(SRC), true, '編輯用 rec.time');
assertEqual(/const pass = await askCrossWeekPass\(recTime, '刪除'\)/.test(SRC), true, '刪除要先問密碼');

// ===== isCrossWeek 對「拿不到日期」是放行的，所以上面那件事才會這麼致命 =====
//   放行本身是刻意的（日期解析不出來時不要誤鎖住使用者），
//   但正因為它靜默放行，傳錯欄位就不會有任何警訊 —— 只能靠掃描擋。
assertEqual(/if \(s\.length !== 10\) return '';/.test(SRC), true,
  '前提：weekMondayOf 對非法日期回空字串');
assertEqual(/return !!w && w !== weekMondayOf\(taipeiToday\(\)\);/.test(SRC), true,
  '前提：isCrossWeek 在拿不到週一時回 false（放行）');

console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 全部通過');
process.exit(failed ? 1 : 0);
