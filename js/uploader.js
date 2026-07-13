// ============================================================
// SQC 背景上傳器 — 把 IndexedDB photoQueue 的照片「直傳 Drive」
//   - 用 GAS getDriveToken() 取 OAuth 權杖（快取 ~45 分）
//   - multipart 上傳到 Drive API（繞過 GAS，速度快、免執行時間上限）
//   - 平行 3 張、失敗指數退避、監聽 online 自動補傳
// ============================================================
(function () {
  const CONCURRENCY = 3;
  const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
  let _token = null, _tokenAt = 0;
  let _running = false;
  const _folderCache = {};       // pathKey -> folderId
  const _listeners = new Set();

  const emit = () => _listeners.forEach((fn) => { try { fn(); } catch (e) {} });
  const onChange = (fn) => { _listeners.add(fn); return () => _listeners.delete(fn); };

  async function token() {
    if (_token && Date.now() - _tokenAt < 45 * 60 * 1000) return _token;
    const r = await window.SqcApi.getDriveToken();
    _token = r.token; _tokenAt = Date.now();
    return _token;
  }

  async function folderId(pathParts) {
    const key = pathParts.join('/');
    if (_folderCache[key]) return _folderCache[key];
    const r = await window.SqcApi.getUploadFolderId(pathParts);
    _folderCache[key] = r.folderId;
    return r.folderId;
  }

  async function uploadOne(photo) {
    const fid = await folderId(photo.pathParts);
    const meta = { name: photo.name, parents: [fid] };
    const boundary = 'sqc' + Math.random().toString(16).slice(2);
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = new Blob([head, photo.blob, tail], { type: `multipart/related; boundary=${boundary}` });
    const res = await fetch(DRIVE_UPLOAD, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error('Drive 上傳失敗 ' + res.status);
    const data = await res.json();
    return data.id;
  }

  async function pump() {
    if (_running) return;
    if (!navigator.onLine) return;
    _running = true;
    try {
      let pend = await window.SqcDB.pendingPhotos();
      while (pend.length && navigator.onLine) {
        const batch = pend.slice(0, CONCURRENCY);
        await Promise.all(batch.map(async (p) => {
          try {
            const fileId = await uploadOne(p);
            await window.SqcDB.updatePhoto({ ...p, status: 'done', fileId, error: '' });
          } catch (e) {
            const tries = (p.tries || 0) + 1;
            await window.SqcDB.updatePhoto({ ...p, tries, error: String(e.message || e), nextAt: Date.now() + Math.min(60000, 2000 * tries) });
          }
        }));
        emit();
        await new Promise((r) => setTimeout(r, 300));
        pend = (await window.SqcDB.pendingPhotos()).filter((p) => !p.nextAt || p.nextAt <= Date.now());
      }
    } finally {
      _running = false;
      emit();
    }
  }

  // 排入一張壓縮後照片
  async function enqueue({ blob, name, pathParts, recordId, thumb }) {
    const id = 'ph_' + Date.now() + '_' + Math.random().toString(16).slice(2);
    await window.SqcDB.addPhoto({ id, blob, name, pathParts, recordId, thumb, status: 'pending', tries: 0 });
    pump();
    return id;
  }

  async function counts() {
    const all = await window.SqcDB.allPhotos();
    return {
      total: all.length,
      pending: all.filter((p) => p.status === 'pending').length,
      done: all.filter((p) => p.status === 'done').length,
    };
  }

  window.addEventListener('online', pump);
  setInterval(pump, 15000); // 週期性嘗試補傳

  window.SqcUploader = { enqueue, pump, counts, onChange };
})();
