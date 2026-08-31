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
  /**
   * 一次向後端索取幾張的上傳網址（往返次數 = 張數 / BATCH）。
   *
   * 曾經為了少跑兩趟往返把它調到 10，但那是把單次請求變重 67% ——
   * 而後端要為每一張向 Drive 開一個 resumable session，這裡正好就是瓶頸本身。
   * 2026-08-27 現場整批卡在 createUploadSessions 逾時，改回 6：
   * 單次請求輕一點、比較容易在逾時內完成，失敗時重做的成本也小。
   */
  const BATCH = 6;
  let _running = false;
  let _again = false;      // 跑到一半又被要求重試 → 跑完再跑一輪，不要直接丟掉
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
    // 照片內容不見了要當場講清楚。iOS Safari 對 IndexedDB 裡的 Blob 有已知的失效問題
    // （存進去後在某些情況讀出來是空的），而空 body 的 PUT 只會換到一個 Drive 4xx，
    // 看起來像網路或權限問題 —— 那會把診斷帶往完全錯誤的方向。
    if (!photo.blob || !photo.blob.size) {
      throw new Error('照片內容不見了：本機儲存的檔案是空的（size='
        + ((photo.blob && photo.blob.size) || 0) + '），無法上傳，需要重拍');
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
        /**
         * 先確認是不是「其實已經送出成功、只是回應遺失」。
         *
         * 原本這裡呼叫 queryRecords(month, {from:day,to:day})，但後端的 queryRecords
         * 第一行就是讀整張活頁，from/to 是讀完才過濾的 —— 送出逾時的人越多、待送佇列越多，
         * 這種全表讀取就越頻繁，後端被自己的重試機制拖垮，於是更多人逾時。
         * 改用只讀「紀錄ID」一欄的 recordExists。
         *
         * 後端還是舊版時 recordExists 會回「未知動作」：這時直接跳過確認、往下送就好，
         * 因為 submitRecord 本身是等冪的（同一個紀錄ID 不會寫成兩列），
         * 這個確認只是省一次寫入嘗試，不是正確性的必要條件。
         */
        let known = false;
        try {
          const r = await window.SqcApi.recordExists(q.month, q.id);
          known = !!(r && r.exists);
        } catch (e) { /* 舊後端沒有這支：交給 submitRecord 的等冪保護 */ }
        if (known) {
          await window.SqcDB.delQueuedRecord(q.id);
          emit();
          continue;
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

  /**
   * 寫回佇列狀態時本身也可能失敗。
   *
   * updatePhoto 會把整個物件（含照片本體）重新寫回 IndexedDB，而 WebKit 在
   * 「把 Blob 存進 object store」這條路徑上會丟 Error preparing Blob/File data ——
   * 2026-08-28 有三支手機跳出全域錯誤視窗，就是這個例外從 Promise.all 裡漏出來。
   * 這裡的寫入只是記錄重試次數與原因，失敗了不該中斷整輪上傳，也不該彈系統錯誤，
   * 所以吞掉並保留原因（下一輪還會再試）。
   */
  let _storeBroken = '';   // 最近一次寫回佇列失敗的原因（空字串 = 正常）
  async function safeUpdate(photo) {
    try {
      await window.SqcDB.updatePhoto(photo);
      _storeBroken = '';
      return true;
    } catch (e) {
      _storeBroken = String((e && e.message) || e);
      return false;
    }
  }

  async function pumpOnce() {
    try {
      await pumpRecords();   // 先把紀錄補送成功，照片的連結才有地方可寫
      // 套用退避：失敗過的照片有 nextAt，時間沒到就不要再打後端。
      // （原本只有迴圈內第二輪之後有過濾，第一輪沒有 —— 等於每 15 秒必定
      //   對 createUploadSessions 打一次，後端越忙這件事越傷。）
      let pend = (await window.SqcDB.pendingPhotos()).filter((p) => !p.nextAt || p.nextAt <= Date.now());
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
            return safeUpdate({ ...p, tries, error: String(e.message || e), nextAt: Date.now() + Math.min(60000, 2000 * tries) });
          }));
          emit();
          break;
        }
        for (let off = 0; off < batch.length; off += CONCURRENCY) {
          const wave = batch.slice(off, off + CONCURRENCY);
          await Promise.all(wave.map(async (p, k) => {
            try {
              const fileId = await uploadOne(p, sessions[off + k]);
              await safeUpdate({ ...p, status: 'done', fileId, error: '' });
            } catch (e) {
              const tries = (p.tries || 0) + 1;
              await safeUpdate({ ...p, tries, error: String(e.message || e), nextAt: Date.now() + Math.min(60000, 2000 * tries) });
            }
          }));
          emit();
        }
        await Promise.all([...new Set(batch.map((p) => p.recordId))].map(flushLinksIfDone));
        /**
         * 佇列寫不回去時必須跳出本輪。
         *
         * 這個迴圈是靠「照片狀態被改掉、下一輪就不再是 pending」來收斂的；
         * 寫入失敗時狀態不會變，同一批會被無限重取、無限重打 createUploadSessions ——
         * 比原本讓例外冒出去更糟（原本至少會停）。
         * 等 setInterval 下一輪再試：那時記憶體壓力可能已經緩解。
         */
        if (_storeBroken) { emit(); break; }
        await new Promise((r) => setTimeout(r, 300));
        pend = (await window.SqcDB.pendingPhotos()).filter((p) => !p.nextAt || p.nextAt <= Date.now());
      }
      await reconcileLinks(); // 涵蓋 App 重啟後、上次已全數 done 但尚未回寫連結的紀錄
      await reportStuck();    // 卡住太久的要把原因送回後端，不要讓它死在這支手機裡
    } finally {
      emit();
    }
  }

  /**
   * 把「重試很多次還是失敗」的照片原因回報到異動紀錄。
   *
   * 為什麼需要：每次失敗的原因本來就存進了 photo.error，但介面只顯示張數 ——
   * 2026-08-27 有人一小時內重試幾百次全部失敗，而我們事後只能靠猜，
   * 因為那個字串一直躺在她手機的 IndexedDB 裡，沒有任何地方會把它拿出來。
   *
   * 同一筆紀錄、同一個錯誤只回報一次（回報過的標記 reported），
   * 否則 19 張照片會塞 19 筆一樣的紀錄，而 logEvent 每人每小時只有 60 筆額度。
   * 一併帶上 location.origin —— 網址不在後端白名單時照片會全數失敗，而那件事
   * 從伺服器端完全看不出來，所以來源必須跟著錯誤一起送。
   */
  const REPORT_AFTER_TRIES = 10;
  async function reportStuck() {
    if (!window.SqcApi || !window.SqcApi.logEvent || !window.SqcDB.photoDiagnostics) return;
    try {
      const list = await window.SqcDB.photoDiagnostics();
      const stuck = list.filter((p) => p.status === 'pending' && !p.reported && p.tries >= REPORT_AFTER_TRIES);
      if (!stuck.length) return;
      const groups = new Map();
      stuck.forEach((p) => {
        const key = (p.recordId || '?') + '｜' + (p.error || '(沒有錯誤訊息)');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      });
      for (const [, members] of groups) {
        const first = members[0];
        const msg = `${members.length} 張卡住（已重試 ${first.tries} 次）`
          + `｜錯誤：${first.error || '(沒有錯誤訊息)'}`
          + `｜檔名：${first.name}`
          + `｜題目：${first.where}`
          + `｜內容大小：${first.blobSize} bytes`
          + `｜來源：${location.origin}`;
        try { await window.SqcApi.logEvent('photoUploadStuck', msg); } catch (e) { break; }
        // 回報成功才標記，否則下次還要再試（但標記失敗不影響上傳，個別 try 住）
        for (const m of members) {
          try {
            const full = await window.SqcDB.getPhoto(m.id);
            if (full) await window.SqcDB.updatePhoto({ ...full, reported: true });
          } catch (e) { /* 標記失敗就下次再回報，不可讓它中斷 pump */ }
        }
      }
    } catch (e) { /* 診斷回報本身絕對不能影響上傳 */ }
  }

  /**
   * 對外的 pump。兩件事是原本沒有的：
   *   1. 正在跑的時候不再直接 return —— 記下 _again，跑完立刻再跑一輪。
   *      原本的 if (_running) return 讓「立即重試」在最常見的情況（每 15 秒的自動輪詢正在跑）
   *      變成毫無反應的空操作，使用者只會覺得按鈕壞了。
   *   2. force：清掉所有退避時間。照片是在紀錄寫入後端「之前」就開始上傳的，所以第一次回寫
   *      連結常會收到「找不到紀錄」而進入退避；不清掉的話按重試也還是要等退避結束。
   */
  async function pump(opts) {
    try {
      if (opts && opts.force) await clearBackoff(opts.recordId);
    } catch (e) { /* 清退避失敗不該擋住這一輪上傳 */ }
    if (!navigator.onLine) { emit(); return; }
    if (_running) { _again = true; emit(); return; }
    _running = true;
    emit();                       // 讓畫面立刻顯示「正在重試…」，按鈕才有回饋
    try {
      do { _again = false; await pumpOnce(); } while (_again && navigator.onLine);
    } catch (e) {
      /**
       * pump 是被 setInterval / online / visibilitychange 呼叫的，沒有人 await 它 ——
       * 一旦丟出例外就是 unhandledrejection，會觸發全域錯誤視窗，
       * 現場看到的是「系統發生未預期錯誤」而不是任何有用的訊息。
       * 上傳失敗本來就會逐張記進 photo.error 並由診斷視窗呈現，這裡吞掉即可。
       */
      _lastPumpError = String((e && e.message) || e);
    } finally {
      _running = false;
      emit();
    }
  }
  let _lastPumpError = '';

  /** 清掉退避：上傳重試(nextAt)與連結回寫重試(linkNextAt)都歸零，讓下一輪立刻重試 */
  async function clearBackoff(recordId) {
    const all = recordId ? await window.SqcDB.photosOfRecord(recordId) : await window.SqcDB.allPhotos();
    await Promise.all(all
      .filter((p) => p.status !== 'linked' && (p.nextAt || p.linkNextAt))
      .map((p) => window.SqcDB.updatePhoto({ ...p, nextAt: 0, linkNextAt: 0 })));
  }

  /**
   * 單一筆紀錄的照片狀態。判斷「這一筆傳完了沒」一定要只看這一筆 ——
   * 全域數字會被別筆還沒傳完的照片污染，導致永遠等不到完成。
   * 狀態的意思：pending＝還在傳；done＝檔案已在雲端硬碟、只是連結還沒寫回紀錄；
   *             linked＝全部完成；orphan＝檔案在雲端硬碟但放棄回寫連結（需人工處理）。
   */
  async function countsOfRecord(recordId) {
    const list = await window.SqcDB.photosOfRecord(recordId);
    const by = { pending: 0, done: 0, linked: 0, orphan: 0 };
    list.forEach((p) => { by[p.status] = (by[p.status] || 0) + 1; });
    return {
      total: list.length,
      pending: by.pending, done: by.done, linked: by.linked, orphan: by.orphan,
      uploaded: by.done + by.linked + by.orphan,   // 檔案已經在雲端硬碟的張數（進度條的分子）
      settled: by.linked + by.orphan,              // 不會再變動的張數
    };
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
      // deferShare：只寫連結。「設為知道連結就能看」要對每張照片打三次 Drive API，
      // 19 張就是幾十次往返、實測佔掉好幾秒 —— 而使用者是在等這一支回來才看到「已完成」。
      // 連結一寫回，報表就已經點得到照片了；分享是給「沒有 Google 帳號的外部收件人」用的，
      // 晚幾秒完成不影響任何人，所以移到背景。
      const res = await window.SqcApi.attachPhotoLinks(month, recordId, links, true);
      // 照片是在紀錄送出「之前」就開始上傳的，所以可能比紀錄本身更早完成 → 後端會回「找不到紀錄」。
      // 這種情況必須維持 done、等下次 pump 週期紀錄存在後再送，不可標記 linked(否則連結永久遺失)。
      if (res && res.ok === false) { await backoff(res.message || '找不到紀錄', true); return; }
      await Promise.all(toLink.map((p) => window.SqcDB.updatePhoto({ ...p, status: 'linked' })));
      // 標記 linked 之後才分享，且不等它 —— 分享失敗不該讓照片回到「未完成」狀態，
      // 那些檔案已經在雲端硬碟、連結也已經寫回紀錄了。真的沒分享成功時，
      // 維護專區的「照片連結修復」會再補一次（它也會設定分享）。
      // 舊版後端沒有 sharePhotoLinks，但它的 attachPhotoLinks 會忽略 deferShare 而照舊同步分享，
      // 所以這裡失敗也無妨。
      if (res && res.deferredShare) {
        window.SqcApi.sharePhotoLinks(links).catch(() => { });
      }
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
    return {
      total, pending, done, orphan,
      // unfinished 含 done —— done 的照片其實已經在雲端硬碟，只是連結還沒回寫。
      // 顯示給使用者時不可以叫「待上傳」，會讓人以為傳不上去。
      unfinished: pending + done,
      queuedRecords: recs.length,
      busy: _running,
      // 吞掉例外是為了不彈「系統發生未預期錯誤」，但原因不能就此消失 —— 診斷視窗要看得到。
      // 佇列寫不回去是最要緊的一種：這支手機從現在起無法保存任何上傳進度。
      lastError: _storeBroken
        ? ('照片存不進本機待傳佇列，多半是手機儲存空間不足：' + _storeBroken)
        : _lastPumpError,
    };
  }

  window.addEventListener('online', pump);
  // App 從背景切回前景時，手機瀏覽器常會暫停背景計時器/連線，導致連結回寫卡住；回到前景立即補跑一次
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pump(); });
  setInterval(pump, 15000); // 週期性嘗試補傳

  window.SqcUploader = { enqueue, pump, pumpRecords, counts, countsOfRecord, onChange };
})();
