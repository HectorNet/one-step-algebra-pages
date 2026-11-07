# AI 輔導服務

已完成可測試的後端核心，尚未配置模型金鑰或發佈後端。GitHub Pages 不能執行這個服務。

`index.mjs` 是 Cloudflare Worker 相容入口，需綁定 D1 為 `DB`，由部署平台以 `tutor-schema.sql` 管理 migration，不在請求期間建立表。執行期設定：

| 名稱 | 設定 |
| --- | --- |
| `OPENAI_API_KEY` | 在後端的 secret 中保存，不寫入程式或 GitHub Pages |
| `OPENAI_MODEL` | 帳號可用、支援 Chat Completions 與 JSON Schema 結構化輸出的模型 |
| `PILOT_ACCESS_CODE` | 至少 16 字元的隨機試用通行碼，建議 32 字元以上；不是 OpenAI 金鑰 |
| `ALLOWED_ORIGIN` | `https://hectornet.github.io` |
| `MAX_DAILY_REQUESTS` | 全服務每日模型請求上限，預設 100，最高 1000 |
| `MAX_MINUTE_REQUESTS` | 全服務每分鐘模型請求上限，預設 10，最高 50 |

通行碼是共用試用入口，不能當作個別學生身分驗證。金鑰及通行碼由後端 secret 管理，不放入前端、環境範例或 hosting manifest。

服務提供經通行碼保護的 `GET /api/status` 及 `POST /api/tutor`；CORS 僅允許設定的來源，另外仍要求通行碼。模型只收到伺服器依 bank_id 找出的公開題目和學生當次提問。只接受固定 card enum，模型自由文字、多餘欄位、連線或格式錯誤都退回規則提示。批改、步驟檢查及進度證據仍由原本數學引擎處理。

D1 僅保留額度計數、隨機請求 ID、請求雜湊和 enum 結果，不存提問、暱稱或金鑰；每次新請求清理兩天前的紀錄。重送會回傳快取；仍在處理時回報 409，不再次呼叫模型。額度在呼叫前計入，失敗或被分鐘上限擋下也可能耗用當日額度，採保守試用限額。

部署後，在網站「AI 連線設定」填服務 HTTPS 網址與試用通行碼。網址保存在本機偏好，通行碼只保留於目前頁籤；切換檔案會清除通行碼。連線檢查通過只表示後端配置齊全，實際提問成功才顯示「AI 輔導」。未接通前明確維持「規則輔導」。
