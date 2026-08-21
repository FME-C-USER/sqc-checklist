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
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(gsPath, 'utf8');
  vm.runInContext(src, sandbox, { filename: gsPath });
  return { ctx: sandbox, book };
}

module.exports = { loadGasFile, makeFakeSheet };
