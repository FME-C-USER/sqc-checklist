// ============================================================
// SQC 背景上傳器 — 把 IndexedDB photoQueue 的照片「直傳 Drive」
//   - 由後端 createUploadSessions() 取得「可續傳上傳」網址（一個網址只能寫一個檔）
//   - 直接 PUT 到該網址（繞過 GAS，速度快、免執行時間上限），瀏覽器端不持有任何權杖
//   - 平行 3 張、失敗指數退避、監聽 online 自動補傳
//
// 為什麼不再用 getDriveToken()（2026-08 資安檢測 High 項目）：
//   那支 API 會把腳本的 OAuth 權杖交給瀏覽器，權限涵蓋擁有者「整個雲端硬碟與所有試算表」，
//   任何登入者在開發者工具就能取得。改用工作階段網址後，前端能做的只有
//   「把位元組寫進後端指定的那一個檔案」。
// ============================================================
(function () {
  const CONCURRENCY = 3;   // 同時進行的 PUT 數（行動網路上不宜過多）
  const BATCH = 6;         // 一次向後端索取幾張的上傳網址（往返次數 = 張數 / BATCH）
  let _running = false;
  const _listeners = new Set();

  const emit = () => _listeners.forEach((fn) => { try { fn(); } catch (e) {} });
  const onChange = (fn) => { _listeners.add(fn); return () => _listeners.delete(fn); };

  // 一次為整批照片取上傳網址（一次往返，不是每張一次）
  //   origin 必須一併送出：Drive 只有在「建立工作階段時帶了 Origin」的情況下，該網址才會
  //   允許來自這個網域的跨網域 PUT；沒帶的話瀏覽器會被 CORS 擋掉（No Access-Control-Allow-Origin）。
  //   retry 讓後端知道要不要查「同檔名是否已存在」：第一次上傳不可能已存在，查了白花 0.2~0.4 秒。
  async function sessionsFor(list) {
    const r = await window.SqcApi.createUploadSessions(
      list.map((p) => ({ pathParts: p.pathParts || [], name: p.name, retry: (p.tries || 0) > 0 })),
      location.origin);
    return (r && r.sessions) || [];
  }

  async function uploadOne(photo, session) {
    // 後端發現同資料夾已有同檔名 → 直接認領那個檔案，不重複上傳
    // （也涵蓋先前上傳其實已成功、只是瀏覽器讀不到回應的情況）
    if (session && session.existing && session.fileId) return session.fileId;
    if (!session || !session.ok || !session.url) {
      throw new Error((session && session.error) || '未取得上傳網址');
    }
    // 工作階段網址本身即帶授權，不可再加 Authorization 標頭
    const res = await fetch(session.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: photo.blob,
    });
    if (!res.ok) throw new Error('Drive 上傳失敗 ' + res.status);
    const data = await res.json();
    return data.id;
  }

  // ===== 待送出紀錄的自動重送 =====
  // 送出當下網路中斷時，紀錄沒寫進後端，但照片已經在佇列裡；使用者若沒重送，那筆點檢就消失了
  // （照片在 Drive、紀錄不存在，就是 2026-08-12 那批孤兒照片的成因）。
  // 只處理「新增」；編輯失敗不排隊，因為原紀錄仍完整，重試與否不影響資料完整性。
  const REC_MAX_TRIES = 30;
  async function pumpRecords() {
    if (!navigator.onLine) return;
    const list = await window.SqcDB.pendingRecords();
    for (const q of list) {
      if (q.nextAt && q.nextAt > Date.now()) continue;
      try {
        // 先確認是不是「其實已經送出成功、只是回應遺失」，否則重送會變成兩筆
        const day = String((q.record && q.record.time) || '').slice(0, 10);
        if (day) {
          const r = await window.SqcApi.queryRecords(q.month, { from: day, to: day });
          if ((r.records || []).some((x) => String(x.id) === String(q.id))) {
            await window.SqcDB.delQueuedRecord(q.id);
            emit();
            continue;
          }
        }
        const res = await window.SqcApi.submitRecord(q.record);
        if (res && res.ok === false) {
          // 例如「同店本月已有紀錄」：重送也不會成功，標記為需人工處理，不再佔用後端
          await window.SqcDB.queueRecord({ ...q, status: 'blocked', err: res.message || '後端拒絕' });
          emit();
          continue;
        }
        await window.SqcDB.delQueuedRecord(q.id);
        emit();
      } catch (e) {
        const tries = (q.tries || 0) + 1;
        await window.SqcDB.queueRecord({
          ...q, tries, err: String((e && e.message) || e),
          status: tries >= REC_MAX_TRIES ? 'blocked' : 'pending',
          nextAt: Date.now() + Math.min(300000, 10000 * tries),
        });
        emit();
      }
    }
  }

  async function pump() {
    if (_running) return;
    if (!navigator.onLine) return;
    _running = true;
    try {
      await pumpRecords();   // 先把紀錄補送成功，照片的連結才有地方可寫
      let pend = await window.SqcDB.pendingPhotos();
      while (pend.length && navigator.onLine) {
        // 一次向後端取 BATCH 張的上傳網址（往返次數減半），實際 PUT 仍每次 CONCURRENCY 張並行，
        // 避免在行動網路上同時塞太多連線反而更容易失敗
        const batch = pend.slice(0, BATCH);
        // 取不到上傳網址(後端未部署/連線不穩)：整批記次退避，跳出本輪等 setInterval 再試，
        // 照片仍留在 IndexedDB 佇列中，不會遺失
        let sessions;
        try {
          sessions = await sessionsFor(batch);
        } catch (e) {
          await Promise.all(batch.map((p) => {
            const tries = (p.tries || 0) + 1;
            return window.SqcDB.updatePhoto({ ...p, tries, error: String(e.message || e), nextAt: Date.now() + Math.min(60000, 2000 * tries) });
          }));
          emit();
          break;
        }
        for (let off = 0; off < batch.length; off += CONCURRENCY) {
          const wave = batch.slice(off, off + CONCURRENCY);
          await Promise.all(wave.map(async (p, k) => {
            try {
              const fileId = await uploadOne(p, sessions[off + k]);
              await window.SqcDB.updatePhoto({ ...p, status: 'done', fileId, error: '' });
            } catch (e) {
              const tries = (p.tries || 0) + 1;
              await window.SqcDB.updatePhoto({ ...p, tries, error: String(e.message || e), nextAt: Date.now() + Math.min(60000, 2000 * tries) });
            }
          }));
          emit();
        }
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
  const LINK_MAX_TRIES = 20; // 紀錄始終不存在(例如送出失敗)時要放棄，否則每15秒重送一次會無限佔用後端
  async function flushLinksIfDone(recordId) {
    if (!recordId) return;
    const list = await window.SqcDB.photosOfRecord(recordId);
    if (!list.length) return;
    if (list.some((p) => p.status !== 'done' && p.status !== 'linked')) return; // 還有上傳中/失敗中的，先不送
    const toLink = list.filter((p) => p.status === 'done');
    if (!toLink.length) return; // 已全部 linked 過了
    // 退避：回寫失敗過就等一段時間再試，避免密集打後端(會與使用者的查詢互相搶資源)
    const now = Date.now();
    if (toLink.some((p) => p.linkNextAt && p.linkNextAt > now)) return;
    const month = toLink[0].month;
    const links = {};
    toLink.forEach((p) => { const k = (p.pathParts || []).join('/'); (links[k] = links[k] || []).push({ name: p.name, fileId: p.fileId }); });
    // 退避分兩種，這個區分很重要：
    //   countable=true  後端明確回覆「找不到紀錄」→ 紀錄真的不存在，重試 LINK_MAX_TRIES 次後放棄
    //   countable=false 網路層失敗(斷線、逾時) → 不計入放棄次數，只是等久一點再試
    // 若把網路錯誤也計次，門市現場網路不良約 5 分鐘就會永久放棄回寫，照片在 Drive 但報表點不到。
    const backoff = async (reason, countable) => {
      await Promise.all(toLink.map((p) => {
        const linkTries = (p.linkTries || 0) + (countable ? 1 : 0);
        const netTries = (p.netTries || 0) + (countable ? 0 : 1);
        const status = countable && linkTries >= LINK_MAX_TRIES ? 'orphan' : p.status; // 放棄後不再重送，保留資料供人工查
        // 紀錄不存在：首次短一點(紀錄通常1~2秒內就寫入完成)，之後逐步拉長
        // 網路失敗：直接等久一點(10秒起、上限5分鐘)，避免在訊號不良時空轉
        const wait = countable ? 1500 * linkTries : 10000 * Math.min(netTries, 30);
        return window.SqcDB.updatePhoto({ ...p, linkTries, netTries, status, linkErr: reason, linkNextAt: Date.now() + Math.min(300000, wait) });
      }));
    };
    try {
      const res = await window.SqcApi.attachPhotoLinks(month, recordId, links);
      // 照片是在紀錄送出「之前」就開始上傳的，所以可能比紀錄本身更早完成 → 後端會回「找不到紀錄」。
      // 這種情況必須維持 done、等下次 pump 週期紀錄存在後再送，不可標記 linked(否則連結永久遺失)。
      if (res && res.ok === false) { await backoff(res.message || '找不到紀錄', true); return; }
      await Promise.all(toLink.map((p) => window.SqcDB.updatePhoto({ ...p, status: 'linked' })));
    } catch (e) { await backoff(String(e && e.message || e), false); }
  }

  // 每次 pump 週期，找出「所有照片都已上傳完成但還沒回寫連結」的紀錄一併補送
  // (涵蓋 App 重啟、上傳完成當下漏觸發等情況)
  async function reconcileLinks() {
    const all = await window.SqcDB.allPhotos();
    const recordIds = new Set(all.filter((p) => p.status === 'done').map((p) => p.recordId));
    for (const id of recordIds) await flushLinksIfDone(id);
  }

  // 只數筆數，不把照片 blob 讀出來（畫面會反覆呼叫這支，用 getAll 會讀進數十MB）
  async function counts() {
    const [total, pending, done, orphan] = await Promise.all([
      window.SqcDB.countPhotos(),
      window.SqcDB.countPhotos('pending'),
      window.SqcDB.countPhotos('done'),
      window.SqcDB.countPhotos('orphan'),
    ]);
    const recs = await window.SqcDB.pendingRecords();
    return { total, pending, done, orphan, unfinished: pending + done, queuedRecords: recs.length };
  }

  window.addEventListener('online', pump);
  // App 從背景切回前景時，手機瀏覽器常會暫停背景計時器/連線，導致連結回寫卡住；回到前景立即補跑一次
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pump(); });
  setInterval(pump, 15000); // 週期性嘗試補傳

  window.SqcUploader = { enqueue, pump, pumpRecords, counts, onChange };
})();
