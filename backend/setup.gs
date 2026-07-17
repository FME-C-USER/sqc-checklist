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
  '店鋪主檔':  ['店號', '店名', '課別', '店鋪型態'],
  '題庫':      ['排序', '編號', '大分類', '題號名稱', '配分', '計分方式', '每項扣分', '子項清單', '規範說明'],
  '觀察題':    ['排序', '編號', '類型', '題目名稱', '選項', '顯示條件', '必填'],
  '店鋪名單':  ['店號', '店名', '課別', '店鋪型態'],
  '點檢紀錄':  ['紀錄ID', '點檢時間', '部別', '課別', '員編', '點檢人員', '店號', '店名', '店鋪型態',
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
