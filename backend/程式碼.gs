/**
 * SQC 評核系統 — GAS 後端 API
 * ------------------------------------------------------------
 * 前端以 google.script.run 呼叫下列函式。照片由前端「直傳 Drive」
 * （用 getDriveToken() 取得的權杖），本檔只負責資料夾建立與資料表存取。
 *
 * 設定與活頁結構見 setup.gs / 資料結構_GoogleSheet.md
 */

var SPREADSHEET_ID = '1GRZZsZRgakMGENspOxmlx96NfckC8UYOe0ipuNNEoh0';
var DRIVE_ROOT_ID  = '122nQjldImn5Zh5AUguxZF0YzobThgdc9';
var AUTH_API       = 'https://eip.fme.com.tw/FMEIP/AasApi/CheckUserId';

// ============================================================
// 入口：JSON API（前端 PWA 於 GitHub Pages，以 fetch 跨網域呼叫）
// 前端送 POST，Content-Type: text/plain（避開 CORS 預檢），body = {action, payload}
// ============================================================
function doGet() {
  return json({ ok: true, service: 'SQC API', time: nowStr() });
}

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = req.action;
    var p = req.payload || {};

    // ===== 授權閘門：除 login 外皆需有效 token；管理動作再驗管理者 =====
    var OPEN = { login: 1 };
    var ADMIN_ONLY = { importMaster: 1, upsertItem: 1, deleteItem: 1, upsertRow: 1, deleteRow: 1, getMaster: 1 };
    if (!OPEN[action]) {
      var sess = getSession(req.token);
      if (!sess) return json({ ok: false, code: 'AUTH', error: '未登入或連線逾時，請重新登入' });
      if (ADMIN_ONLY[action] && sess.role !== '管理者') return json({ ok: false, error: '此功能需管理者權限' });
    }

    var routes = {
      login: function () { return login(p.userId, p.password); },
      getBootstrap: function () { return getBootstrap(p.month, p.section); },
      getDriveToken: function () { return { token: getDriveToken() }; },
      getUploadFolderId: function () { return { folderId: getUploadFolderId(p.pathParts) }; },
      submitRecord: function () { return submitRecord(p.record); },
      queryRecords: function () { return { records: queryRecords(p.month, p.filter) }; },
      updateRecord: function () { return updateRecord(p.month, p.id, p.record); },
      deleteRecord: function () { return deleteRecord(p.month, p.id); },
      getSummary: function () { return getSummary(p.month, p.filter); },
      importMaster: function () { return importMaster(p.kind, p.month, p.rows, p.fileName); },
      upsertItem: function () { return upsertItem(p.month, p.item); },
      deleteItem: function () { return deleteItem(p.month, p.id); },
      upsertRow: function () { return upsertRow(p.kind, p.month, p.row); },
      deleteRow: function () { return deleteRowByKind(p.kind, p.month, p.id); },
      getMaster: function () { return { rows: readSheet(sheetForKind(p.kind, p.month)) }; },
    };
    if (!routes[action]) return json({ ok: false, error: '未知動作：' + action });
    return json({ ok: true, result: routes[action]() });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 登入（伺服器端呼叫 CheckUserId，避免前端 CORS）
// ============================================================
function login(userId, password) {
  userId = String(userId || '').slice(0, 15);
  password = String(password || '').slice(0, 30);
  if (!userId || !password) return { ok: false, message: '請輸入帳號與密碼' };

  var code = '999';
  try {
    var res = UrlFetchApp.fetch(AUTH_API, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ USER_ID: userId, PSW: password }),
      muteHttpExceptions: true,
    });
    var data = JSON.parse(res.getContentText() || '{}');
    code = String(data.MSG || '999').split(' ')[0];
  } catch (e) {
    return { ok: false, message: '無法連線驗證服務，請稍後再試' };
  }

  var errMap = { '100': '帳號或密碼錯誤', '200': 'AD 認證錯誤', '998': '系統暫時無法使用，請稍後再試', '999': '系統發生錯誤，請聯絡管理員' };
  if (code !== '000') return { ok: false, message: errMap[code] || errMap['999'] };

  // 以 AD 比對名冊取角色：比對到＝帶出角色/姓名；比對不到＝一般點檢員（進系統後自行選取姓名）
  var staff = findStaffByAd(userId) || { empId: '', name: '', dept: '', section: '', role: '點檢員', ad: userId };
  staff.token = issueToken(staff, userId);
  return { ok: true, user: staff };
}

