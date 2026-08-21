# vendor — 自帶的前端函式庫（不從 CDN 載入）

## 為什麼自帶

2026-08 資安檢測的 Medium 項目：原本六個 `<script>` 直接指向 CDN，其中
`cdn.tailwindcss.com` 與 `@babel/standalone` 完全沒有版本號，且六個都沒有
`integrity`（SRI）。這些指令碼與「處理 AD 帳號密碼的登入頁」及「持有 Drive
上傳權限的主程式」在同一個執行環境，CDN 或上游套件一旦被投毒，就能在所有
使用者的瀏覽器裡執行任意程式碼。

實際證據：檢查當天 `@babel/standalone` 已經自己從 7.x 跳到 **8.0.4**（跨大版本），
而我們完全不知情 —— 這正是不鎖版本的風險。

`cdn.tailwindcss.com` 的版本檔**沒有回傳 CORS 標頭**，所以無法對它套用 SRI。
因此不採「鎖版本 + SRI」，而是直接把檔案放進本專案由 GitHub Pages 自己出，
變成同源資源：沒有第三方信任、沒有 SRI 需求、離線也可用。

## 版本與雜湊（更新時請一併更新此表）

| 檔案 | 版本 | 來源 | SHA-256（前16碼） |
|---|---|---|---|
| react-18.3.1.min.js | 18.3.1 | unpkg.com/react@18.3.1/umd/react.production.min.js | d949f1c3687aedad |
| react-dom-18.3.1.min.js | 18.3.1 | unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js | 35f4f974f4b2bcd4 |
| babel-standalone-8.0.4.min.js | 8.0.4 | unpkg.com/@babel/standalone@8.0.4/babel.min.js | 9a4b639c5c1e174e |
| xlsx-0.20.3.full.min.js | 0.20.3 | cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js | cc015130aa8521e7 |
| exceljs-4.4.0.min.js | 4.4.0 | cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js | 7e49da68588e250d |
| tailwindcss-3.4.17.js | 3.4.17 | cdn.tailwindcss.com/3.4.17 | 176e894661aa9cdc |

## 為什麼 xlsx 不從 npm 取

npm 上的 `xlsx` 停在 0.18.5 且已標為 deprecated，該版本有已知漏洞
（原型污染 CVE-2023-30533，修於 0.19.3；ReDoS，修於 0.20.2）。
本系統會用它解析使用者上傳的 .xlsx 匯入檔，屬於直接暴露面，
因此改由官方來源 cdn.sheetjs.com 取 0.20.3。
升級後已比對過：本專案的實際匯入檔（題庫、觀察題）解析結果與 0.18.5 完全相同。

## 升級版本的做法

1. 下載新版到本目錄（檔名帶版本號，不要覆蓋舊檔名）
2. 更新上面表格的版本與 SHA-256（`sha256sum 檔名`）
3. 改 `app.html` / `index.html` / `service-worker.js` 內的路徑
4. 在瀏覽器實測：登入頁樣式正常、主程式能編譯啟動、可產出 Excel 報表
5. 確認後才刪除舊檔

## 待辦（更徹底的做法）

Babel standalone 佔 2.4MB，只是為了在瀏覽器即時編譯 `app.html` 裡的 JSX。
若日後願意加入建置步驟（部署前先把 JSX 編成 JS 並提交產物），就能同時移除
這 2.4MB 與瀏覽器端的 `eval`。目前刻意不做，以維持「改一個檔就能部署」的流程。
