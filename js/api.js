// ============================================================
// SQC API 用戶端 — 以 fetch 呼叫 GAS Web App
// 用 text/plain body 避開 CORS 預檢；回傳 { ok, result | error }
// ============================================================
(function () {
  function token() {
    try { return (JSON.parse(sessionStorage.getItem('sqc_user')) || {}).token || ''; } catch (e) { return ''; }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function attempt(action, payload) {
    const res = await fetch(window.SQC_CONFIG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: token(), payload: payload || {} }),
      redirect: 'follow',
    });
    const text = await res.text();
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
    return data.result;
  }

  // 非 JSON / 網路層失敗視為暫時性，重試一次(間隔0.8秒)再放棄
  async function call(action, payload) {
    try {
      return await attempt(action, payload);
    } catch (e) {
      if (e.transient) {
        await sleep(800);
        try { return await attempt(action, payload); } catch (e2) {
          throw e2.transient ? new Error('伺服器忙碌中，請稍後再試一次') : e2;
        }
      }
      throw e;
    }
  }

  window.SqcApi = {
    call,
    login: (userId, password) => call('login', { userId, password }),
    getBootstrap: (month, section) => call('getBootstrap', { month, section }),
    getDriveToken: () => call('getDriveToken'),
    getUploadFolderId: (pathParts) => call('getUploadFolderId', { pathParts }),
    submitRecord: (record) => call('submitRecord', { record }),
    attachPhotoLinks: (month, recordId, links) => call('attachPhotoLinks', { month, recordId, links }),
    queryRecords: (month, filter) => call('queryRecords', { month, filter }),
    updateRecord: (month, id, record) => call('updateRecord', { month, id, record }),
    deleteRecord: (month, id) => call('deleteRecord', { month, id }),
    getSummary: (month, filter) => call('getSummary', { month, filter }),
    buildMonthlyReport: (month, filter) => call('buildMonthlyReport', { month, filter }),
    importMaster: (kind, month, rows, fileName) => call('importMaster', { kind, month, rows, fileName }),
    upsertItem: (month, item) => call('upsertItem', { month, item }),
    deleteItem: (month, id) => call('deleteItem', { month, id }),
    upsertRow: (kind, month, row) => call('upsertRow', { kind, month, row }),
    deleteRow: (kind, month, id) => call('deleteRow', { kind, month, id }),
    getMaster: (kind, month) => call('getMaster', { kind, month }),
    getChangeLog: (limit) => call('getChangeLog', { limit }),
    lookupStore: (q) => call('lookupStore', { q }),
  };
})();
