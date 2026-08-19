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
    var ADMIN_ONLY = { importMaster: 1, upsertItem: 1, deleteItem: 1, upsertRow: 1, deleteRow: 1, getMaster: 1, getChangeLog: 1, buildMonthlyReport: 1 };
    var sess = null;
    if (!OPEN[action]) {
      sess = getSession(req.token);
      if (!sess) return json({ ok: false, code: 'AUTH', error: '未登入或連線逾時，請重新登入' });
      if (ADMIN_ONLY[action] && sess.role !== '管理者') return json({ ok: false, error: '此功能需管理者權限' });
    }

    var routes = {
      login: function () { return login(p.userId, p.password); },
      getBootstrap: function () { return getBootstrap(p.month, p.section); },
      getDriveToken: function () { return { token: getDriveToken() }; },
      getUploadFolderId: function () { return { folderId: getUploadFolderId(p.pathParts) }; },
      submitRecord: function () { return submitRecord(p.record); },
      attachPhotoLinks: function () { return attachPhotoLinks(p.month, p.recordId, p.links); },
      queryRecords: function () { return { records: queryRecords(p.month, p.filter) }; },
      updateRecord: function () { return updateRecord(p.month, p.id, p.record); },
      deleteRecord: function () { return deleteRecord(p.month, p.id); },
      getSummary: function () { return getSummary(p.month, p.filter); },
      buildMonthlyReport: function () { return buildMonthlyReport(p.month, p.filter); },
      importMaster: function () { return importMaster(p.kind, p.month, p.rows, p.fileName); },
      upsertItem: function () { return upsertItem(p.month, p.item); },
      deleteItem: function () { return deleteItem(p.month, p.id); },
      upsertRow: function () { return upsertRow(p.kind, p.month, p.row); },
      deleteRow: function () { return deleteRowByKind(p.kind, p.month, p.id); },
      getMaster: function () {
        ensureKindSheet(p.kind, p.month);
        var all = readSheet(sheetForKind(p.kind, p.month));
        var LIMIT = 800; // 大表(如店鋪主檔4000+筆)避免整包傳輸拖慢/逾時
        return { rows: all.slice(0, LIMIT), total: all.length, truncated: all.length > LIMIT };
      },
      getChangeLog: function () { return getChangeLog(p.limit); },
      lookupStore: function () { return lookupStore(p.q); },
    };
    if (!routes[action]) return json({ ok: false, error: '未知動作：' + action });
    var result = routes[action]();

    // 記錄維護/資料異動軌跡
    // 異動紀錄：只記「刪除」與「修改」，不記新增/送出/匯入（避免每月上千筆送出把軌跡淹掉）
    // 「操作人」一律記登入帳號者（who 取自登入 token），與紀錄裡的「點檢人員」是不同概念
    var LOGGED = { upsertItem: '修改題目', upsertRow: '修改', deleteItem: '刪除題目', deleteRow: '刪除', deleteRecord: '刪除點檢紀錄', updateRecord: '修改點檢紀錄' };
    var isUpsert = (action === 'upsertItem' || action === 'upsertRow');
    var skipAsAdd = isUpsert && result && result.mode !== 'update'; // upsert 若是新增就不記錄
    if (LOGGED[action] && !(result && result.ok === false) && !skipAsAdd) { // 被擋下的動作(如同店重複)不記錄
      var who = sess ? (sess.name || sess.ad) : '';
      var target = '', note = '';
      if (action === 'upsertRow' || action === 'upsertItem') { target = (p.kind || 'checklist') + (p.month ? '_' + p.month : ''); note = ((p.row && (p.row['編號'] || p.row['店號'] || p.row['工號'])) || (p.item && p.item['編號']) || ''); }
      else if (action === 'deleteRow' || action === 'deleteItem') { target = (p.kind || 'checklist') + (p.month ? '_' + p.month : ''); note = '刪除 ' + (p.id || ''); }
      else if (action === 'updateRecord') {
        var ur = p.record || {};
        target = '點檢紀錄_' + p.month;
        note = (p.id || '') + ' ' + (ur.storeName || '') + '（點檢人員：' + (ur.staffName || '') + '）';
      }
      else if (action === 'deleteRecord') { target = '點檢紀錄_' + p.month; note = p.id || ''; }
      logChange(who, LOGGED[action], target, note);
    }
    return json({ ok: true, result: result });
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

  // 以 AD 比對「點檢人員」名冊取身分。
  // 名冊多數人的 AD 欄是空的，故比對不到時仍放行（只要日翊帳密正確就能登入、能點檢），
  // 只是取不到工號/部課/角色 → 角色以「點檢員」計，登入後於基本資料自行選取點檢人員。
  // 權限差異只在：管理者才看得到「維護專區」與報表/請款產出；查詢紀錄所有人皆可查全部。
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
  ensureMonth(month); // 開啟某月即自動建齊該月所有活頁
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
    else if (t.indexOf('符合') >= 0) inspect.push({ id: id, name: name, opts: String(r['選項'] || '').split('|').filter(Boolean) });
    else toilet.push({ id: id, name: name, opts: String(r['選項'] || '有|無').split('|'), show: String(r['顯示條件'] || 'always') });
  });
  return { keyObservations: key, toiletObservations: toilet, toiletInspect: inspect };
}

