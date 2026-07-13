// ============================================================
// SQC API 用戶端 — 以 fetch 呼叫 GAS Web App
// 用 text/plain body 避開 CORS 預檢；回傳 { ok, result | error }
// ============================================================
(function () {
  function token() {
    try { return (JSON.parse(sessionStorage.getItem('sqc_user')) || {}).token || ''; } catch (e) { return ''; }
  }
  async function call(action, payload) {
    const res = await fetch(window.SQC_CONFIG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: token(), payload: payload || {} }),
      redirect: 'follow',
    });
    const data = await res.json();
    if (!data.ok) {
      if (data.code === 'AUTH') { // 連線逾時/未登入 → 回登入頁
        sessionStorage.removeItem('sqc_user');
        if (!location.pathname.endsWith('index.html')) location.href = 'index.html';
      }
      throw new Error(data.error || 'API 錯誤');
    }
    return data.result;
  }

  window.SqcApi = {
    call,
    login: (userId, password) => call('login', { userId, password }),
    getBootstrap: (month, section) => call('getBootstrap', { month, section }),
    getDriveToken: () => call('getDriveToken'),
    getUploadFolderId: (pathParts) => call('getUploadFolderId', { pathParts }),
    submitRecord: (record) => call('submitRecord', { record }),
    queryRecords: (month, filter) => call('queryRecords', { month, filter }),
    updateRecord: (month, id, record) => call('updateRecord', { month, id, record }),
    deleteRecord: (month, id) => call('deleteRecord', { month, id }),
    getSummary: (month, filter) => call('getSummary', { month, filter }),
    importMaster: (kind, month, rows, fileName) => call('importMaster', { kind, month, rows, fileName }),
    upsertItem: (month, item) => call('upsertItem', { month, item }),
    deleteItem: (month, id) => call('deleteItem', { month, id }),
  };
})();
