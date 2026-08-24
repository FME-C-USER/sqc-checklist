# 前端渲染煙霧測試（手動步驟）

## 為什麼需要

2026-08-24 曾把 `useMemo` 放在它引用的 `const` state 之前，造成
`ReferenceError: Cannot access 'editingRecordId' before initialization`，
**整個 App 無法啟動**。這種錯誤 Babel 編譯得過、Node 測試也測不到 ——
只有「真的把 App 掛載起來」才會出現。

所以改完 `app.html` 的元件結構後，除了跑 `backend/test/*.test.js`，
還要做一次渲染煙霧測試。

## 步驟

1. 產生測試頁（把 app.html 複製一份，插入假的 SqcApi 與 sessionStorage，並移除 SW 註冊）
2. 用 `python -m http.server` 服務該目錄（需要 js/ 與 vendor/）
3. 在瀏覽器開啟，執行檢查：

```js
document.getElementById('root').children.length > 0   // 有掛載
document.body.innerText.includes('啟動錯誤')          // 應為 false
window.__errors                                       // 應為空陣列（已把 alert 導向這裡）
```

4. 順手操作這次改動到的 UI（搜尋、切換、必填欄位），確認 `window.__errors` 仍為空

## 檢查清單（每次動到 App 元件時）

- [ ] App 能掛載，五個頁籤都在
- [ ] 沒有「啟動錯誤」字樣
- [ ] `window.__errors` 為空
- [ ] 新加的互動元件實際點過一次