// ===== 登入 token（伺服器端授權；存 CacheService，效期 6 小時）=====
function issueToken(staff, ad) {
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('sess_' + token,
    JSON.stringify({ role: staff.role || '點檢員', name: staff.name, empId: staff.empId, ad: ad }), 21600);
  return token;
}
function getSession(token) {
  if (!token) return null;
  var c = CacheService.getScriptCache().get('sess_' + token);
  return c ? JSON.parse(c) : null;
}

function findStaffByAd(ad) {
  var rows = readSheet('點檢人員');
  ad = String(ad).toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i]['AD帳號'] || '').toLowerCase() === ad) {
      return {
        empId: rows[i]['工號'], name: rows[i]['姓名'], dept: rows[i]['部別'], title: rows[i]['職稱'],
        section: rows[i]['課別'], role: rows[i]['角色'] || '點檢員', ad: rows[i]['AD帳號'],
      };
    }
  }
  return null;
}

// ============================================================
// 開場資料：當月題庫 + 店鋪名單(依課別) + 設定
// ============================================================
function getBootstrap(month, section) {
  return {
    month: month,
    passScore: Number(getSetting('及格分數') || 85),
    checklist: getChecklist(month),
    observations: getObservations(month),
    stores: getStores(month, section),
    // 點檢人員下拉：只帶「有填部別或課別」的人員（純管理者未填部/課者不列入下拉，但仍可登入）
    staffs: readSheet('點檢人員').filter(function (r) {
      return String(r['部別'] || '').trim() !== '' || String(r['課別'] || '').trim() !== '';
    }).map(function (r) {
      return { empId: r['工號'], name: r['姓名'], dept: r['部別'], section: r['課別'], title: r['職稱'] };
    }),
    depts: distinctDepts(),
  };
}

function getChecklist(month) {
  var rows = readSheet('題庫_' + month);
  return rows.map(function (r) {
    var type = String(r['計分方式']).indexOf('分區') >= 0 ? 'subdeduct' : 'deduct';
    var item = {
      id: r['編號'], name: r['題號名稱'], cat: r['大分類'],
      max: Number(r['配分']) || 0, type: type, desc: r['規範說明'] || '', order: Number(r['排序']) || 0,
      perPoint: Number(r['每項扣分']) || 0, subsRaw: r['子項清單'] || '',
    };
    if (type === 'subdeduct') item.subs = parseSubs(r['子項清單']);
    return item;
  }).sort(function (a, b) { return a.order - b.order; });
}

/** 子項編碼解析：以 | 分隔；label:2=units、label:填寫=custom、label（說明）=note */
function parseSubs(raw) {
  if (!raw) return [];
  return String(raw).split('|').map(function (tok) {
    tok = tok.trim();
    var note = '';
    var nm = tok.match(/（([^）]*)）\s*$/);
    if (nm) { note = nm[1]; tok = tok.replace(/（[^）]*）\s*$/, '').trim(); }
    var parts = tok.split(':');
    var label = parts[0].trim();
    var flag = (parts[1] || '').trim();
    var sub = { label: label };
    if (flag === '填寫') sub.custom = true;
    else if (flag && !isNaN(Number(flag))) sub.units = Number(flag);
    if (note) sub.note = note;
    return sub;
  });
}