// 自行新增店鋪：以店號或店名查店鋪主檔（回最多 20 筆）
function lookupStore(q) {
  q = String(q || '').trim();
  if (!q) return { rows: [] };
  var rows = readSheet('店鋪主檔');
  var out = [];
  for (var i = 0; i < rows.length && out.length < 20; i++) {
    var code = String(rows[i]['店號'] || ''), name = String(rows[i]['店名'] || '');
    if (code === q || name === q || (name.indexOf(q) >= 0) || (code.indexOf(q) >= 0)) {
      out.push({ code: code, name: name, section: rows[i]['營業課名稱'] || '', dept: rows[i]['營業部名稱'] || '' });
    }
  }
  return { rows: out };
}

function getStores(month, section) {
  var rows = readSheet('店鋪名單_' + month);
  return rows.filter(function (r) {
    return !section || String(r['課別']) === String(section);
  }).map(function (r) {
    var yn = function (v) { return v === true || v === 'V' || v === 'v' || v === '是' || v === '1'; };
    return {
      code: String(r['店號']), name: r['店名'], section: r['課別'], type: r['店鋪型態'] || '一般店',
      remote: yn(r['遠程店']), holiday: yn(r['假日店']), batch: r['預排梯次'] || '',
    };
  });
}

// ============================================================
// Drive：發權杖 + 建立/快取資料夾（供前端直傳）
// ============================================================
function getDriveToken() {
  return ScriptApp.getOAuthToken();
}

/** 依 [月份, 題目, 區域...] 取得目標資料夾 ID（自動建立、Script Properties 快取）
 *  多人同時是「該路徑第一次上傳」時，用鎖避免各自建出同名資料夾 */
