# 在自己的電腦使用 ChatGPT 方案

此版本沿用同一套題庫、左側作答、右側受控提示及教師／學生分開記錄。GitHub Pages 繼續提供免安裝的規則提示體驗。

## 開始使用

1. 電腦安裝 **Node.js 24 或更新版本**。這個版本不需要 `npm install`，也不需要 API Key。
2. [下載同一個專案](https://github.com/HectorNet/one-step-algebra-pages/archive/refs/heads/main.zip)，解壓縮。
3. Windows 可雙擊 `start.bat`。macOS／Linux 在專案資料夾開啟終端機，執行 `npm start`。
4. 保留終端機，於**同一台電腦**的瀏覽器開啟 **http://127.0.0.1:4318**。
5. 建立或選擇學習檔案，按上方「AI 連線設定」，再按 **Continue with ChatGPT**。
6. 只在 OpenAI 官方登入頁輸入帳號資訊，檢視並自行同意使用 ChatGPT 方案的授權。
7. 回到原練習分頁的連線設定，確認使用中的帳號和模型。關閉設定後，請助教解釋一個觀念。
8. 只有真正收到完整模型回覆後，才會標示驗證成功。如果無法使用，設定視窗會顯示狀態，原本的規則提示仍可繼續。

結束時在終端機按 `Ctrl+C`。每次使用都從同一個 `127.0.0.1:4318` 網址開啟，避免把瀏覽器進度分散在不同來源。

**尚須本人登入及一次實際請求，才能確認帳號可用。** 登入成功、取得模型清單、通過自動測試，都不等於已完成真實推論驗證。資格、模型與額度依 OpenAI 當下回應；不會自動改用付費 API。

## 為什麼這次使用本機版

截至 2026-11-09 查閱的官方文件，開源、本機執行的工具可透過動態註冊申請各使用者自己的 ChatGPT 方案授權；面向使用者的遠端託管網站仍需申請資格。這是兩種不同部署方式，本機版不代表原本的網站申請已獲核准。

此程式只監聽 `127.0.0.1`，**不應綁定 `0.0.0.0`、架設反向代理或透過 tunnel 對外提供方案共用服務**。GitHub Pages 本身不執行 OAuth 交換，也不存放 OAuth token；本機版會載入同一份靜態前端，所有 AI 請求由本機服務執行。

## 教學限制

- 模型只可輸出六種提示卡的識別值，網站再以原有經審核的觀念／提示回覆。模型的自由文字不會傳回網頁、紀錄或匯出檔。
- 原題正確答案與解法不放進模型請求；學生自行寫出的答案、步驟由本機數學檢查器驗證。
- 要求完整答案、忽略規則或模型輸出夾帶額外文字時，改用拒絕代答或規則提示。
- 學習紀錄仍保留 `teacher_trial`、`student_operation`、`teacher_admin` 的區分；真實模型請求的結果狀態可追蹤，OAuth 憑證不進紀錄。
- 學生必須使用自己的合資格 ChatGPT 帳號並自行授權。本機程式禁止同一個已驗證的 ChatGPT 身分綁到不同學習檔案；換檔案會停止原連線，需重新選擇並授權。老師的方案不能成為全班共用額度池。

## 資料與憑證

- 學習紀錄在目前瀏覽器的 IndexedDB，**本機版和 GitHub Pages 是不同來源，紀錄不會自動搬移或合併**。原有紀錄請先在原網站匯出保存；本機版仍能依角色及學生匯出。
- OAuth 憑證只保存在作業系統使用者的私人目錄，且不在專案資料夾：macOS／Linux 為 `~/.config/one-step-algebra/`；Windows 為 `%LOCALAPPDATA%\one-step-algebra\`。
- Unix 目錄權限為 `0700`，憑證檔案為 `0600`，以原子寫入保存。Windows 請使用自己私人登入帳號的目錄與磁碟權限；不要把此目錄放在共享或同步資料夾。
- 這是同一作業系統使用者的本機試用環境；學習暱稱與角色仍是分類，並非受保護的學生身分驗證。在共用電腦上先登出 ChatGPT，並讓下一位學生自行登入。
- 設定中的「登出並清除授權」會嘗試遠端撤銷 session，然後清除本機 token。若無法確認遠端撤銷，會提醒至 ChatGPT 使用量設定中中斷授權。
- 保存每個帳號個別的 issued client ID；重新登入、refresh 與登出都不混用帳號的 client ID 或 token。refresh 在單一程序內序列化，同一資料目錄一次只允許一個程序執行。
- 程式不讀取 `.env.local`、不讀取 Codex 登入檔、不使用 ChatGPT Cookie、不使用非官方的 `backend-api`。

程式正常退出會清除 `runtime.lock`。若曾強制關機導致鎖定，**先確認沒有其他本機程序仍在執行**，再刪除上述私人目錄中的 `runtime.lock`；保留其他檔案。不要把憑證檔傳給他人或貼進支援訊息。

## 驗證與界線

在 Node.js 24 執行 `npm test` 及 `npm run check`。測試使用臨時憑證、模擬 OAuth／模型與本機 HTTP 伺服器，不會花費方案額度。包含回呼 state、PKCE、JWT 簽章／issuer／audience／nonce、學生連線隔離、refresh、惡意模型輸出、SSE 完成事件、來源限制與敏感檔案不可下載。

單靠提示詞無法承諾模型永遠遵守限制，因此只允許模型選擇固定提示卡。這能限制網站顯示的內容；公開的靜態題庫仍能從原始碼查看，不是防作弊考試系統。

## 官方依據

- [本機與開源串接適用範圍](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [註冊、登入與安全儲存](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [帳號、更新、登出與使用量](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [模型與實際請求驗證](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [方案串接目前限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