// 觀察題（分月）→ 分成 拍照/有無/符合 三組回前端
function getObservations(month) {
  var rows = readSheet('觀察題_' + month).sort(function (a, b) { return (Number(a['排序']) || 0) - (Number(b['排序']) || 0); });
  var key = [], toilet = [], inspect = [];
  rows.forEach(function (r) {
    var t = String(r['類型'] || '');
    var id = r['編號'], name = r['題目名稱'];
    if (t.indexOf('拍照') >= 0) key.push({ id: id, name: name, required: (String(r['必填']) === '是' || String(r['必填']).toUpperCase() === 'Y') });
    else if (t.indexOf('符合') >= 0) inspect.push({ id: id, name: name });
    else toilet.push({ id: id, name: name, opts: String(r['選項'] || '有|無').split('|'), show: String(r['顯示條件'] || 'always') });
  });
  return { keyObservations: key, toiletObservations: toilet, toiletInspect: inspect };
}

function getStores(month, section) {
  var rows = readSheet('店鋪名單_' + month);
  return rows.filter(function (r) {
    return !section || String(r['課別']) === String(section);
  }).map(function (r) {
    return { code: r['店號'], name: r['店名'], section: r['課別'], can_photo: String(r['店鋪型態']).indexOf('無法') < 0 };
  });
}

// ============================================================
// Drive：發權杖 + 建立/快取資料夾（供前端直傳）
// ============================================================
function getDriveToken() {
  return ScriptApp.getOAuthToken();
}

/** 依 [月份, 題目, 區域...] 取得目標資料夾 ID（自動建立、Script Properties 快取） */
function getUploadFolderId(pathParts) {
  var props = PropertiesService.getScriptProperties();
  var key = 'folder:' + pathParts.join('/');
  var cached = props.getProperty(key);
  if (cached) {
    try { DriveApp.getFolderById(cached); return cached; } catch (e) { /* 失效重建 */ }
  }
  var folder = DriveApp.getFolderById(DRIVE_ROOT_ID);
  for (var i = 0; i < pathParts.length; i++) {
    folder = getOrCreateChild(folder, pathParts[i]);
  }
  props.setProperty(key, folder.getId());
  return folder.getId();
}

function getOrCreateChild(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// ============================================================
// 點檢紀錄：送出 / 查詢 / 修改 / 刪除（皆只操作當月活頁）
// ============================================================
function submitRecord(rec) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheetName = '點檢紀錄_' + rec.month;
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(sheetName);
    if (!sh) throw new Error('找不到活頁：' + sheetName);
    var id = rec.id || (Utilities.getUuid());
    var now = nowStr();
    var row = recordToRow(sh, Object.assign({}, rec, { id: id, createdAt: now, updatedAt: now }));
    sh.appendRow(row);
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

function queryRecords(month, filter) {
  filter = filter || {};
  var rows = readSheet('點檢紀錄_' + month);
  return rows.filter(function (r) {
    var d = toYmd(r['點檢時間']);
    if (filter.from && d < filter.from) return false;
    if (filter.to && d > filter.to) return false;
    if (filter.section && String(r['課別']) !== filter.section) return false;
    if (filter.empId && String(r['員編']) !== filter.empId) return false;
    return true;
  }).map(rowToRecord);
}

function updateRecord(month, id, rec) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('點檢紀錄_' + month);
    var data = sh.getDataRange().getValues();
    var head = data[0];
    var idCol = head.indexOf('紀錄ID');
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(id)) {
        var merged = Object.assign(rowObj(head, data[i]), rec, { updatedAt: nowStr() });
        // 用中文欄鍵覆寫
        var newRow = recordToRow(sh, mapToInternal(merged, month, id));
        sh.getRange(i + 1, 1, 1, newRow.length).setValues([newRow]);
        return { ok: true };
      }
    }
    return { ok: false, message: '找不到紀錄' };
  } finally {
    lock.releaseLock();
  }
}

function deleteRecord(month, id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('點檢紀錄_' + month);
    var data = sh.getDataRange().getValues();
    var idCol = data[0].indexOf('紀錄ID');
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(id)) { sh.deleteRow(i + 1); return { ok: true }; }
    }
    return { ok: false, message: '找不到紀錄' };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 彙總（依起訖日期 + 課別；回執行店數與明細）
// ============================================================
function getSummary(month, filter) {
  var recs = queryRecords(month, filter);
  var pass = Number(getSetting('及格分數') || 85);
  return {
    count: recs.length,
    avg: recs.length ? Math.round(recs.reduce(function (s, r) { return s + Number(r.total || 0); }, 0) / recs.length) : 0,
    passRate: recs.length ? Math.round(recs.filter(function (r) { return Number(r.total) >= pass; }).length / recs.length * 100) : 0,
    records: recs,
  };
}