function getUploadFolderId(pathParts) {
  var props = PropertiesService.getScriptProperties();
  var key = 'folder:' + pathParts.join('/');
  var cached = props.getProperty(key);
  if (cached) {
    try { DriveApp.getFolderById(cached); return cached; } catch (e) { /* 失效重建 */ }
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    cached = props.getProperty(key); // 等鎖期間可能已被其他請求建好，先重查一次
    if (cached) {
      try { DriveApp.getFolderById(cached); return cached; } catch (e) { /* 失效重建 */ }
    }
    var folder = DriveApp.getFolderById(DRIVE_ROOT_ID);
    for (var i = 0; i < pathParts.length; i++) {
      folder = getOrCreateChild(folder, pathParts[i]);
    }
    props.setProperty(key, folder.getId());
    return folder.getId();
  } finally {
    lock.releaseLock();
  }
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
    var sh = ensureSheetNamed('點檢紀錄_' + rec.month, HEADERS_MAP.record); // 缺活頁自動建立
    // 鎖定範圍內再次確認：同店本月是否已有紀錄（避免多人同時送出造成重複）
    var data = sh.getDataRange().getValues();
    var head = data[0];
    var storeCol = head.indexOf('店號');
    var recCode = normCode(rec.storeCode);
    for (var i = 1; i < data.length; i++) {
      if (recCode !== '' && normCode(data[i][storeCol]) === recCode) {
        return { ok: false, code: 'DUPLICATE', message: '這家店本月已有其他人送出點檢紀錄，請重新整理後至查詢紀錄編輯該筆' };
      }
    }
    var id = rec.id || (Utilities.getUuid());
    var now = nowStr();
    var row = recordToRow(sh, Object.assign({}, rec, { id: id, createdAt: now, updatedAt: now }));
    sh.appendRow(row);
    return { ok: true, id: id };
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

// 照片直傳 Drive 完成後，把雲端連結(fileId)回寫進紀錄的照片JSON，讓報表能列出連結
// links: { "路徑/資料夾":[{name, fileId}, ...], ... }；可分批多次呼叫，累加合併不覆蓋既有連結
function attachPhotoLinks(month, recordId, links) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('點檢紀錄_' + month);
    if (!sh) return { ok: false, message: '找不到月份活頁' };
    var data = sh.getDataRange().getValues();
    var head = data[0];
    var idCol = head.indexOf('紀錄ID');
    var photoCol = head.indexOf('照片JSON');
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) !== String(recordId)) continue;
      var photos = safeJson(data[i][photoCol]);
      Object.keys(links || {}).forEach(function (key) {
        var arr = photos[key] || [];
        (links[key] || []).forEach(function (link) {
          var idx = -1;
          for (var j = 0; j < arr.length; j++) {
            var existingName = typeof arr[j] === 'string' ? arr[j] : arr[j].name;
            if (existingName === link.name) { idx = j; break; }
          }
          var entry = { name: link.name, fileId: link.fileId };
          if (idx >= 0) arr[idx] = entry; else arr.push(entry);
        });
        photos[key] = arr;
      });
      sh.getRange(i + 1, photoCol + 1).setValue(JSON.stringify(photos));
      return { ok: true };
    }
    return { ok: false, message: '找不到紀錄' };
  } finally {
    SpreadsheetApp.flush();
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
        var orig = rowObj(head, data[i]);
        rec.id = id; rec.createdAt = orig['建立時間'] || nowStr(); rec.updatedAt = nowStr();
        var newRow = recordToRow(sh, rec); // rec 為前端英文鍵完整紀錄，直接覆寫
        sh.getRange(i + 1, 1, 1, newRow.length).setValues([newRow]);
        return { ok: true };
      }
    }
    return { ok: false, message: '找不到紀錄' };
  } finally {
    SpreadsheetApp.flush();
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
    SpreadsheetApp.flush();
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
// 月報表（課長版/客戶版 共用資料）
//   把 點檢紀錄_月 的 JSON 明細攤平成「每題一欄」的主表列，
//   加上部/課/擔當查找與依課別的 KPI 彙總，交給前端組成 xlsx。
// ============================================================
function buildMonthlyReport(month, filter) {
  var checklist = getChecklist(month);
  var records = queryRecords(month, filter);
  var roster = readSheet('店鋪名單_' + month);
  var storesMaster = readSheet('店鋪主檔');
  var staffList = readSheet('點檢人員');
  var pass = Number(getSetting('及格分數') || 85);

  var obsRows = readSheet('觀察題_' + month);
  var obsList = obsRows.map(function (r) {
    return {
      id: r['編號'], type: r['類型'], name: r['題目名稱'],
      options: String(r['選項'] || '').split('|').filter(Boolean),
      showIf: r['顯示條件'] || '', required: r['必填'] === '是', order: Number(r['排序']) || 0,
    };
  }).sort(function (a, b) { return a.order - b.order; });

  // 部/課對照（來自點檢人員主檔，去重）
  var deptSectionSeen = {}, deptSectionList = [];
  staffList.forEach(function (r) {
    var dept = r['部別'], sect = r['課別'];
    if (!dept || !sect) return;
    var key = dept + '|' + sect;
    if (deptSectionSeen[key]) return;
    deptSectionSeen[key] = true;
    deptSectionList.push({ 部: dept, 課: sect });
  });

  // 店號可能因店鋪重新編號而新舊不一(同一家店在名單/主檔各存不同店號)，比對店鋪主檔一律以店名為主、店號僅作備援
  var masterByCode = {}, masterByName = {}, rosterByCode = {};
  storesMaster.forEach(function (r) {
    masterByCode[normCode(r['店號'])] = r;
    var nm = normName(r['店名']); if (nm) masterByName[nm] = r;
  });
  roster.forEach(function (r) { rosterByCode[normCode(r['店號'])] = r; });
  var findMaster = function (code, name) { return masterByName[normName(name)] || masterByCode[normCode(code)] || {}; };

  // 依大分類分組題目，供小計與欄位排序用
  var catOrder = [], catItems = {};
  checklist.forEach(function (it) {
    if (!catItems[it.cat]) { catItems[it.cat] = []; catOrder.push(it.cat); }
    catItems[it.cat].push(it);
  });

  var rows = records.map(function (rec, idx) {
    var code = normCode(rec.storeCode);
    var sm = findMaster(rec.storeCode, rec.storeName);
    var ro = rosterByCode[code] || {};
    var itemScores = {}, itemExtra = {};
    checklist.forEach(function (it) {
      var d = (rec.detail || {})[it.id];
      itemScores[it.id] = d && d.score != null ? d.score : it.max;
      if (d && d.ngSubs && d.ngSubs.length) itemExtra[it.id] = d.ngSubs.join('、');
      if (d && d.customNames) {
        var names = Object.keys(d.customNames).map(function (k) { return d.customNames[k]; }).filter(Boolean);
        if (names.length) itemExtra[it.id] = (itemExtra[it.id] ? itemExtra[it.id] + '、' : '') + names.join('、');
      }
    });
    var catSubtotal = {};
    catOrder.forEach(function (cat) {
      catSubtotal[cat] = catItems[cat].reduce(function (s, it) { return s + (itemScores[it.id] != null ? itemScores[it.id] : it.max); }, 0);
    });
    // 照片群組：key 去掉開頭的月份資料夾(每筆都一樣)，剩下的路徑當作題目/區域的識別鍵；
    // 只回傳已回寫雲端連結的照片(尚未回寫/舊資料的純檔名項目會被過濾掉，不會出現空連結)
    var photoGroups = {};
    Object.keys(rec.photos || {}).forEach(function (key) {
      var groupKey = key.split('/').slice(1).join('/');
      var urls = photoUrlsOf(rec.photos[key]);
      if (urls.length) photoGroups[groupKey] = urls;
    });
    return {
      序: idx + 1,
      營業部: sm['營業部名稱'] || '', 營業課別: sm['營業課名稱'] || '', 營業擔當: sm['營業擔當'] || '',
      店號: rec.storeCode, 店名: rec.storeName, 點檢時間: rec.time, 建立時間: rec.createdAt || '',
      itemScores: itemScores, itemExtra: itemExtra, 分類小計: catSubtotal,
      合計: Number(rec.total), 等第: rec.grade,
      主責部: rec.dept || '', 主責課: rec.section || '',
      點檢人員: rec.staffName, 在店人數: rec.staffCount, 身分別: rec.identity,
      備註: rec.note || '', 店型態: ro['店鋪型態'] || '一般店', 拍照類型: rec.storeType,
      遠程店: ro['遠程店'] || '否', 假日店: ro['假日店'] || '否', 預排梯次: ro['預排梯次'] || '',
      觀察: rec.observation || {}, photoGroups: photoGroups,
    };
  });

  // 依課別 KPI 彙總（應點檢=名單配額；已點檢=實際送出）
  var byDept = {};
  var ensureDept = function (sect) { if (!byDept[sect]) byDept[sect] = { 課別: sect, 應點檢: 0, 已點檢: 0, scores: [], 不及格店: [] }; return byDept[sect]; };
  roster.forEach(function (r) { ensureDept(r['課別'] || '(未分類)').應點檢++; });
  rows.forEach(function (r) {
    var d = ensureDept(r.主責課 || '(未分類)');
    d.已點檢++; d.scores.push(r.合計);
    if (r.合計 < pass) d.不及格店.push(r.店名);
  });
  var kpi = Object.keys(byDept).sort().map(function (sect) {
    var d = byDept[sect];
    var passCount = d.scores.filter(function (s) { return s >= pass; }).length;
    return {
      課別: d.課別, 應點檢: d.應點檢, 已點檢: d.已點檢, 未點檢: d.應點檢 - d.已點檢,
      完成率: d.應點檢 ? Math.round(d.已點檢 / d.應點檢 * 100) + '%' : '-',
      合格家數: passCount, 不合格家數: d.已點檢 - passCount,
      合格率: d.已點檢 ? Math.round(passCount / d.已點檢 * 100) + '%' : '-',
      平均分: d.scores.length ? Math.round(d.scores.reduce(function (a, b) { return a + b; }, 0) / d.scores.length) : '-',
      最高分: d.scores.length ? Math.max.apply(null, d.scores) : '-',
      最低分: d.scores.length ? Math.min.apply(null, d.scores) : '-',
      不及格店: d.不及格店.join('、'),
    };
  });

  return {
    passScore: pass,
    pricing: getPricing(), // 請款單價（放「設定」活頁，調價不必改程式）
    checklist: checklist.map(function (it) { return { id: it.id, name: it.name, cat: it.cat, max: it.max, type: it.type }; }),
    obsList: obsList,
    deptSectionList: deptSectionList,
    catOrder: catOrder,
    rows: rows,
    kpi: kpi,
    roster: roster.map(function (r) {
      var sm = findMaster(r['店號'], r['店名']);
      return {
        店號: r['店號'], 店名: r['店名'], 課別: r['課別'], 店鋪型態: r['店鋪型態'],
        遠程店: r['遠程店'], 假日店: r['假日店'], 預排梯次: r['預排梯次'],
        營業部: sm['營業部名稱'] || '', 營業擔當: sm['營業擔當'] || '', 地址: sm['地址'] || '',
      };
    }),
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
    if (!map[kind]) throw new Error('未知匯入類型：' + kind);
    var sh = ensureKindSheet(kind, month); // 缺活頁自動建立
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    // 清空舊資料（保留表頭）→ 以最新上傳為主
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, head.length).clearContent();
    var out = rows.map(function (r) { return head.map(function (h) { return r[h] != null ? String(r[h]) : ''; }); });
    if (out.length) {
      var rng = sh.getRange(2, 1, out.length, head.length);
      rng.setNumberFormat('@'); // 全部存成文字，避免店號/工號等掉前導0、日期被轉型
      rng.setValues(out);
    }
    setSetting('匯入_' + kind, (fileName || '') + ' @ ' + nowStr());
    return { ok: true, count: out.length };
  } finally {
    SpreadsheetApp.flush();
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
  } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
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
  } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
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

