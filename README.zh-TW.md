<div align="center">
  <img src="assets/brand/chatscribe-logo-master.png" width="180" alt="ChatScribe 變色龍匯出圖示" />
  <h1>ChatScribe</h1>
  <p><strong>複製或匯出 chatgpt.com 上的對話。</strong><br />
  可複製整段對話、最近一則回答，或自行選取的訊息。</p>
  <p>支援 Markdown、純文字、JSON 和 CSV，也可將 Markdown 匯出內容儲存至 GitHub。</p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_es.md">Español</a> · <a href="README_pt-BR.md">Português (Brasil)</a> · <a href="README_ru.md">Русский</a> · <a href="README_fr.md">Français</a> · <a href="README_de.md">Deutsch</a></p>
</div>

<hr>

## 功能

- 將整段對話、最近一則助理回答或選取的訊息複製到剪貼簿。
- 可逐則選取訊息，依使用者或助理篩選、全選、取消全選、反向選取，並展開訊息預覽。
- 將整段對話或選取的訊息匯出為 Markdown、純文字、JSON 或 CSV。
- 可選擇下載對話中的圖片（包含頁面上可取得的生成圖片），並與 Markdown 一起打包成 ZIP。Markdown 會以相對路徑連結圖片檔案。
- 匯出 Markdown 時，可將支援的 SVG 圖表範本轉換為 PNG 圖片。純文字會以 `[Diagram]` 作為佔位；不支援的範本則保留原樣。
- 將 Markdown 匯出內容儲存至自行選取的 GitHub 儲存庫 `exports/` 目錄。若匯出包含圖片，會以 ZIP 儲存。
- 可設定佈景主題、介面語言、訊息標題與間距、匯出時間戳記、下載位置提示和圖片打包選項。

介面支援英文、中文、德文、西班牙文、法文和俄文。可自動偵測支援的瀏覽器語言；若不支援，則使用英文。

## 從原始碼安裝

請使用 Node.js 22 和 npm。

### Chrome

~~~sh
npm ci
npm run build:chrome
~~~

開啟 `chrome://extensions`，啟用開發人員模式，選擇 **Load unpacked（載入未封裝項目）**，再選取產生的 `dist/` 目錄。請參閱 [Chrome 未封裝擴充功能指南](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)。

### Firefox

桌面版 Firefox 需為 140 或更新版本；Android 版 Firefox 需為 142 或更新版本。

~~~sh
npm ci
npm run build:firefox
~~~

開啟 `about:debugging`，選擇 **This Firefox** 和 **Load Temporary Add-on**，再選取 `dist-firefox/manifest.json`。Firefox 重新啟動後會移除臨時附加元件。請參閱 [Mozilla 臨時安裝指南](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)。

Chrome 建置輸出至 `dist/`，Firefox 建置輸出至 `dist-firefox/`，兩者不會互相覆蓋。

## 開發檢查

~~~sh
npm run typecheck
npm run test:run
npm run build
~~~

CI 工作流程使用 Node.js 22 執行這些檢查。若要產生特定瀏覽器的擴充功能套件，請執行 `npm run build:chrome` 或 `npm run build:firefox`。

## 隱私

擴充功能只會為了執行你選擇的操作而處理對話內容。只有在你明確選擇儲存至 GitHub 時，內容才會傳送至 GitHub。詳見[隱私權政策](docs/privacy-policy.md)；上架前請將政策發布至公開網址，並確保內容與擴充功能實際的資料處理方式一致。

## 致謝

ChatScribe 由維護者獨立開發。專案構想受到 Grant Totinov 的 [AI Exporter](https://github.com/GrantTotinov/AIExporter) 啟發，感謝 Grant。ChatScribe 不依賴 AI Exporter 的原始碼，也與 Grant Totinov、ChatGPT 或 OpenAI 均無官方關聯或背書，並非其中任何一方的官方產品。

## 授權

ChatScribe 的原創軟體採用 [PolyForm 非商業授權條款 1.0.0](LICENSE)。此授權允許非商業用途，包括個人、研究及教育用途；商業用途須另行取得著作權持有者的許可。第三方相依套件與素材仍適用各自的授權條款。這是原始碼可見的非商業授權，不屬於 OSI 定義的開源授權。
