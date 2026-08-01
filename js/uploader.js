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
        await Promise.all([...new Set(batch.map((p) => p.recordId))].map(flushLinksIfDone));
        await new Promise((r) => setTimeout(r, 300));
        pend = (await window.SqcDB.pendingPhotos()).filter((p) => !p.nextAt || p.nextAt <= Date.now());
      }
      await reconcileLinks(); // 涵蓋 App 重啟後、上次已全數 done 但尚未回寫連結的紀錄
    } finally {
      _running = false;
      emit();
    }
  }

  // 排入一張壓縮後照片
  async function enqueue({ blob, name, pathParts, recordId, month, thumb }) {
    const id = 'ph_' + Date.now() + '_' + Math.random().toString(16).slice(2);
    await window.SqcDB.addPhoto({ id, blob, name, pathParts, recordId, month, thumb, status: 'pending', tries: 0 });
    pump();
    return id;
  }

  // 一筆紀錄的照片全部上傳完成(狀態皆為done)後，把雲端連結一次回寫進該筆紀錄，之後標記linked避免重送
  async function flushLinksIfDone(recordId) {
    if (!recordId) return;
    const list = await window.SqcDB.photosOfRecord(recordId);
    if (!list.length) return;
    if (list.some((p) => p.status !== 'done' && p.status !== 'linked')) return; // 還有上傳中/失敗中的，先不送
    const toLink = list.filter((p) => p.status === 'done');
    if (!toLink.length) return; // 已全部 linked 過了
    const month = toLink[0].month;
    const links = {};
    toLink.forEach((p) => { const k = (p.pathParts || []).join('/'); (links[k] = links[k] || []).push({ name: p.name, fileId: p.fileId }); });
    try {
      await window.SqcApi.attachPhotoLinks(month, recordId, links);
      await Promise.all(toLink.map((p) => window.SqcDB.updatePhoto({ ...p, status: 'linked' })));
    } catch (e) { /* 回寫失敗就維持 done，下次 pump 週期再試一次 */ }
  }

  // 每次 pump 週期，找出「所有照片都已上傳完成但還沒回寫連結」的紀錄一併補送
  // (涵蓋 App 重啟、上傳完成當下漏觸發等情況)
  async function reconcileLinks() {
    const all = await window.SqcDB.allPhotos();
    const recordIds = new Set(all.filter((p) => p.status === 'done').map((p) => p.recordId));
    for (const id of recordIds) await flushLinksIfDone(id);
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
