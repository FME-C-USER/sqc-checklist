// 極簡 GAS 執行環境模擬（只做到能跑 submitRecord 及其呼叫鏈需要的程度）
const vm = require('vm');
const fs = require('fs');

function makeFakeSheet(name) {
  return {
    name,
    rows: [],
    getLastRow() { return this.rows.length; },
    getLastColumn() { return this.rows[0] ? this.rows[0].length : 0; },
    getDataRange() { return makeRange(this, 1, 1, this.rows.length, this.getLastColumn()); },
    getRange(r, c, numRows, numCols) { return makeRange(this, r, c, numRows || 1, numCols || 1); },
    appendRow(arr) { this.rows.push(arr.slice()); },
    setFrozenRows() { return this; },
    deleteRow(r) { this.rows.splice(r - 1, 1); },
  };
}
function makeRange(sheet, r, c, numRows, numCols) {
  return {
    getValues() {
      const out = [];
      for (let i = 0; i < numRows; i++) {
        const row = sheet.rows[r - 1 + i] || [];
        const line = [];
        for (let j = 0; j < numCols; j++) line.push(row[c - 1 + j] != null ? row[c - 1 + j] : '');
        out.push(line);
      }
      return out;
    },
    setValues(values) {
      for (let i = 0; i < values.length; i++) {
        const rowIdx = r - 1 + i;
        while (sheet.rows.length <= rowIdx) sheet.rows.push([]);
        for (let j = 0; j < values[i].length; j++) sheet.rows[rowIdx][c - 1 + j] = values[i][j];
      }
      return this;
    },
    setValue(value) {
      const rowIdx = r - 1;
      while (sheet.rows.length <= rowIdx) sheet.rows.push([]);
      sheet.rows[rowIdx][c - 1] = value;
      return this;
    },
    setFontWeight() { return this; },
    setBackground() { return this; },
    setFontColor() { return this; },
    setNumberFormat() { return this; },
  };
}
function makeFakeBook() {
  const sheets = {};
  return {
    sheets,
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) { const sh = makeFakeSheet(name); sheets[name] = sh; return sh; },
    getSheets() { return Object.values(sheets); },
  };
}

/** 載入指定路徑的 程式碼.gs 原始碼，回傳 { ctx, book }：ctx 是已載入函式的沙盒 global */
function loadGasFile(gsPath) {
  const book = makeFakeBook();
  const sandbox = {
    console,
    SpreadsheetApp: {
      openById() { return book; },
      flush() {},
    },
    LockService: {
      getScriptLock() { return { waitLock() {}, releaseLock() {} }; },
    },
    Utilities: {
      getUuid() { sandbox.__uuidSeq = (sandbox.__uuidSeq || 0) + 1; return 'uuid-' + sandbox.__uuidSeq; },
      formatDate(date, tz, fmt) { return '2026-07-31 23:00'; },
    },
    PropertiesService: {
      getScriptProperties() {
        const store = {};
        return { getProperty: (k) => store[k] || null, setProperty: (k, v) => { store[k] = v; } };
      },
    },
    DriveApp: {}, ScriptApp: {}, CacheService: {}, UrlFetchApp: {}, ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: {} },
    HtmlService: {},
    // 真實 GAS 一定有 Logger；後端多處用它記錄維護/失敗訊息，假環境也要有
    Logger: { log: (m) => { sandbox.__logs = (sandbox.__logs || []).concat(String(m)); } },
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(gsPath, 'utf8');
  vm.runInContext(src, sandbox, { filename: gsPath });
  return { ctx: sandbox, book };
}

/**
 * 打樁，但先確認被打樁的函式「在正式碼裡真的存在」。
 *
 * 為什麼需要這道檢查：2026-08-27 發現 repairRecordPhotos 呼叫的 ensureFolderId
 * 整個專案都沒有定義，正式環境一執行就 ReferenceError；而測試不但沒抓到，反而是
 * 測試自己 `ctx.ensureFolderId = ...` 憑空補了一支，把「依賴不存在」偽裝成「依賴正常」。
 * 打樁天生會遮蔽這件事，所以打樁前一定要先驗證對象存在。
 *
 * 注意不能只看 ctx：Apps Script 的所有 .gs 共用同一個全域範圍，
 * 但假環境一次只載入一個檔，所以跨檔的函式（例如 setup.gs 的 folderIdOfPath_）
 * 不會出現在 ctx 裡。因此改為掃 backend/*.gs 的原始碼判斷。
 */
const path = require('path');
let _definedNames = null;
function definedInGsSources() {
  if (_definedNames) return _definedNames;
  const dir = path.join(__dirname, '..');
  _definedNames = new Set();
  fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    let m;
    const re = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = re.exec(src))) _definedNames.add(m[1]);
  });
  return _definedNames;
}

function stubExisting(ctx, name, fn) {
  if (!definedInGsSources().has(name)) {
    throw new Error(
      '打樁對象在正式碼裡不存在：' + name + '\n' +
      '  backend/*.gs 裡沒有 function ' + name + '(...)。\n' +
      '  若是改名漏改，請修正正式碼；不要在測試裡憑空補一支，那會讓正式環境的 ReferenceError 被遮掉。'
    );
  }
  ctx[name] = fn;
}

module.exports = { loadGasFile, makeFakeSheet, stubExisting };
