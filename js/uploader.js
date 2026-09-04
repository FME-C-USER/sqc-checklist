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
  /**
   * 單張 PUT 的逾時。1MB 在門市 4G 上約 10~30 秒，60 秒已經很寬鬆 ——
   * 目的不是壓縮時間，是「保證這個 await 一定會結束」。
   */
  const PUT_TIMEOUT_MS = 60000;
  /**
   * 看門狗：任何一處卡住都不可以讓上傳器永久死掉。
   *
   * 現在每一個網路呼叫都有逾時（api.js 有、PUT 也有了），所以 pumpOnce 在
   * 設計上是有界的。這道看門狗是為了「還沒發現的那些卡死」——
   * 2026-09-03 那次就是因為少了任何一道保護，一個 PUT 卡住就讓整個上傳器
   * 死到重新載入頁面為止，而且完全沒有錯誤訊息可查。
   *
   * 中途被中止是安全的：每一張照片的狀態寫入是各自獨立的，
   * 已經處理完的不會被回捲，下一輪重新列舉即可接續。
   */
  const PUMP_MAX_MS = 600000;   // 10 分鐘
  /**
   * 一次 pump() 最多連續跑幾輪 pumpOnce。
   *
   * _again 是「跑到一半又被要求重試」的機制，而 setInterval 每 15 秒就會設一次 ——
   * 佇列大的時候 pumpOnce 遠超過 15 秒，於是 do-while 永遠不結束、
   * _running 永遠是 true：畫面上「正在重試…」一直灰著，「立即重試」也按不動。
   * 設上限讓它週期性放手，狀態才會回到可操作。
   */
  const PUMP_LOOP_MAX = 3;
  /**
   * 「一直傳不上去」的門檻與之後的重試間隔。
   *
   * 三個佇列裡只有 pending 照片沒有出口：紀錄補送有 REC_MAX_TRIES(30) → blocked，
   * 連結回寫有 LINK_MAX_TRIES(20) → orphan，而 pending 照片的退避上限是 60 秒，
   * 所以會每分鐘試一次直到頁面關掉。REPORT_AFTER_TRIES 只負責「回報一筆事件」，
   * 不會停止重試 —— 2026-09-03 現場「卡住好幾個小時一直不動」就是這個結構。
   *
   * 為什麼用旗標而不是新增一個狀態：狀態一改，所有既有的消費端都得跟著懂它，
   * 而其中有一個是安全關鍵 —— 「清空整個佇列」算「幾張會永久遺失」時只認 pending
   * （app.html），新狀態會被漏掉，於是確認訊息說「0 張會遺失」卻真的刪掉沒上傳的照片。
   * 維持 status 不變，所有安全消費端就都繼續正確；旗標只影響「要不要密集重試」
   * 與「畫面怎麼說」這兩件事。
   */
  const STALL_AFTER_TRIES = 12;    // 退避到 60 秒後約每分鐘一次，12 次≒十幾分鐘
  const STALL_RETRY_MS = 600000;   // 之後改成每 10 分鐘一次：仍然會試，但不再打擾後端
  /**
   * 照片排進佇列的時間 —— 直接讀主鍵，不需要任何寫入。
   *
   * enqueue 的 id 是 'ph_' + Date.now() + '_' + 亂數，所以時間戳記本來就烙在主鍵上。
   * 這一點很重要：空間滿的手機連 tries 都寫不進去，任何「靠寫入記住」的做法都失效
   * （前一版用記憶體集合，跨工作階段就清空了，等於沒用），而主鍵是 addPhoto 當下
   * 就決定的，之後永遠讀得到。
   */
  function idTime(id) {
    const m = /^ph_(\d+)_/.exec(String(id || ''));
    return m ? Number(m[1]) : 0;
  }
  // 排進來超過這個時間還沒傳完，就不可能是「第一次嘗試」→ 要請後端查同檔名
  const STALE_MS = 600000;
  let _running = false;
  let _again = false;      // 跑到一半又被要求重試 → 跑完再跑一輪，不要直接丟掉
  let _stalledIds = new Set();  // 一直傳不上去的照片 id（每輪從已讀出的紀錄重新推導）
  const _listeners = new Set();

  const emit = () => _listeners.forEach((fn) => { try { fn(); } catch (e) {} });
  const onChange = (fn) => { _listeners.add(fn); return () => _listeners.delete(fn); };

  /**
   * 一次為整批照片取上傳網址（一次往返，不是每張一次）
   *   origin 必須一併送出：Drive 只有在「建立工作階段時帶了 Origin」的情況下，該網址才會
   *   允許來自這個網域的跨網域 PUT；沒帶的話瀏覽器會被 CORS 擋掉（No Access-Control-Allow-Origin）。
   *   retry 讓後端知道要不要查「同檔名是否已存在」：第一次上傳不可能已存在，查了白花 0.2~0.4 秒。
   *
   * retry 不可以只看 p.tries：tries 是寫進 IndexedDB 的，而空間不足的手機
   * 連 tries 都寫不進去、永遠是 0 → 後端每次都當成首次上傳、不查同檔名 →
   * 每個工作階段都在 Drive 建一個新檔（2026-09-03 現場同一張有 8 份以上）。
   *
   * 曾經用「記憶體中的本次已嘗試集合」補這個洞，那是無效的：每一條路徑都是
   * 「嘗試 → safeUpdate 成功（tries 被記下）或失敗（進 _skip、本輪不再碰）」，
   * 所以「已嘗試過但 tries 仍是 0」在同一個工作階段內不存在，而跨工作階段時
   * 那個集合已經清空 —— 記憶體補不了一個「需要跨工作階段記住」的洞。
   *
   * 改用主鍵裡的時間戳記：排進來超過 STALE_MS 還沒傳完，就不可能是第一次嘗試。
   * 這個訊號不需要任何寫入，所以空間滿的手機也拿得到；而且它跨工作階段有效，
   * 因為它烙在主鍵上。代價只落在真的卡住的照片（多一次同檔名查詢 0.2~0.4 秒），
   * 正常手機拍完幾秒內就傳完，不會付這個成本。
   */
  async function sessionsFor(list) {
    const now = Date.now();
    const r = await window.SqcApi.createUploadSessions(
      list.map((p) => ({
        pathParts: p.pathParts || [], name: p.name,
        retry: (p.tries || 0) > 0 || (now - idTime(p.id)) > STALE_MS,
      })),
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
    /**
     * 一定要有逾時。
     *
     * 這是 2026-09-03 現場「一直無法完整上傳」的根因：原本這個 fetch 沒有
     * AbortController、沒有 signal、沒有任何逾時 —— 而 api.js 打後端的每一次
     * 呼叫都有。行動網路上只要有一個 PUT 卡住（連上了但不傳資料），
     * 這個 await 就永遠不會結束：它在 Promise.all(wave) 裡面 → 整波不完成
     * → pumpOnce 不返回 → _running 永遠是 true → 之後每 15 秒的 setInterval
     * 只會設一下 _again 就返回。上傳器完全死掉，直到重新載入頁面。
     *
     * 現場的症狀完全對得上：「正在重試…」永遠灰著、約 70 張照片
     * tries=0 且沒有任何錯誤訊息（卡在第一波，後面的從來沒被列舉）、
     * 而且沒有「整體錯誤」（因為沒有任何東西拋錯）。
     *
     * 計時器要涵蓋讀取回應：連線掛在讀 body 的階段一樣是卡住。
     */
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PUT_TIMEOUT_MS);
    try {
      // 工作階段網址本身即帶授權，不可再加 Authorization 標頭
      const res = await fetch(session.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: photo.blob,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('Drive 上傳失敗 ' + res.status);
      const data = await res.json();
      return data.id;
    } catch (e) {
      // 逾時被中止要講人話：現場看到 AbortError 完全不知道那是什麼
      if (e && e.name === 'AbortError') {
        throw new Error('上傳逾時：' + Math.round(PUT_TIMEOUT_MS / 1000)
          + ' 秒內沒有傳完（訊號不穩時常發生，會自動重試）');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
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
  /**
   * 把一張已經完成的照片「卸下貨」——留下狀態，丟掉佔空間的內容。
   *
   * 這是 2026-08-31 那次「Chrome 傳不上去、Safari 很順」的根因所在：
   * 佇列只進不出（delPhoto 寫好了卻從來沒有人呼叫），每張照片同時存著
   *   blob  —— 壓縮後仍有 600~950 KB
   *   thumb —— 竟然是「整張 1920px 的 JPEG 再轉 base64」，比 blob 還大
   * 而它只被拿來畫一個 64×64 的小方框。
   * 一支手機測幾天就累積數百 MB；iOS 上第三方瀏覽器（WKWebView）的配額
   * 遠小於 Safari 本體，於是 Chrome 先撞牆，丟出
   * Error preparing Blob/File data to be stored in object store，
   * 而 Safari 因為配額大、累積量也不同，看起來「很順」。
   *
   * 已經 linked 的照片，檔案在雲端硬碟、連結也寫回紀錄了，本機這兩份純屬廢料。
   * 保留整筆（而不是 delPhoto 整筆刪掉）是因為統計、診斷、countsOfRecord
   * 都還要靠它 —— 只是每筆從 ~1.6MB 降到幾百位元組。
   * bytes 留著，診斷畫面才不會把它顯示成「內容 0 KB」（那會被誤讀成照片不見了）。
   */
  function released(photo, status) {
    const bytes = (photo.blob && photo.blob.size) || photo.bytes || 0;
    const out = { ...photo, status, bytes };
    delete out.blob;
    delete out.thumb;
    /**
     * 轉成「完成」時要把失敗紀錄一併清掉。
     *
     * 原本只改 status，於是 linkErr／error 會留著 —— 診斷畫面就出現
     * 「完成　已釋放（原 847 KB）」下面還跟著一行「回寫連結錯誤：伺服器忙碌中…」，
     * 那一張其實早就完成了（2026-09-03 現場的畫面）。
     * 已經完成的照片留著舊錯誤只會讓人以為還有問題。
     */
    if (status === 'linked') {
      out.error = '';
      out.linkErr = '';
      out.linkTries = 0;
      out.netTries = 0;
    }
    /**
     * 檔案已經進雲端了，「一直傳不上去」的標記就不再成立 ——
     * 不清掉的話橫幅會繼續說「有照片需要處理」，而其實已經好了。
     */
    if (status === 'done' || status === 'linked') {
      out.error = '';
      out.stalled = false;
    }
    return out;
  }

  /**
   * 本次工作階段要跳過的照片（id → 原因）。只存在記憶體，不寫入 IndexedDB。
   *
   * 為什麼一定要用記憶體：會進到這裡的照片，正是「連狀態都寫不回去」的那些——
   * 既然寫不進去，就無法用 tries/nextAt 讓它自己退避，只剩記憶體擋得住。
   *
   * 為什麼非做不可（2026-09-03 現場實證）：
   * pendingPhotos() 依主鍵排序、id 是 'ph_'+時間戳，所以永遠是最舊的在前，
   * 而 pend.slice(0, BATCH) 每輪只取最前面 6 張。原本只要那批裡有一張寫不回狀態，
   * 就 break 掉整個迴圈 —— 於是一張壞照片永久霸佔隊首，後面約 30 張
   * 「tries=0、沒有任何錯誤訊息」的照片從來沒有被嘗試過。
   * 那位同事刪掉紀錄重傳也沒用，因為刪紀錄不會移除隊首那張。
   *
   * 跳過名單同時解決了我當初加 break 想解決的無限迴圈：
   * 迴圈是靠「照片離開候選集合」收斂的，而三條路都會讓它離開 ——
   * 上傳成功（不再 pending）、記次退避（nextAt 在未來）、或進跳過名單。
   */
  const _skip = new Map();
  /**
   * 這一輪走到哪裡了。
   *
   * 2026-09-03 那次卡死完全沒有任何線索：沒有錯誤訊息、沒有重試次數，
   * 畫面上只有一個灰掉的「正在重試…」。診斷視窗的用途就是讓現場截圖能定位問題，
   * 而「上傳器現在在做什麼」是最基本的一項，之前完全沒有。
   */
  let _phase = '';
  const phase = (t) => { _phase = t; };
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

  /**
   * 把佇列裡「已完成但還帶著內容」的舊資料卸下貨。
   *
   * 只改新照片沒有用 —— 現場的手機上已經堆了好幾天的完成照片，
   * 那些才是把配額吃光、害新照片存不進去的東西。所以每輪 pump 開頭先掃一次。
   *
   * 用游標逐筆處理而不是 getAll：getAll 會把每一張的 blob 與 thumb 全部讀進
   * 記憶體（正是我們要清掉的那些），幾百張就是好幾百 MB，很可能當場當掉。
   * 逐筆讀、逐筆寫，任何一筆失敗都跳過繼續 —— 能清幾筆是幾筆，
   * 清掉的每一筆都讓下一筆更有機會成功。
   */
  /**
   * 卸掉一張已完成照片的內容。先試 put，失敗就整筆刪掉。
   *
   * 為什麼要有退路：released() 的做法是「把 blob 拿掉再存回去」—— 那是一次寫入，
   * 而這支存在的理由正是「空間滿到寫不進去」。這是個 catch-22：
   * 要騰出空間必須先寫入，但寫不進去。
   * delete 不需要空間，一定成功 —— 代價是這一筆的統計消失。
   * 對一張「檔案已在雲端、連結也寫回紀錄」的照片來說，
   * 統計價值遠低於「讓後面的照片傳得出去」。
   */
  async function releaseOne(p) {
    if (await safeUpdate(released(p, 'linked'))) return true;
    try { await window.SqcDB.delPhoto(p.id); return true; } catch (e) { return false; }
  }

  let _sweepNeeded = true;   // 還有沒有舊資料要清
  async function releaseFinished() {
    if (!_sweepNeeded) return 0;
    if (!window.SqcDB.eachPhoto) return 0;   // 舊版 db.js
    let candidates = 0, freed = 0;
    // 只走 linked：走全部的話，每一輪都會把 pending 那些還帶著 ~900KB blob 的
    // 照片讀出來一次（每 15 秒一次），那正是我們要避免的記憶體壓力。
    await window.SqcDB.eachPhoto(async (p) => {
      // 索引已經只給 linked 了，但這裡再確認一次：卸錯貨的代價是照片永久遺失，
      // 而缺失當下已經被改善、拍不回來。索引萬一過時或實作換掉，這道才擋得住。
      if (p.status !== 'linked') return;
      if (!p.blob && !p.thumb) return;       // 已經卸過貨了
      candidates++;
      if (await releaseOne(p)) freed++;
    }, 'linked');
    /**
     * 只有「真的沒有東西要清」才關掉這支。
     *
     * 原本寫 if (!freed) —— 但 freed === 0 有兩種完全不同的意思：
     * 沒東西要清，或每一筆都清不動。把兩者混為一談的結果是：
     * 「因為空間不足而清不動」的手機，第一輪就把清理功能自己關掉了 ——
     * 正是最需要它的那一支。2026-08-31 現場那支手機很可能就是這樣。
     */
    if (!candidates) _sweepNeeded = false;
    if (freed) emit();
    return freed;
  }

  /**
   * 清空佇列。kind:
   *   'finished' —— 只刪已完成的（安全：檔案在雲端、連結也已寫回紀錄）
   *   'all'      —— 全部刪掉（會遺失還沒進雲端的照片，呼叫端必須先明確警告）
   * 回傳實際刪掉的筆數。
   */
  async function purge(kind) {
    if (!window.SqcDB.eachPhoto || !window.SqcDB.delPhoto) return 0;
    let n = 0;
    const drop = async (p) => {
      try { await window.SqcDB.delPhoto(p.id); n++; } catch (e) { /* 刪不掉就跳過 */ }
    };
    if (kind === 'all') {
      await window.SqcDB.eachPhoto(drop);
    } else {
      await window.SqcDB.eachPhoto(drop, 'linked');
    }
    _storeBroken = '';
    emit();
    return n;
  }

  async function pumpOnce() {
    try {
      // 先騰出空間再做事：佇列滿到寫不進去的話，後面每一步都會失敗
      phase('清理已完成的照片');
      await releaseFinished().catch(() => 0);
      _storeBroken = '';     // 清完重新判斷，不要拿上一輪的結論擋住這一輪
      phase('補送待送出的紀錄');
      await pumpRecords();   // 先把紀錄補送成功，照片的連結才有地方可寫
      // 套用退避：失敗過的照片有 nextAt，時間沒到就不要再打後端。
      // （原本只有迴圈內第二輪之後有過濾，第一輪沒有 —— 等於每 15 秒必定
      //   對 createUploadSessions 打一次，後端越忙這件事越傷。）
      phase('讀取待傳清單');
      const due = (p) => !_skip.has(p.id) && (!p.nextAt || p.nextAt <= Date.now());
      const all = await window.SqcDB.pendingPhotos();
      /**
       * 從剛剛已經讀出來的紀錄推導「一直傳不上去」的張數 —— 不額外讀一次。
       * counts() 不能自己算：它是每次 emit 都會被呼叫的，而數 stalled 需要
       * 讀出紀錄本體（含 blob），那正是要避免的記憶體壓力。
       */
      _stalledIds = new Set(all.filter((p) => p.stalled).map((p) => p.id));
      let pend = all.filter(due);
      while (pend.length && navigator.onLine) {
        // 一次向後端取 BATCH 張的上傳網址（往返次數減半），實際 PUT 仍每次 CONCURRENCY 張並行，
        // 避免在行動網路上同時塞太多連線反而更容易失敗
        const batch = pend.slice(0, BATCH);
        // 取不到上傳網址(後端未部署/連線不穩)：整批記次退避，跳出本輪等 setInterval 再試，
        // 照片仍留在 IndexedDB 佇列中，不會遺失
        let sessions;
        try {
          phase('向後端索取 ' + batch.length + ' 個上傳網址');
          sessions = await sessionsFor(batch);
        } catch (e) {
          /**
           * 取不到上傳網址：這是「後端現在不可用」的訊號，不是這幾張照片的問題，
           * 所以 break 出去等下一輪 —— 馬上換下一批只是繼續轟炸同一個後端。
           * 但記次退避若也寫不進去，這 6 張下一輪還是會排在隊首、再擋一次，
           * 所以寫入失敗的要進跳過名單。
           */
          await Promise.all(batch.map(async (p) => {
            const tries = (p.tries || 0) + 1;
            // 同一個出口：一直取不到上傳網址也算「傳不上去」，不能每分鐘再打一次
            const stalled = tries >= STALL_AFTER_TRIES;
            const ok = await safeUpdate({
              ...p, tries, stalled, error: String(e.message || e),
              nextAt: Date.now() + (stalled ? STALL_RETRY_MS : Math.min(60000, 2000 * tries)),
            });
            if (!ok) _skip.set(p.id, _storeBroken);
          }));
          emit();
          break;
        }
        for (let off = 0; off < batch.length; off += CONCURRENCY) {
          const wave = batch.slice(off, off + CONCURRENCY);
          phase('上傳中：' + wave.map((p) => p.where || p.name).join('、'));
          await Promise.all(wave.map(async (p, k) => {
            let ok;
            try {
              const fileId = await uploadOne(p, sessions[off + k]);
              /**
               * ★ 檔案已經在雲端了，本機這份 blob 就是廢料 —— 這裡要「卸貨」而不是原封存回去。
               *
               * 原本寫的是 { ...p, status: 'done', fileId }，blob 還在裡面，
               * 所以「把狀態從 pending 改成 done」這個幾百位元組的變更，
               * 要重寫整張 ~820KB 的照片，並且需要 ~820KB 的可用空間才寫得成功。
               * 空間滿的手機於是永遠寫不進去 → 照片永遠停在 pending →
               * 下次開 App 又傳一次 → Drive 多一份。
               *
               * 卸貨之後這次寫入只有幾百位元組，幾乎必定成功，而且立刻釋放 ~820KB
               * —— 從「每傳成功一張釋放 0」變成「每傳成功一張就為下一張騰出空間」，
               * 佇列會自己排完。這是 blob/中繼資料分家（要升 IndexedDB 版本、
               * 要寫容錯搬移）之外，拿到同樣效果的最小改動。
               *
               * done 之後沒有任何東西需要 blob：attachPhotoLinks 只要 fileId 與檔名，
               * 而佇列裡的 thumb 從來沒有任何讀取端（只被寫入與刪除）。
               */
              ok = await safeUpdate(released({ ...p, fileId }, 'done'));
            } catch (e) {
              const tries = (p.tries || 0) + 1;
              /**
               * 試到一定次數就不再每分鐘打一次 —— 這是 pending 照片原本唯一缺的出口。
               * 注意 status 刻意保持 pending：照片還在手機上、還是會遺失，
               * 所有「幾張會永久遺失」的計算都必須繼續把它算進去。
               */
              const stalled = tries >= STALL_AFTER_TRIES;
              ok = await safeUpdate({
                ...p, tries, stalled, error: String(e.message || e),
                nextAt: Date.now() + (stalled ? STALL_RETRY_MS : Math.min(60000, 2000 * tries)),
              });
            }
            // 狀態寫不回去 → 本次工作階段跳過它，讓後面的照片有機會被處理。
            // 絕對不刪：照片還在 IndexedDB，下次開 App 是新的工作階段，會再試一次。
            if (!ok) _skip.set(p.id, _storeBroken || '本機無法記錄狀態');
          }));
          emit();
        }
        phase('回寫照片連結');
        await Promise.all([...new Set(batch.map((p) => p.recordId))].map(flushLinksIfDone));
        /**
         * 這裡原本有一段 `if (_storeBroken) { emit(); break; }`。
         * 那是為了避免無限迴圈（狀態改不掉 → 同一批被無限重取），
         * 但代價是一張壞照片永久霸佔隊首、把後面全部擋住 ——
         * 2026-09-03 現場有人 30 張照片「從來沒有被嘗試過」就是這樣造成的。
         * 現在改由跳過名單收斂，所以不需要也不可以在這裡 break。
         */
        await new Promise((r) => setTimeout(r, 300));
        pend = (await window.SqcDB.pendingPhotos()).filter(due);
      }
      phase('檢查還有哪些連結沒寫回');
      await reconcileLinks(); // 涵蓋 App 重啟後、上次已全數 done 但尚未回寫連結的紀錄
      phase('回報卡住的照片');
      await reportStuck();    // 卡住太久的要把原因送回後端，不要讓它死在這支手機裡
    } finally {
      phase('');
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
    await reportSkipped().catch(() => { });
  }

  /**
   * 回報「連狀態都寫不回本機」而被跳過的照片。
   *
   * 為什麼要單獨一條路：上面那支的門檻是 tries >= REPORT_AFTER_TRIES，
   * 而這些照片的 tries 根本累加不上去（寫入就是失敗的那一步）——
   * 所以最嚴重的那一類失敗，恰好是唯一永遠不會進異動紀錄的一類。
   * 那正是 2026-08-27 那批照片在眼前消失卻查不到原因的同一個形狀。
   *
   * 「回報過」也只能記在記憶體（同樣寫不進去），所以每個工作階段回報一次。
   */
  const _skipReported = new Set();
  async function reportSkipped() {
    if (!_skip.size || !window.SqcApi || !window.SqcApi.logEvent) return;
    const fresh = [...(_skip.keys())].filter((id) => !_skipReported.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => _skipReported.add(id));
    const reason = _skip.get(fresh[0]) || '(沒有原因)';
    const msg = `${fresh.length} 張照片的狀態寫不進本機佇列，本次已跳過`
      + `｜原因：${String(reason).slice(0, 200)}`
      + `｜佇列共 ${await window.SqcDB.countPhotos()} 筆`
      + `｜來源：${location.origin}`;
    try { await window.SqcApi.logEvent('photoUploadStuck', msg); } catch (e) { /* 下個工作階段再試 */ }
  }

  /**
   * 對外的 pump。兩件事是原本沒有的：
   *   1. 正在跑的時候不再直接 return —— 記下 _again，跑完立刻再跑一輪。
   *      原本的 if (_running) return 讓「立即重試」在最常見的情況（每 15 秒的自動輪詢正在跑）
   *      變成毫無反應的空操作，使用者只會覺得按鈕壞了。
   *   2. force：清掉所有退避時間。照片是在紀錄寫入後端「之前」就開始上傳的，所以第一次回寫
   *      連結常會收到「找不到紀錄」而進入退避；不清掉的話按重試也還是要等退避結束。
   */
  /**
   * 讓一個可能永不結束的 promise 有個上限。
   * 被中止時原本那個 promise 仍在背景跑（JS 無法真的取消它），
   * 但這裡的目的只是「不要讓呼叫端永遠等下去」—— 呼叫端釋放了狀態，
   * 下一輪就能重新開始，而每一張照片的狀態寫入本來就是各自獨立的。
   */
  function withWatchdog(promise, ms, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function pump(opts) {
    try {
      if (opts && opts.force) await clearBackoff(opts.recordId);
    } catch (e) { /* 清退避失敗不該擋住這一輪上傳 */ }
    if (!navigator.onLine) { emit(); return; }
    /**
     * 連線階段過期時停手。
     *
     * 每一次呼叫都會被後端回 AUTH，打了也是白打 —— 而每 15 秒一輪，
     * 等於用註定失敗的請求持續消耗後端（今天已經吃過一次「後端被自己的
     * 重試機制拖垮」的教訓）。使用者重新登入後，下一輪就會自己接上。
     * 例外：清理本機空間不需要後端，還是要做。
     */
    if (window.SqcApi && window.SqcApi.authLost && window.SqcApi.authLost()) {
      await releaseFinished().catch(() => 0);
      emit();
      return;
    }
    if (_running) { _again = true; emit(); return; }
    _running = true;
    emit();                       // 讓畫面立刻顯示「正在重試…」，按鈕才有回饋
    try {
      let rounds = 0;
      do {
        _again = false;
        // 看門狗包住每一輪：卡住的那一輪會被中止，_running 由下面的 finally 釋放，
        // 下一次 setInterval 就能重新開始 —— 而不是死到重新載入頁面為止。
        await withWatchdog(pumpOnce(), PUMP_MAX_MS,
          '這一輪上傳超過 ' + Math.round(PUMP_MAX_MS / 60000) + ' 分鐘沒有結束，已中止並重新開始');
        rounds++;
      } while (_again && navigator.onLine && rounds < PUMP_LOOP_MAX);
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

  /**
   * 清掉退避：上傳重試(nextAt)與連結回寫重試(linkNextAt)都歸零，讓下一輪立刻重試。
   * 也一併清掉「一直傳不上去」的旗標 —— 使用者按「立即重試」就是在說
   * 「情況變了（換了網路、清了空間），重新給它一次機會」，若不清掉，
   * 那幾張下一次失敗就會立刻又被判定為 stalled、退避回 10 分鐘。
   */
  async function clearBackoff(recordId) {
    const all = recordId ? await window.SqcDB.photosOfRecord(recordId) : await window.SqcDB.allPhotos();
    await Promise.all(all
      .filter((p) => p.status !== 'linked' && (p.nextAt || p.linkNextAt || p.stalled))
      .map((p) => window.SqcDB.updatePhoto({ ...p, nextAt: 0, linkNextAt: 0, stalled: false, tries: 0 })));
    _stalledIds = new Set();
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
    /**
     * 這裡原本要求「這一筆的每一張都是 done 或 linked」才回寫，否則整筆先不送。
     *
     * 用意是避免「連結寫一半」，但代價太大：只要有一張傳不上去，
     * 整筆的其餘照片就永遠寫不進連結 —— 2026-09-03 現場有一筆是
     * 「一張紙本照片 Load failed，其餘 6 張已在雲端卻一直停在待寫連結」。
     * 報表因此完全沒有那家店的照片連結，而畫面上看不出是被哪一張擋住。
     *
     * 改成「有 fileId 的先寫回去」是安全的：後端 attachPhotoLinks 是按檔名合併
     * （同名覆寫、新名附加），所以分幾次送、送幾次都得到同一個結果。
     * 剩下那張自己繼續重試，補上時再送一次即可；每張照片實際只會被送一次，
     * 因為送成功就轉成 linked，不會再進 toLink。
     */
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
      await Promise.all(toLink.map((p) => safeUpdate(released(p, 'linked'))));
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
      /**
       * 其中「一直傳不上去、已停止密集重試」的張數。
       * 它是 pending 的子集（status 刻意沒有改），所以不能把它加進任何總數 ——
       * 只用來決定畫面要說「上傳中，請保持頁面開啟」還是「需要處理」。
       */
      stalled: _stalledIds.size,
      // 吞掉例外是為了不彈「系統發生未預期錯誤」，但原因不能就此消失 —— 診斷視窗要看得到。
      // 佇列寫不回去是最要緊的一種：這支手機從現在起無法保存任何上傳進度。
      phase: _phase,
      lastError: _storeBroken
        ? ('照片存不進本機待傳佇列，多半是手機儲存空間不足：' + _storeBroken)
        : _lastPumpError,
    };
  }

  window.addEventListener('online', pump);
  // App 從背景切回前景時，手機瀏覽器常會暫停背景計時器/連線，導致連結回寫卡住；回到前景立即補跑一次
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pump(); });
  setInterval(pump, 15000); // 週期性嘗試補傳

  /**
   * 本次工作階段被跳過的照片（id → 原因）。
   * 一定要對外公開：跳過如果不顯示，就變成「照片安靜地留在手機上沒人管」——
   * 那正是這整個診斷視窗要消滅的東西。
   */
  const skipped = () => { const o = {}; _skip.forEach((v, k) => { o[k] = v; }); return o; };

  window.SqcUploader = { enqueue, pump, pumpRecords, counts, countsOfRecord, onChange, purge, skipped };
})();
