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
  '店鋪名單':  ['店號', '店名', '課別', '店鋪型態', '遠程店', '假日店', '預排梯次'],
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
  var rows = [
    ['照片根資料夾ID', DRIVE_ROOT_ID],
    ['當月版本', CURRENT_MONTH],
    ['及格分數', PASS_SCORE],
    // 請款單價（年度調價時直接改這裡，不需改程式）
    ['平日點檢費', 245],
    ['平日遠程加價', 220],
    ['假日點檢費', 470],
    ['假日遠程加價', 345],
    ['文件處理費', 6500],
    ['稅率', 0.05],
  ];
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
}

/** 補齊請款單價參數（設定活頁已有資料時用這支；已存在的參數不覆蓋）
 *  用法：於 Apps Script 編輯器手動執行一次 */
function addPricingSettings() {
  var sh = ss().getSheetByName('設定');
  var data = sh.getDataRange().getValues();
  var have = {};
  for (var i = 1; i < data.length; i++) have[String(data[i][0] || '').trim()] = true;
  var defaults = [
    ['平日點檢費', 245], ['平日遠程加價', 220],
    ['假日點檢費', 470], ['假日遠程加價', 345],
    ['文件處理費', 6500], ['稅率', 0.05],
  ];
  var added = defaults.filter(function (d) { return !have[d[0]]; });
  if (!added.length) { Logger.log('請款單價參數已齊全，未新增'); return '已齊全'; }
  sh.getRange(sh.getLastRow() + 1, 1, added.length, 2).setValues(added);
  var msg = '已新增：' + added.map(function (a) { return a[0] + '=' + a[1]; }).join('、');
  Logger.log(msg);
  return msg;
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

// ============================================================
// 一次性維護：清理 Drive 上「同資料夾同檔名」的重複照片
//   背景：2026-08-20 照片直傳因缺少 Origin 標頭而被瀏覽器 CORS 擋掉，但 Drive 其實
//         已寫入成功（回應 200），前端讀不到回應就每 15~60 秒重試一次 →
//         同一張照片在同一個資料夾裡被寫入很多份。
//   保留規則：優先保留「點檢紀錄的照片JSON已經引用」的那一份（避免報表連結失效），
//             沒有被引用時才保留「建立時間最早」的一份；其餘移到垃圾桶（可還原）。
//
//   用法（在 Apps Script 編輯器選函式後按執行，結果看「執行記錄」）：
//     1. reportDuplicatePhotos('115年08月')            ← 先只掃描列出，不會刪任何東西
//     2. 確認清單無誤後再執行
//        removeDuplicatePhotos('115年08月', true)      ← 實際移入垃圾桶
//   月份資料夾名稱請填照片實際存放的那一層（例如 115年08月）；
//   留空會掃整個照片根資料夾，檔案多時可能執行逾時，不建議。
// ============================================================

function reportDuplicatePhotos(monthFolderName) {
  return dupPhotos_(monthFolderName, false);
}

function removeDuplicatePhotos(monthFolderName, doDelete) {
  if (doDelete !== true) {
    Logger.log('保護機制：要實際刪除請明確傳入 true → removeDuplicatePhotos(\'115年08月\', true)');
    return dupPhotos_(monthFolderName, false);
  }
  return dupPhotos_(monthFolderName, true);
}

function dupPhotos_(monthFolderName, doDelete) {
  var start = DriveApp.getFolderById(DRIVE_ROOT_ID);
  if (monthFolderName) {
    var it = start.getFoldersByName(String(monthFolderName));
    if (!it.hasNext()) {
      Logger.log('找不到資料夾：' + monthFolderName);
      return { scanned: 0, duplicates: 0, deleted: 0, detail: [], error: '找不到資料夾：' + monthFolderName };
    }
    start = it.next();
  }

  var referenced = referencedFileIds_();   // 點檢紀錄「照片JSON」裡真的有引用到的 fileId
  var groups = {}, scanned = 0;
  walkFolderFiles_(start, start.getName(), function (file, pathStr) {
    scanned++;
    var key = pathStr + '/' + file.getName();     // 同路徑同檔名才算重複
    if (!groups[key]) groups[key] = [];
    groups[key].push(file);
  });

  var detail = [], dupCount = 0, deleted = 0;
  Object.keys(groups).sort().forEach(function (k) {
    var arr = groups[k];
    if (arr.length < 2) return;
    arr.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); }); // 最早的排前面
    // 保留哪一份：優先保留「點檢紀錄已經引用」的那一份，否則保留最早的。
    // 若固定保留最早的，紀錄裡指向較晚副本的連結會在刪除後失效。
    var keep = 0, keepReason = '最早';
    for (var i = 0; i < arr.length; i++) {
      if (referenced[arr[i].getId()]) { keep = i; keepReason = '紀錄已引用'; break; }
    }
    dupCount += arr.length - 1;
    detail.push(k + ' → ' + arr.length + ' 份，保留1份(' + keepReason + ')、處理 ' + (arr.length - 1) + ' 份');
    if (doDelete) {
      for (var j = 0; j < arr.length; j++) { if (j !== keep) { arr[j].setTrashed(true); deleted++; } }
    }
  });

  Logger.log((doDelete ? '【已移入垃圾桶】' : '【僅掃描，未刪除任何檔案】')
    + ' 範圍：' + start.getName()
    + '｜掃描檔案 ' + scanned + ' 個｜重複 ' + dupCount + ' 份'
    + (doDelete ? '｜已處理 ' + deleted + ' 份' : '')
    + (detail.length ? '\n' + detail.join('\n') : '\n（沒有發現重複檔案）'));
  return { scanned: scanned, duplicates: dupCount, deleted: deleted, detail: detail };
}

