# SQC 評核系統（sqc-checklist）

門市服務品質稽核（SQC）PWA。現場點檢、分區扣分、照片壓縮後直傳 Google Drive、離線補傳；資料存 Google Sheet（依月份分活頁）。

## 架構
- **前端**：本 repo，GitHub Pages 靜態託管（PWA，可離線開啟）
- **後端 API**：Google Apps Script Web App（`backend/`，需另行部署）
- **資料**：Google Sheet（依月份活頁）
- **照片**：Google Drive（月份／題目／區域 分層）

## 設定
編輯 `js/config.js`：
- `GAS_URL`：GAS Web App 部署後的 `/exec` 網址
- `MONTH`：當月版本（民國年月，如 `11506`）

## 後端部署
將 `backend/` 三檔貼進 Apps Script 專案，執行 `setupAll()` 建立活頁，部署為 Web App（執行身分：擁有者；存取：任何人）。詳見 `openspec/資料結構_GoogleSheet.md`。

## 權限
- 登入以公司 AD（CheckUserId）驗證；以 AD 帳號比對 `點檢人員` 名冊取角色
- 管理者可進維護專區；一般點檢員自行選取姓名/部別/課別
