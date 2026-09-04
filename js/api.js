// ============================================================
// SQC API 用戶端 — 以 fetch 呼叫 GAS Web App
// 用 text/plain body 避開 CORS 預檢；回傳 { ok, result | error }
// ============================================================
(function () {
  /**
   * 登入身分的存放。
   *
   * 原本存在 sessionStorage —— 那是「一個分頁一份、分頁關掉就消失」：
   *   ・關掉瀏覽器、開新分頁，都要重新登入
   *   ・Android Chrome 會回收背景分頁，回來時登入資料可能已經不見
   * 而點檢一天要跑十幾家店（9:00~18:00），這代表整天在重複登入。
   * 更糟的是：照片佇列存在 IndexedDB（永久保留），但送照片需要 token ——
   * 沒登入時照片就安靜地躺著沒人送。
   *
   * 改存 localStorage：跨分頁、跨重啟都留著，上限由後端的 6 小時滑動效期決定。
   * 安全性取捨：前端只有一個 token（沒有密碼）、真正的權限判斷都在後端、
   * 手機為個人專屬且有鎖屏。2026-09-01 確認過「手機不是共用」才這樣改。
   *
   * 讀取一定要保留 sessionStorage 的退路：升級前登入的人，token 還在舊位置，
   * 只讀新位置會讓所有人在拿到新版的那一刻被登出一次 —— 那正是這次要消除的事。
   * 讀到舊位置時順手搬過去，之後就走新路徑。
   */
  const SESS_KEY = 'sqc_user';
  function readUser() {
    try {
      const fresh = localStorage.getItem(SESS_KEY);
      if (fresh) return JSON.parse(fresh) || {};
      const legacy = sessionStorage.getItem(SESS_KEY);
      if (!legacy) return {};
      localStorage.setItem(SESS_KEY, legacy);   // 一次性搬移，不再依賴舊位置
      return JSON.parse(legacy) || {};
    } catch (e) { return {}; }
  }
  function writeUser(user) {
    try { localStorage.setItem(SESS_KEY, JSON.stringify(user)); } catch (e) {}
  }
  function clearUser() {
    // 兩邊都清：登出必須真的登出，不可以留下舊位置的殘值讓下一次又被讀回來
    try { localStorage.removeItem(SESS_KEY); } catch (e) {}
    try { sessionStorage.removeItem(SESS_KEY); } catch (e) {}
  }
  window.SqcSession = { read: readUser, write: writeUser, clear: clearUser };

  function token() {
    return readUser().token || '';
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Google 的 Web App 轉送層偶發會慢或回 404（實測後端本身都 1~2 秒完成，但回應可能 17 秒才回 404），
  // 且通常下一次就恢復 → 設較短逾時、多retry幾次，並對外通報重試狀態讓畫面不會看起來像卡住
  const TIMEOUT_MS = 12000;
  /**
   * 正常就慢的動作：第一次就要給足時間。
   * 這裡踩過一次坑（2026-08-26）：原本一律「第一次 12 秒、第二次才給足」，
   * 但 getStoreList 要讀 1500+ 列、正常就要十幾秒 —— 於是第一次必然逾時，
   * 每次開 App 都會看到「回應較慢，自動重試中」，然後第二次才成功。
   * 功能是好的，卻讓使用者每次都先看一次失敗。
   */
  const SLOW_ACTIONS = {
    getStoreList: 45000,
    buildMonthlyReport: 60000,
    importMaster: 60000,
    repairPhotoLinks: 60000,
    recomputeScores: 60000,   // 要讀整月紀錄再逐題重算，跟 repairPhotoLinks 同級
    getMaster: 30000,
  };
  /**
   * 正常很快、但偶爾會被 Google 轉送層拖住的動作：第一次用短逾時快速跳過那一次，
   * 第二次才給足時間。（實測轉送層偶發會 30 秒才回 404，而正常回應約 1~2 秒。）
   */
  const RETRY_LONGER = {
    getBootstrap: 45000,
    queryRecords: 30000,
    /**
     * 建立上傳工作階段：一次要向 Drive 開 6 個 resumable session，後端忙的時候
     * 12 秒不夠。2026-08-27 現場整批照片卡住就是這裡 —— 四次都用 12 秒逾時，
     * 等於連一次成功的機會都沒有。
     */
    createUploadSessions: 45000,
    /**
     * 回寫照片連結：要拿後端的腳本鎖（waitLock 20 秒），多人同時送出時 12 秒經常不夠 ——
     * 後端其實做完了、連結也寫進紀錄了，但回應沒在 12 秒內回到手機，
     * 於是手機當成失敗、照片停在「已上傳、等寫入連結」。
     * 而逾時屬於「非 countable」失敗，不計入 LINK_MAX_TRIES 的放棄門檻，
     * 所以會每 5 分鐘重試一次、永遠不會結束：橫幅一直掛著，後端也一直白做。
     * 2026-09-03 現場就是這樣（轉出的報表明明已經有連結）。
     *
     * 附帶好處：進了 RETRY_LONGER 之後嘗試次數從 4 次變 2 次
     * （timeoutsOf 對這一類只給兩次），對一個要拿鎖的動作來說是少一半的負擔。
     */
    attachPhotoLinks: 45000,
    /**
     * 送出紀錄：同樣要拿腳本鎖，12 秒同樣結構性不足。
     * 2026-09-03 現場：畫面顯示「送出失敗：伺服器逾時未回應（12 秒）」，
     * 但查詢時那筆紀錄與照片連結都在 —— 後端做完了，回應沒趕上。
     *
     * 放寬逾時是安全的，因為送出前就先進了待送佇列（app.html），
     * 而補送每輪會先問 recordExists（只讀「紀錄ID」一欄、不搶鎖），
     * 已存在就直接把佇列項刪掉，不會寫成兩列。
     * 次數從 4 降到 2 對一個要拿鎖的動作也是好事：少一半的鎖競爭。
     *
     * 註：updateRecord（編輯）是同一個結構問題，而且它「不進待送佇列」
     * （原紀錄仍完整、沒有遺失風險），所以逾時後要使用者自己再存一次。
     * 尚未一併放寬 —— 需要先確認編輯逾時在現場的實際頻率。
     */
    submitRecord: 45000,
  };
  const RETRY_DELAYS = [700, 1500, 3000];
  /** 每次嘗試各自的逾時；慢的動作只嘗試兩次，避免真的失敗時要等好幾分鐘 */
  const timeoutsOf = (action) => {
    if (SLOW_ACTIONS[action]) return [SLOW_ACTIONS[action], SLOW_ACTIONS[action]];
    if (RETRY_LONGER[action]) return [TIMEOUT_MS, RETRY_LONGER[action]];
    return [TIMEOUT_MS, TIMEOUT_MS, TIMEOUT_MS, TIMEOUT_MS];
  };
  // 連線階段過期：只記狀態並通知畫面，絕不自己跳轉（見下方 AUTH 的說明）
  let _authLost = false;
  // 'missing'＝這支手機上沒有登入資料（沒帶 token 出去）
  // 'expired'＝有帶 token，是後端說它已經失效
  let _authReason = '';
  const _authListeners = new Set();
  const onAuthLost = (fn) => { _authListeners.add(fn); return () => _authListeners.delete(fn); };
  const authLost = () => _authLost;
  const authReason = () => _authReason;

  const _retryListeners = new Set();
  const onRetry = (fn) => { _retryListeners.add(fn); return () => _retryListeners.delete(fn); };
  const emitRetry = (info) => _retryListeners.forEach((fn) => { try { fn(info); } catch (e) {} });

  async function attempt(action, payload, ms) {
    let text;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(window.SQC_CONFIG.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: token(), payload: payload || {} }),
        redirect: 'follow',
        signal: ctrl.signal,
      });
      text = await res.text(); // 逾時計時器需涵蓋讀取內容，否則連線掛在讀取階段仍會卡住
    } catch (e) {
      // fetch 拋錯＝網路層失敗(訊號瞬斷)或逾時被中止，兩者都標記為可重試，不是後端邏輯問題
      const aborted = e && e.name === 'AbortError';
      const err = new Error(aborted
        ? '伺服器逾時未回應（' + Math.round(ms / 1000) + ' 秒）'
        : '網路連線中斷，請稍後再試（' + (e && e.message || '') + '）');
      err.transient = true;
      /**
       * 逾時要能被上層分辨出來。
       *
       * transient 只說「可以重試」，但送出紀錄這件事需要更強的區分：
       * 逾時代表「後端很可能已經做完了，只是回應沒趕上」，而不是「失敗」。
       * 2026-09-03 現場就是這樣 —— 畫面說「送出失敗」，Sheet 上其實已經有那筆。
       * 而說成失敗的直接後果是同事再按一次送出，每一次都要搶後端的腳本鎖，
       * 於是更多人逾時：這個訊息本身有放大效應。
       */
      err.timedOut = aborted;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      // 後端(或 Google 中繼站)回傳非 JSON，通常是暫時性問題(冷啟動/配額)，標記為可重試
      const err = new Error('伺服器暫時無法回應（非 JSON 回應），請稍後再試');
      err.transient = true;
      throw err;
    }
    if (!data.ok) {
      /**
       * 連線階段過期。
       *
       * 原本這裡直接 location.href = 'index.html' —— 但這條路徑對「任何」呼叫都會走，
       * 包含 setInterval(pump, 15000) 的背景補傳。也就是說：有人正在填點檢表、
       * 連線階段剛好過期，15 秒內的背景重試就會把整頁換掉，表單全部消失
       * （而本系統目前沒有草稿保存，是真的全沒）。
       *
       * 改成只發出事件，由畫面顯示橫幅讓使用者自己決定何時重新登入。
       * 也不清掉 sessionStorage —— 保留使用者名稱，橫幅才講得出「誰的連線過期了」。
       */
      if (data.code === 'AUTH') {
        /**
         * 兩種原因，後端回的訊息一模一樣，但解法完全不同 ——
         * 2026-09-01 有人 13:58 還正常、14:29 就被要求重新登入，
         * 而我們無從判斷是「這支手機根本沒有登入資料」還是「後端說階段過期」。
         * 差別在於這次請求有沒有帶 token 出去，所以在這裡就記下來。
         */
        _authLost = true;
        _authReason = token() ? 'expired' : 'missing';
        _authListeners.forEach((fn) => { try { fn(); } catch (e) {} });
      }
      throw new Error(data.error || 'API 錯誤');
    }
    /**
     * 後端回 ok 但沒帶 result。
     * 原本這裡寫「請確認 Apps Script 已重新部署新版本」—— 但 2026-08-28 現場出現時
     * 後端明明就是最新版，結果大家照著這句話去查部署，方向完全錯了。
     * 實際上後端忙碌時也會回出這種殘缺回應，而那才是比較常見的原因，所以改成先講負載。
     */
    if (data.result === undefined) {
      throw new Error('後端回應不完整（動作：' + action + '）。多半是後端忙碌造成，'
        + '請稍候再試；若一直如此，才需要確認 Apps Script 是否已重新部署。');
    }
    return data.result;
  }

  // 網路層失敗 / 逾時 / 非 JSON 回應皆視為暫時性，重試數次(間隔漸增)再放棄
  async function call(action, payload) {
    const timeouts = timeoutsOf(action);
    const maxAttempts = timeouts.length;
    let lastErr;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const out = await attempt(action, payload, timeouts[i]);
        if (i > 0) emitRetry({ action, attempt: 0, maxAttempts, done: true }); // 通報已恢復
        return out;
      } catch (e) {
        lastErr = e;
        if (!e.transient) throw e;
        // 以「還有沒有下一次嘗試」為準，不能用 RETRY_DELAYS 的長度 ——
        // 重的動作只嘗試兩次，用長度判斷會在最後一次失敗後還多睡一輪
        if (i + 1 < maxAttempts) {
          emitRetry({ action, attempt: i + 2, maxAttempts, done: false });
          await sleep(RETRY_DELAYS[Math.min(i, RETRY_DELAYS.length - 1)]);
        }
      }
    }
    emitRetry({ action, attempt: 0, maxAttempts, done: true });
    throw new Error('伺服器忙碌中，請稍後再試一次（' + (lastErr && lastErr.message || '') + '）');
  }

  window.SqcApi = {
    call,
    onRetry, // 供UI顯示「重試中 n/m」，避免暫時性失敗看起來像卡住
    onAuthLost, authLost, authReason, // 連線階段過期：由畫面顯示橫幅，並讓背景補傳停手（打了也是白打）
    login: (userId, password) => call('login', { userId, password }),
    // light=true：不含門市名單（名單改由 getStoreList 在背景取，開場才不會被近 200KB 拖住）
    getBootstrap: (month, section, light) => call('getBootstrap', { month, section, light: light === true }),
    getStoreList: (month, section) => call('getStoreList', { month, section }),
    // 只回店號清單（防重複點檢用）。舊版後端沒這支，前端會退回 queryRecords
    getInspectedCodes: (month) => call('getInspectedCodes', { month }),
    /** 只讀「紀錄ID」一欄，供待送佇列在重送前確認是否其實已經寫進去了 */
    recordExists: (month, id) => call('recordExists', { month, id }),
    // 只回傳「單檔上傳網址」，權杖留在後端（見 uploader.js 開頭說明）
    createUploadSessions: (items, origin) => call('createUploadSessions', { items, origin }),
    submitRecord: (record) => call('submitRecord', { record }),
    // deferShare=true：只寫連結，不做「設為知道連結就能看」（那要對每張照片打三次 Drive API）。
    // 分享由 sharePhotoLinks 在背景另外做，使用者才不必等那幾秒。
    attachPhotoLinks: (month, recordId, links, deferShare) => call('attachPhotoLinks', { month, recordId, links, deferShare: deferShare === true }),
    sharePhotoLinks: (links) => call('sharePhotoLinks', { links }),
    queryRecords: (month, filter) => call('queryRecords', { month, filter }),
    // pass：非當週紀錄的修改/刪除密碼（後端把關，前端只是先問一次）
    updateRecord: (month, id, record, pass) => call('updateRecord', { month, id, record, pass }),
    deleteRecord: (month, id, pass) => call('deleteRecord', { month, id, pass }),
    checkEditPass: (pass) => call('checkEditPass', { pass }),
    getSummary: (month, filter) => call('getSummary', { month, filter }),
    buildMonthlyReport: (month, filter) => call('buildMonthlyReport', { month, filter }),
    // batches：店鋪名單檔右側的「梯次/評核日期區間」小表（每月不同）
    importMaster: (kind, month, rows, fileName, batches) => call('importMaster', { kind, month, rows, fileName, batches }),
    upsertItem: (month, item) => call('upsertItem', { month, item }),
    deleteItem: (month, id) => call('deleteItem', { month, id }),
    upsertRow: (kind, month, row) => call('upsertRow', { kind, month, row }),
    deleteRow: (kind, month, id) => call('deleteRow', { kind, month, id }),
    getMaster: (kind, month) => call('getMaster', { kind, month }),
    getChangeLog: (limit) => call('getChangeLog', { limit }),
    lookupStore: (q) => call('lookupStore', { q }),
    // 編輯畫面檢視/刪除既有照片（照片在腳本擁有者的 Drive，需由後端代取）
    getPhotoThumbs: (fileIds) => call('getPhotoThumbs', { fileIds }),
    getPhotoImage: (fileId) => call('getPhotoImage', { fileId }),
    trashPhotos: (fileIds, note) => call('trashPhotos', { fileIds, note }),
    // 照片上傳完成但連結沒回寫成功時（網路中斷／頁面被關掉），依檔名把 fileId 找回來
    repairRecordPhotos: (month, recordId) => call('repairRecordPhotos', { month, recordId }),
    // 整月補回（維護專區）：write=false 只試算不寫入；一次最多 40 筆，回傳結果會說還要不要再跑
    repairPhotoLinks: (month, write) => call('repairPhotoLinks', { month, write: write === true }),
    recomputeScores: (month, write) => call('recomputeScores', { month, write: write === true }),
    // 前端主動留下的軌跡（事件名稱由後端白名單管控），目前用於「照片未傳完就離開」
    logEvent: (event, detail) => call('logEvent', { event, detail }),
  };
})();