// 各活頁表頭（缺活頁時自動建立用；與 setup.gs 保持一致）
var HEADERS_MAP = {
  checklist: ['排序', '編號', '大分類', '題號名稱', '配分', '計分方式', '每項扣分', '子項清單', '規範說明'],
  obs: ['排序', '編號', '類型', '題目名稱', '選項', '顯示條件', '必填'],
  roster: ['店號', '店名', '課別', '店鋪型態', '遠程店', '假日店', '預排梯次'],
  staff: ['部別', '課別', '工號', '姓名', '職稱', 'AD帳號', '角色'],
  stores: ['序號', '店號', '店名', '營業本部名稱', '營業部名稱', '營業課名稱', '營業擔當', '縣市', '鄉鎮', '地址'],
  record: ['紀錄ID', '點檢時間', '部別', '課別', '員編', '點檢人員', '店號', '店名', '店鋪型態', '備註', '題庫版本', '合計得分', '等第', '在店店員人數', '簽名身分別', '明細JSON', '觀察JSON', '照片JSON', '紙本照片', '照片資料夾', '同步狀態', '建立時間', '更新時間'],
  log: ['時間', '操作人', '動作', '對象', '說明'],
};
// 異動紀錄（維護區的編輯修改軌跡；單獨活頁）
function logChange(user, action, target, detail) {
  try {
    var sh = ensureSheetNamed('異動紀錄', HEADERS_MAP.log);
    sh.appendRow([nowStr(), user || '', action || '', target || '', detail || '']);
  } catch (e) { /* 記錄失敗不影響主流程 */ }
}
function getChangeLog(limit) {
  var rows = readSheet('異動紀錄');
  limit = limit || 300;
  return { rows: rows.slice(-limit).reverse().map(function (r) { return { time: toDateTimeStr(r['時間']), user: r['操作人'], action: r['動作'], target: r['對象'], note: r['說明'] }; }) };
}
// 找不到活頁就自動建立（附表頭），回傳工作表
function ensureSheetNamed(name, headers) {
  var book = ssBook();
  var sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    if (headers && headers.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#334155').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
  }
  return sh;
}
function ensureKindSheet(kind, month) { return ensureSheetNamed(sheetForKind(kind, month), HEADERS_MAP[kind]); }
// 建齊某月所有分月活頁（題庫/觀察題/店鋪名單/點檢紀錄）
function ensureMonth(month) {
  ensureKindSheet('checklist', month);
  ensureKindSheet('obs', month);
  ensureKindSheet('roster', month);
  ensureSheetNamed('點檢紀錄_' + month, HEADERS_MAP.record);
}
function upsertRow(kind, month, row) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (!sheetForKind(kind, month)) throw new Error('未知類型：' + kind);
    var sh = ensureKindSheet(kind, month); // 缺活頁自動建立
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var keyCol = keyForKind(kind);
    var out = head.map(function (h) { return row[h] != null ? String(row[h]) : ''; });
    var data = sh.getDataRange().getValues();
    var ci = head.indexOf(keyCol);
    var writeRow = function (rowIdx) { var rng = sh.getRange(rowIdx, 1, 1, head.length); rng.setNumberFormat('@'); rng.setValues([out]); };
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][ci]) === String(row[keyCol]) && String(row[keyCol]) !== '') {
        writeRow(i + 1);
        return { ok: true, mode: 'update' };
      }
    }
    writeRow(sh.getLastRow() + 1);
    return { ok: true, mode: 'add' };
  } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
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
  } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
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