// ============================================================
// 維護專區：匯入（前端解析檔案後傳 rows；同名覆蓋＝整表以最新取代）
// ============================================================
function importMaster(kind, month, rows, fileName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var map = {
      'staff': '點檢人員', 'stores': '店鋪主檔',
      'roster': '店鋪名單_' + month, 'checklist': '題庫_' + month, 'obs': '觀察題_' + month,
    };
    var name = map[kind];
    if (!name) throw new Error('未知匯入類型：' + kind);
    var book = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sh = book.getSheetByName(name);
    if (!sh) throw new Error('找不到活頁：' + name + '，請先執行 setupMonth');
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    // 清空舊資料（保留表頭）→ 以最新上傳為主
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, head.length).clearContent();
    var out = rows.map(function (r) { return head.map(function (h) { return r[h] != null ? r[h] : ''; }); });
    if (out.length) sh.getRange(2, 1, out.length, head.length).setValues(out);
    setSetting('匯入_' + kind, (fileName || '') + ' @ ' + nowStr());
    return { ok: true, count: out.length };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 題庫單題 新增/修改/刪除（item 以中文表頭為鍵）
// ============================================================
function upsertItem(month, item) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = ssBook().getSheetByName('題庫_' + month);
    if (!sh) throw new Error('找不到活頁：題庫_' + month);
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var row = head.map(function (h) { return item[h] != null ? item[h] : ''; });
    var data = sh.getDataRange().getValues();
    var idCol = head.indexOf('編號');
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(item['編號'])) {
        sh.getRange(i + 1, 1, 1, head.length).setValues([row]);
        return { ok: true, mode: 'update' };
      }
    }
    sh.appendRow(row);
    return { ok: true, mode: 'add' };
  } finally { lock.releaseLock(); }
}

function deleteItem(month, id) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = ssBook().getSheetByName('題庫_' + month);
    var data = sh.getDataRange().getValues();
    var idCol = data[0].indexOf('編號');
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(id)) { sh.deleteRow(i + 1); return { ok: true }; }
    }
    return { ok: false, message: '找不到題目' };
  } finally { lock.releaseLock(); }
}

// ============================================================
// 通用單筆 新增/修改/刪除（各區共用；row 以中文表頭為鍵）
//   kind: checklist/obs/roster/staff/stores
// ============================================================
function sheetForKind(kind, month) {
  return { checklist: '題庫_' + month, obs: '觀察題_' + month, roster: '店鋪名單_' + month, staff: '點檢人員', stores: '店鋪主檔' }[kind];
}
function keyForKind(kind) {
  return { checklist: '編號', obs: '編號', roster: '店號', staff: '工號', stores: '店號' }[kind];
}
function upsertRow(kind, month, row) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var name = sheetForKind(kind, month); if (!name) throw new Error('未知類型：' + kind);
    var sh = ssBook().getSheetByName(name); if (!sh) throw new Error('找不到活頁：' + name);
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var keyCol = keyForKind(kind);
    var out = head.map(function (h) { return row[h] != null ? row[h] : ''; });
    var data = sh.getDataRange().getValues();
    var ci = head.indexOf(keyCol);
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][ci]) === String(row[keyCol]) && String(row[keyCol]) !== '') {
        sh.getRange(i + 1, 1, 1, head.length).setValues([out]);
        return { ok: true, mode: 'update' };
      }
    }
    sh.appendRow(out);
    return { ok: true, mode: 'add' };
  } finally { lock.releaseLock(); }
}
function deleteRowByKind(kind, month, id) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = ssBook().getSheetByName(sheetForKind(kind, month));
    var data = sh.getDataRange().getValues();
    var ci = data[0].indexOf(keyForKind(kind));
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][ci]) === String(id)) { sh.deleteRow(i + 1); return { ok: true }; }
    }
    return { ok: false, message: '找不到資料' };
  } finally { lock.releaseLock(); }
}