/** 遞迴走訪資料夾內所有檔案；pathStr 為「資料夾/子資料夾」相對路徑
 *  DriveApp 的迭代會包含已在垃圾桶的檔案，必須排除，否則已清掉的重複檔會被重複計算 */
function walkFolderFiles_(folder, pathStr, onFile) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (!f.isTrashed()) onFile(f, pathStr);
  }
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var sub = subs.next();
    walkFolderFiles_(sub, pathStr + '/' + sub.getName(), onFile);
  }
}

/** 收集所有「點檢紀錄_*」活頁的 照片JSON 內已引用的 fileId，
 *  清理重複檔案時據此保留「有被紀錄引用」的那一份，避免把報表看得到的連結刪掉 */
function referencedFileIds_() {
  var out = {};
  try {
    ss().getSheets().forEach(function (sh) {
      if (String(sh.getName()).indexOf('點檢紀錄_') !== 0) return;
      var data = sh.getDataRange().getValues();
      if (!data.length) return;
      var col = data[0].indexOf('照片JSON');
      if (col < 0) return;
      for (var i = 1; i < data.length; i++) {
        var raw = String(data[i][col] || '');
        if (!raw) continue;
        try {
          var obj = JSON.parse(raw);
          Object.keys(obj).forEach(function (k) {
            (obj[k] || []).forEach(function (e) { if (e && e.fileId) out[e.fileId] = 1; });
          });
        } catch (e) { /* 該列格式異常就略過 */ }
      }
    });
  } catch (e) { /* 讀不到活頁時退回「保留最早」的行為 */ }
  return out;
}

// ============================================================
// 維護：依檔名把「照片JSON 只有檔名、缺 fileId」的項目補上 Drive 連結
//   為什麼需要：紀錄剛送出時「照片JSON」只存檔名，要等前端回寫連結才會補上 fileId。
//   若回寫失敗（網路不良、紀錄ID 對不上、換裝置…），報表就永遠點不到照片。
//   這支工具直接在後端用檔名去對應資料夾查出 fileId 補回去，完全不依賴任何人的瀏覽器。
//
//   用法（在編輯器加一個 run 函式呼叫，結果看「執行記錄」）：
//     1. repairPhotoLinks('11508')            ← 只列出會補哪些，不寫入
//     2. repairPhotoLinks('11508', true)      ← 實際寫入
//   一次最多處理 MAX_ROWS 筆紀錄，避免 Apps Script 6 分鐘逾時；
//   記錄檔會告訴你這次處理到哪，重複執行即可接續（已補好的會自動跳過）。
// ============================================================
var REPAIR_MAX_ROWS = 40;