// 請款單價：一次讀「設定」活頁，未設定者用內建預設（與 js/billing.js 的預設一致）
function getPricing() {
  var rows = readSheet('設定');
  var map = {};
  rows.forEach(function (r) { map[String(r['參數'] || '').trim()] = r['值']; });
  var pick = function (key, dflt) { var v = Number(map[key]); return isNaN(v) || map[key] === '' || map[key] == null ? dflt : v; };
  return {
    平日點檢費: pick('平日點檢費', 245),
    平日遠程加價: pick('平日遠程加價', 220),
    假日點檢費: pick('假日點檢費', 470),
    假日遠程加價: pick('假日遠程加價', 345),
    文件處理費: pick('文件處理費', 6500),
    稅率: pick('稅率', 0.05),
  };
}

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
// 店號正規化：去除前導0與空白，避免 Sheet 自動轉數字掉0導致字串比對誤判「不同店」
function normCode(c) { var s = String(c == null ? '' : c).trim(); var n = s.replace(/^0+(?=\d)/, ''); return n; }
// 店名正規化：去除頭尾空白與結尾「店」字，供店號異動(舊碼/新碼)時仍能以店名比對店鋪主檔
function normName(n) { return String(n == null ? '' : n).trim().replace(/店$/, ''); }
// 照片項目轉雲端連結；尚未回寫 fileId(上傳中/舊紀錄)則回傳空字串
function photoUrlOf(entry) {
  var fileId = entry && typeof entry === 'object' ? entry.fileId : '';
  return fileId ? ('https://drive.google.com/open?id=' + fileId) : '';
}
function photoUrlsOf(arr) { return (arr || []).map(photoUrlOf).filter(Boolean); }

/** 將前端紀錄物件轉成該活頁欄位順序的列陣列 */
function recordToRow(sh, rec) {
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var map = {
    '紀錄ID': rec.id, '點檢時間': rec.time, '部別': rec.dept, '課別': rec.section,
    '員編': rec.empId, '點檢人員': rec.staffName, '店號': rec.storeCode, '店名': rec.storeName,
    '店鋪型態': rec.storeType, '備註': rec.note || '', '題庫版本': rec.month, '合計得分': rec.total, '等第': rec.grade,
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
    staffName: r['點檢人員'], storeCode: r['店號'], storeName: r['店名'], storeType: r['店鋪型態'], note: r['備註'],
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
    staffName: merged['點檢人員'], storeCode: merged['店號'], storeName: merged['店名'], storeType: merged['店鋪型態'], note: merged['備註'],
    month: month, total: merged['合計得分'], grade: merged['等第'], staffCount: merged['在店店員人數'],
    identity: merged['簽名身分別'], detail: merged.detail, observation: merged.observation, photos: merged.photos,
    paperPhotos: merged.paperPhotos, folderUrl: merged['照片資料夾'], createdAt: merged['建立時間'], updatedAt: merged.updatedAt,
  };
}
