/**
 * SQC 評核系統 — Google Sheet 初始化腳本
 * ------------------------------------------------------------
 * 用途：一次建立/補齊所有活頁與表頭。可重複執行（已存在的不會重建）。
 *
 * 使用方式：
 *   1. 於 Apps Script 編輯器貼上本檔（或 clasp push）
 *   2. 執行 setupAll()  → 建立常駐主檔 + 當月活頁（題庫/店鋪名單/點檢紀錄）
 *   3. 之後每月執行 setupMonth('11507') 建立新月份活頁
 */

// ===== 設定（你的試算表與 Drive 資料夾）=====
var SPREADSHEET_ID = '1GRZZsZRgakMGENspOxmlx96NfckC8UYOe0ipuNNEoh0';
var DRIVE_ROOT_ID  = '122nQjldImn5Zh5AUguxZF0YzobThgdc9';
var PASS_SCORE     = 85;
var CURRENT_MONTH  = '11506'; // 目前作業月份（民國年月）

// ===== 各活頁表頭定義 =====
var HEADERS = {
  '設定':      ['參數', '值'],
  '點檢人員':  ['部別', '課別', '工號', '姓名', '職稱', 'AD帳號', '角色'],
  '店鋪主檔':  ['序號', '店號', '店名', '營業本部名稱', '營業部名稱', '營業課名稱', '營業擔當', '縣市', '鄉鎮', '地址'],
  '題庫':      ['排序', '編號', '大分類', '題號名稱', '配分', '計分方式', '每項扣分', '子項清單', '規範說明'],
  '觀察題':    ['排序', '編號', '類型', '題目名稱', '選項', '顯示條件', '必填'],
  '店鋪名單':  ['店號', '店名', '課別', '店鋪型態'],
  '點檢紀錄':  ['紀錄ID', '點檢時間', '部別', '課別', '員編', '點檢人員', '店號', '店名', '店鋪型態', '備註',
               '題庫版本', '合計得分', '等第', '在店店員人數', '簽名身分別',
               '明細JSON', '觀察JSON', '照片JSON', '紙本照片', '照片資料夾',
               '同步狀態', '建立時間', '更新時間'],
};

/** 建立常駐主檔 + 當月三張活頁 */
function setupAll() {
  ensureMasters();
  setupMonth(CURRENT_MONTH);
  seedSettings();
  Logger.log('✅ setupAll 完成，月份 ' + CURRENT_MONTH);
}

/** 建立常駐主檔（設定 / 點檢人員 / 店鋪主檔） */
function ensureMasters() {
  ensureSheet('設定', HEADERS['設定']);
  ensureSheet('點檢人員', HEADERS['點檢人員']);
  ensureSheet('店鋪主檔', HEADERS['店鋪主檔']);
}

/** 建立某月份的 題庫 / 店鋪名單 / 點檢紀錄 三張活頁 */
function setupMonth(month) {
  ensureSheet('題庫_' + month, HEADERS['題庫']);
  ensureSheet('觀察題_' + month, HEADERS['觀察題']);
  ensureSheet('店鋪名單_' + month, HEADERS['店鋪名單']);
  ensureSheet('點檢紀錄_' + month, HEADERS['點檢紀錄']);
  Logger.log('✅ 已建立月份活頁：' + month);
}

/** 寫入系統參數（僅在空白時填預設） */
function seedSettings() {
  var sh = ss().getSheetByName('設定');
  if (sh.getLastRow() > 1) return;
  sh.getRange(2, 1, 3, 2).setValues([
    ['照片根資料夾ID', DRIVE_ROOT_ID],
    ['當月版本', CURRENT_MONTH],
    ['及格分數', PASS_SCORE],
  ]);
}

// ============================================================
// 一次性維護工具（於 Apps Script 編輯器手動執行，不透過網頁介面）
//   用途：清理「店號前導0被 Google Sheet 自動吃掉」的歷史資料
//   假設：本專案店號一律為 6 碼數字（如 017246）；若你的店號長度不同請先告知再執行
// ============================================================

