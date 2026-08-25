// ============================================================
// SQC API 用戶端 — 以 fetch 呼叫 GAS Web App
// 用 text/plain body 避開 CORS 預檢；回傳 { ok, result | error }
// ============================================================
(function () {
  function token() {
    try { return (JSON.parse(sessionStorage.getItem('sqc_user')) || {}).token || ''; } catch (e) { return ''; }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Google 的 Web App 轉送層偶發會慢或回 404（實測後端本身都 1~2 秒完成，但回應可能 17 秒才回 404），
  // 且通常下一次就恢復 → 設較短逾時、多retry幾次，並對外通報重試狀態讓畫面不會看起來像卡住
  const TIMEOUT_MS = 12000;
  const RETRY_DELAYS = [700, 1500, 3000];
  const _retryListeners = new Set();
  const onRetry = (fn) => { _retryListeners.add(fn); return () => _retryListeners.delete(fn); };
  const emitRetry = (info) => _retryListeners.forEach((fn) => { try { fn(info); } catch (e) {} });

  async function attempt(action, payload) {
    let text;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
        ? '伺服器逾時未回應（' + (TIMEOUT_MS / 1000) + ' 秒）'
        : '網路連線中斷，請稍後再試（' + (e && e.message || '') + '）');
      err.transient = true;
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
      if (data.code === 'AUTH') { // 連線逾時/未登入 → 回登入頁
        sessionStorage.removeItem('sqc_user');
        if (!location.pathname.endsWith('index.html')) location.href = 'index.html';
      }
      throw new Error(data.error || 'API 錯誤');
    }
    // 後端回 ok 但沒帶 result（多半是線上部署版本較舊、該動作尚未存在或回傳空值）
    if (data.result === undefined) {
      throw new Error('後端未回傳資料（動作：' + action + '），請確認 Apps Script 已重新部署新版本');
    }
    return data.result;
  }

  // 網路層失敗 / 逾時 / 非 JSON 回應皆視為暫時性，重試數次(間隔漸增)再放棄
  async function call(action, payload) {
    const maxAttempts = RETRY_DELAYS.length + 1;
    let lastErr;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const out = await attempt(action, payload);
        if (i > 0) emitRetry({ action, attempt: 0, maxAttempts, done: true }); // 通報已恢復
        return out;
      } catch (e) {
        lastErr = e;
        if (!e.transient) throw e;
        if (i < RETRY_DELAYS.length) {
          emitRetry({ action, attempt: i + 2, maxAttempts, done: false });
          await sleep(RETRY_DELAYS[i]);
        }
      }
    }
    emitRetry({ action, attempt: 0, maxAttempts, done: true });
    throw new Error('伺服器忙碌中，請稍後再試一次（' + (lastErr && lastErr.message || '') + '）');
  }

  window.SqcApi = {
    call,
    onRetry, // 供UI顯示「重試中 n/m」，避免暫時性失敗看起來像卡住
    login: (userId, password) => call('login', { userId, password }),
    getBootstrap: (month, section) => call('getBootstrap', { month, section }),
    // 只回傳「單檔上傳網址」，權杖留在後端（見 uploader.js 開頭說明）
    createUploadSessions: (items, origin) => call('createUploadSessions', { items, origin }),
    submitRecord: (record) => call('submitRecord', { record }),
    attachPhotoLinks: (month, recordId, links) => call('attachPhotoLinks', { month, recordId, links }),
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
  };
})();