// ============================================================
// 工具
// ============================================================
function ssBook() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function readSheet(name) {
  var sh = ssBook().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var head = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) out.push(rowObj(head, data[i]));
  return out;
}
function rowObj(head, arr) { var o = {}; for (var j = 0; j < head.length; j++) o[head[j]] = arr[j]; return o; }

function getSetting(key) {
  var rows = readSheet('設定');
  for (var i = 0; i < rows.length; i++) if (rows[i]['參數'] === key) return rows[i]['值'];
  return '';
}
function setSetting(key, val) {
  var sh = ssBook().getSheetByName('設定');
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) if (data[i][0] === key) { sh.getRange(i + 1, 2).setValue(val); return; }
  sh.appendRow([key, val]);
}

function distinctDepts() {
  var rows = readSheet('點檢人員'); var m = {};
  rows.forEach(function (r) { if (r['部別']) { m[r['部別']] = m[r['部別']] || {}; if (r['課別']) m[r['部別']][r['課別']] = 1; } });
  return Object.keys(m).map(function (d) { return { dept: d, sections: Object.keys(m[d]) }; });
}

function nowStr() { return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm'); }
// 儲存格可能被 Sheet 自動轉為 Date 型別，統一正規化
function toYmd(v) { return (v instanceof Date) ? Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd') : String(v || '').slice(0, 10); }
function toDateTimeStr(v) { return (v instanceof Date) ? Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd HH:mm') : String(v || ''); }

/** 將前端紀錄物件轉成該活頁欄位順序的列陣列 */
function recordToRow(sh, rec) {
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var map = {
    '紀錄ID': rec.id, '點檢時間': rec.time, '部別': rec.dept, '課別': rec.section,
    '員編': rec.empId, '點檢人員': rec.staffName, '店號': rec.storeCode, '店名': rec.storeName,
    '店鋪型態': rec.storeType, '題庫版本': rec.month, '合計得分': rec.total, '等第': rec.grade,
    '在店店員人數': rec.staffCount, '簽名身分別': rec.identity,
    '明細JSON': JSON.stringify(rec.detail || {}), '觀察JSON': JSON.stringify(rec.observation || {}),
    '照片JSON': JSON.stringify(rec.photos || {}), '紙本照片': (rec.paperPhotos || []).join(','),
    '照片資料夾': rec.folderUrl || '', '同步狀態': '已同步',
    '建立時間': rec.createdAt, '更新時間': rec.updatedAt,
  };
  return head.map(function (h) { return map[h] != null ? map[h] : ''; });
}

function rowToRecord(r) {
  return {
    id: r['紀錄ID'], time: toDateTimeStr(r['點檢時間']), dept: r['部別'], section: r['課別'], empId: r['員編'],
    staffName: r['點檢人員'], storeCode: r['店號'], storeName: r['店名'], storeType: r['店鋪型態'],
    month: r['題庫版本'], total: r['合計得分'], grade: r['等第'], staffCount: r['在店店員人數'],
    identity: r['簽名身分別'], detail: safeJson(r['明細JSON']), observation: safeJson(r['觀察JSON']),
    photos: safeJson(r['照片JSON']), paperPhotos: String(r['紙本照片'] || '').split(',').filter(Boolean),
    folderUrl: r['照片資料夾'], createdAt: r['建立時間'], updatedAt: r['更新時間'],
  };
}
function safeJson(s) { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } }
function mapToInternal(merged, month, id) {
  return {
    id: id, time: merged['點檢時間'], dept: merged['部別'], section: merged['課別'], empId: merged['員編'],
    staffName: merged['點檢人員'], storeCode: merged['店號'], storeName: merged['店名'], storeType: merged['店鋪型態'],
    month: month, total: merged['合計得分'], grade: merged['等第'], staffCount: merged['在店店員人數'],
    identity: merged['簽名身分別'], detail: merged.detail, observation: merged.observation, photos: merged.photos,
    paperPhotos: merged.paperPhotos, folderUrl: merged['照片資料夾'], createdAt: merged['建立時間'], updatedAt: merged.updatedAt,
  };
}