/** 掃描 店鋪主檔 / 店鋪名單_* / 點檢紀錄_* 的「店號」欄，補回前導0並將欄位鎖定為純文字格式。
 *  執行前建議先看一次「檔案→版本記錄」目前版本，若結果不如預期可還原。
 *  執行完看 Apps Script「執行項目」的記錄檔(Logger)確認每張活頁改了幾筆。 */
function normalizeStoreCodes() {
  var book = ss();
  var sheets = book.getSheets();
  var report = [];
  sheets.forEach(function (sh) {
    var name = sh.getName();
    var isTarget = name === '店鋪主檔' || name.indexOf('店鋪名單_') === 0 || name.indexOf('點檢紀錄_') === 0;
    if (!isTarget) return;
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2) { report.push(name + '：無資料，略過'); return; }
    var head = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var col = head.indexOf('店號');
    if (col < 0) { report.push(name + '：找不到「店號」欄，略過'); return; }
    var range = sh.getRange(2, col + 1, lastRow - 1, 1);
    var values = range.getValues();
    var changed = 0;
    for (var i = 0; i < values.length; i++) {
      var raw = values[i][0];
      if (raw === '' || raw == null) continue;
      var s = String(raw).trim();
      if (/^\d+$/.test(s) && s.length < 6) {
        var padded = ('000000' + s).slice(-6);
        if (padded !== s) changed++;
        values[i][0] = padded;
      } else {
        values[i][0] = s; // 確保存成字串，非數字型別
      }
    }
    range.setNumberFormat('@'); // 欄位鎖定純文字，避免之後再被自動轉數字掉0
    range.setValues(values);
    report.push(name + '：補齊 ' + changed + ' 筆（共 ' + values.length + ' 筆）');
  });
  var msg = report.length ? report.join('\n') : '沒有找到符合的活頁';
  Logger.log(msg);
  return msg;
}

/** 檢查某月「點檢紀錄」是否有同店(店號正規化後比對)重複，列在記錄檔供人工核對刪除。
 *  用法：執行前把下面 month 改成要查的月份，執行後看 Logger 記錄檔。 */
function findDuplicateStoreRecords() {
  var month = '11507'; // ← 改成要檢查的月份
  var sh = ss().getSheetByName('點檢紀錄_' + month);
  if (!sh) { Logger.log('找不到活頁：點檢紀錄_' + month); return; }
  var data = sh.getDataRange().getValues();
  var head = data[0];
  var codeCol = head.indexOf('店號'), idCol = head.indexOf('紀錄ID'), nameCol = head.indexOf('店名'), timeCol = head.indexOf('點檢時間');
  var norm = function (c) { var s = String(c == null ? '' : c).trim(); return s.replace(/^0+(?=\d)/, ''); };
  var map = {};
  for (var i = 1; i < data.length; i++) {
    var code = norm(data[i][codeCol]);
    if (!code) continue;
    (map[code] = map[code] || []).push({ 列: i + 1, 紀錄ID: data[i][idCol], 店名: data[i][nameCol], 點檢時間: data[i][timeCol] });
  }
  var dups = [];
  Object.keys(map).forEach(function (code) { if (map[code].length > 1) dups.push({ 店號: code, 筆數: map[code].length, 明細: map[code] }); });
  Logger.log(dups.length ? JSON.stringify(dups, null, 2) : '本月無重複店號紀錄');
  return dups;
}

// ===== 工具 =====
function ss() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/** 若活頁不存在則建立並寫入表頭；已存在則只補表頭列 */
function ensureSheet(name, headers) {
  var book = ss();
  var sh = book.getSheetByName(name);
  if (!sh) sh = book.insertSheet(name);
  var firstRow = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  var isEmpty = firstRow.every(function (c) { return c === '' || c === null; });
  if (isEmpty) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#334155').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}