function repairPhotoLinks(month, doWrite) {
  var sh = ss().getSheetByName('點檢紀錄_' + month);
  if (!sh) { Logger.log('找不到活頁：點檢紀錄_' + month); return { error: '找不到活頁' }; }
  var data = sh.getDataRange().getValues();
  var head = data[0];
  var photoCol = head.indexOf('照片JSON');
  var idCol = head.indexOf('紀錄ID');
  var storeCol = head.indexOf('店名');
  var paperCol = head.indexOf('紙本照片');
  var syncCol = head.indexOf('同步狀態');   // 補齊後要把「照片未齊」改回「已同步」   // 編輯時曾被寫成 [object Object]，可從照片JSON還原
  if (photoCol < 0) { Logger.log('找不到「照片JSON」欄'); return { error: '找不到欄位' }; }

  var folderCache = {};
  var detail = [], touchedRows = 0, filled = 0, missing = 0, scannedRows = 0;
  var toShare = {}, paperFixed = 0;
  var missingList = [];   // 找不到的要指名到「哪一列、哪家店、哪個項目」，才知道要找誰重拍

  for (var i = 1; i < data.length; i++) {
    if (touchedRows >= REPAIR_MAX_ROWS) {
      detail.push('（已達單次上限 ' + REPAIR_MAX_ROWS + " 筆，請再執行一次接續；下一筆從第 " + (i + 1) + ' 列開始）');
      break;
    }
    var raw = String(data[i][photoCol] || '');
    if (!raw) continue;
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { detail.push('第' + (i + 1) + '列 照片JSON 格式異常，略過'); continue; }

    scannedRows++;
    var changed = false;
    Object.keys(obj).forEach(function (key) {
      var arr = obj[key] || [];
      for (var j = 0; j < arr.length; j++) {
        var e = arr[j];
        var name = typeof e === 'string' ? e : (e && e.name);
        var hasId = e && typeof e === 'object' && e.fileId;
        if (!name || hasId) continue;                     // 已經有 fileId 就跳過
        var folderId = folderCache[key];
        if (folderId === undefined) {
          folderId = folderIdOfPath_(key);
          folderCache[key] = folderId;
        }
        var where = '第' + (i + 1) + '列 ' + (storeCol >= 0 ? data[i][storeCol] : '') + '｜' + key;
        if (!folderId) { missing++; missingList.push(where + ' → 找不到資料夾（' + name + '）'); continue; }
        var fid = fileIdByNameNotTrashed_(folderId, name);
        if (!fid) { missing++; missingList.push(where + ' → Drive 沒有這個檔案（' + name + '）'); continue; }
        arr[j] = { name: name, fileId: fid };
        if (!toShare[key]) toShare[key] = [];
        toShare[key].push({ name: name, fileId: fid });   // 補回來的照片也要設成「知道連結就能看」
        changed = true; filled++;
      }
      obj[key] = arr;
    });

    if (changed) {
      touchedRows++;
      detail.push('第' + (i + 1) + '列 ' + (storeCol >= 0 ? data[i][storeCol] : '') + '（' + (idCol >= 0 ? data[i][idCol] : '') + '）→ 補上連結');
      if (doWrite === true) sh.getRange(i + 1, photoCol + 1).setValue(JSON.stringify(obj));
      if (doWrite === true && syncCol >= 0) sh.getRange(i + 1, syncCol + 1).setValue(syncStateOf(obj));
    }
    // 紙本照片欄若被寫成 [object Object]，用照片JSON 裡的檔名還原（報表不吃這欄，但重新編輯時會用到）
    if (paperCol >= 0 && String(data[i][paperCol] || '').indexOf('[object Object]') >= 0) {
      var paperKey = Object.keys(obj).filter(function (k) { return k.indexOf('SQC點檢表完成照片') >= 0; })[0];
      var names = paperKey ? photoNamesOf(obj[paperKey]) : '';
      detail.push('第' + (i + 1) + '列 紙本照片欄修正為：' + (names || '(空)'));
      paperFixed++;
      if (doWrite === true) sh.getRange(i + 1, paperCol + 1).setValue(names);
    }
  }

  if (missingList.length) {
    detail.push('--- 以下找不到對應檔案，需請點檢人員重新上傳 ---');
    missingList.slice(0, 40).forEach(function (m) { detail.push(m); });
    if (missingList.length > 40) detail.push('（另有 ' + (missingList.length - 40) + ' 筆未列出）');
  }

  // 分享要在迴圈外一次做完：迴圈內逐張呼叫 Drive 很容易撞到 6 分鐘逾時
  var shared = { ok: 0, failed: 0 };
  if (doWrite === true && filled) shared = shareLinkedPhotos(toShare);

  Logger.log((doWrite === true ? '【已寫入】' : '【僅試算，未寫入】')
    + ' 月份 ' + month
    + '｜檢查紀錄 ' + scannedRows + ' 筆｜可補連結 ' + filled + ' 張｜需異動 ' + touchedRows + ' 筆'
    + '｜Drive 找不到對應檔案 ' + missing + ' 張'
    + '｜紙本照片欄修正 ' + paperFixed + ' 筆｜已設為知道連結可看 ' + shared.ok + ' 張'
    + (detail.length ? '\n' + detail.join('\n') : '\n（沒有需要補的項目）'));
  return { scannedRows: scannedRows, filled: filled, touchedRows: touchedRows, missing: missing,
    paperFixed: paperFixed, shared: shared.ok, shareFailed: shared.failed, detail: detail };
}

/** 由「115年08月/題目/缺失」這種相對路徑找出資料夾 ID；找不到回空字串（不建立新資料夾） */
function folderIdOfPath_(pathStr) {
  var parts = String(pathStr || '').split('/').filter(function (s) { return s !== ''; });
  var folder;
  try { folder = DriveApp.getFolderById(DRIVE_ROOT_ID); } catch (e) { return ''; }
  for (var i = 0; i < parts.length; i++) {
    var it = folder.getFoldersByName(parts[i]);
    var next = null;
    while (it.hasNext()) { var cand = it.next(); if (!cand.isTrashed()) { next = cand; break; } }
    if (!next) return '';
    folder = next;
  }
  return folder.getId();
}

/** 取同名且不在垃圾桶的檔案 ID */
function fileIdByNameNotTrashed_(folderId, name) {
  try {
    var it = DriveApp.getFolderById(folderId).getFilesByName(name);
    while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) return f.getId(); }
  } catch (e) { /* 資料夾不存在 */ }
  return '';
}

// ============================================================
// 一次性維護：把既有照片設為「知道連結的人可檢視」
//   為什麼需要：報表（含客戶版）裡的照片連結，若檔案沒開放，收到報表的人必須
//   先登入有權限的 Google 帳號才看得到。新上傳的照片已由 attachPhotoLinks 自動設定，
//   這支負責補設之前累積的照片。
//
//   用法（在編輯器加一個 run 函式呼叫，結果看「執行記錄」）：
//     1. reportPhotoSharing('115年08月')          ← 只清點，不改任何權限
//     2. sharePhotosByLink('115年08月', true)     ← 實際設定
//   一次最多處理 SHARE_MAX 個檔案，避免 6 分鐘逾時；重複執行會接續（已設定的會跳過）。
//
//   注意：若公司 Workspace 政策禁止「知道連結的人」分享，這裡會全部失敗並在記錄檔
//   顯示錯誤訊息，需請資訊人員開放該政策。
// ============================================================
var SHARE_MAX = 300;

function reportPhotoSharing(monthFolderName) { return sharePhotos_(monthFolderName, false); }

function sharePhotosByLink(monthFolderName, doApply) {
  if (doApply !== true) {
    Logger.log('保護機制：要實際設定請明確傳入 true → sharePhotosByLink(\'115年08月\', true)');
    return sharePhotos_(monthFolderName, false);
  }
  return sharePhotos_(monthFolderName, true);
}

function sharePhotos_(monthFolderName, doApply) {
  var start = DriveApp.getFolderById(DRIVE_ROOT_ID);
  if (monthFolderName) {
    var it = start.getFoldersByName(String(monthFolderName));
    if (!it.hasNext()) { Logger.log('找不到資料夾：' + monthFolderName); return { error: '找不到資料夾' }; }
    start = it.next();
  }
  var scanned = 0, already = 0, changed = 0, failed = 0, lastErr = '', stopped = false;
  walkFolderFiles_(start, start.getName(), function (file) {
    if (stopped) return;
    if (changed >= SHARE_MAX) { stopped = true; return; }
    scanned++;
    try {
      if (file.getSharingAccess() === DriveApp.Access.ANYONE_WITH_LINK) { already++; return; }
      if (doApply) { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); changed++; }
      else changed++;   // 清點模式：只計算「需要設定的數量」
    } catch (e) { failed++; lastErr = String(e && e.message || e); }
  });
  Logger.log((doApply ? '【已設定為知道連結可檢視】' : '【僅清點，未變更權限】')
    + ' 範圍：' + start.getName()
    + '｜掃描 ' + scanned + ' 個｜原本已開放 ' + already + ' 個｜'
    + (doApply ? '本次設定 ' : '待設定 ') + changed + ' 個｜失敗 ' + failed + ' 個'
    + (stopped ? '（已達單次上限 ' + SHARE_MAX + '，請再執行一次接續）' : '')
    + (failed ? '\n最後一個錯誤：' + lastErr + '\n若是政策限制，請請資訊人員開放「知道連結的人」分享' : ''));
  return { scanned: scanned, already: already, changed: changed, failed: failed, truncated: stopped };
}
