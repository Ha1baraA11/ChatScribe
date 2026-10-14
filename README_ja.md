<div align="center">
  <img src="assets/brand/chatscribe-logo-master.png" width="180" alt="ChatScribe のカメレオン書き出しアイコン" />
  <h1>ChatScribe</h1>
  <p><strong>chatgpt.com の会話をコピーまたはエクスポートできます。</strong><br />
  会話全体、最新の回答、または選択したメッセージをコピーできます。</p>
  <p>Markdown、テキスト、JSON、CSV で保存でき、Markdown は GitHub にも保存できます。</p>
  <p><a href="https://chrome.google.com/webstore/detail/aapnhkibnnhppanchcfngalkkojjfcmf">Chrome ウェブストアから ChatScribe を入手</a></p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_es.md">Español</a> · <a href="README_pt-BR.md">Português (Brasil)</a> · <a href="README_ru.md">Русский</a> · <a href="README_fr.md">Français</a> · <a href="README_de.md">Deutsch</a></p>
</div>

<hr>

## 機能

- 会話全体、最新のアシスタント回答、または選択したメッセージをクリップボードにコピーできます。
- メッセージを個別に選択できます。ユーザーまたはアシスタントで絞り込み、全選択、全解除、選択の反転、プレビューの展開ができます。
- 会話全体または選択したメッセージを Markdown、テキスト、JSON、CSV でエクスポートできます。
- 必要に応じて、ページ上で取得できる生成画像を含む会話内の画像をダウンロードし、Markdown と一緒に ZIP にまとめられます。Markdown から画像ファイルへは相対パスでリンクします。
- Markdown のエクスポートでは、対応する SVG 図テンプレートを PNG 画像として出力できます。テキスト出力では `[Diagram]` と表示し、未対応のテンプレートはそのまま残します。
- 選択した GitHub リポジトリの `exports/` ディレクトリに Markdown を保存できます。画像を含む場合は ZIP で保存します。
- テーマ、表示言語、メッセージの見出しと間隔、エクスポート日時、保存先の確認、画像の ZIP 化を設定できます。

UI は英語、中国語、ドイツ語、スペイン語、フランス語、ロシア語に対応しています。対応言語はブラウザーから自動検出され、未対応の場合は英語になります。

## ソースからインストール

Node.js 22 と npm を使用してください。

### Chrome

~~~sh
npm ci
npm run build:chrome
~~~

`chrome://extensions` を開き、デベロッパーモードを有効にして **Load unpacked** を選び、生成された `dist/` ディレクトリを指定します。[Chrome の unpacked 拡張機能ガイド](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)も参照してください。

### Firefox

デスクトップ版 Firefox 140 以降が必要です。Android 版 Firefox は 142 以降に対応しています。

~~~sh
npm ci
npm run build:firefox
~~~

`about:debugging` を開き、**This Firefox**、**Load Temporary Add-on** の順に選択して、`dist-firefox/manifest.json` を指定します。一時アドオンは Firefox の再起動時に削除されます。[Mozilla の一時インストールガイド](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)を参照してください。

Chrome のビルドは `dist/`、Firefox のビルドは `dist-firefox/` に出力され、互いに上書きしません。

## 開発時のチェック

~~~sh
npm run typecheck
npm run test:run
npm run build
~~~

CI では Node.js 22 でこれらのチェックを実行します。ブラウザー別の拡張機能を作る場合は `npm run build:chrome` または `npm run build:firefox` を使用してください。

## プライバシー

会話内容は、選択した操作を実行するために拡張機能内で処理されます。GitHub に送信されるのは、ユーザーが明示的に GitHub への保存を選んだ場合だけです。詳しくは[プライバシーポリシー](docs/privacy-policy.md)を参照してください。現在は英語の草稿で、公開前にメンテナーの連絡先を追加する必要があります。

## 謝辞

ChatScribe はメンテナーが独立して開発しています。プロジェクトの着想は Grant Totinov の [AI Exporter](https://github.com/GrantTotinov/AIExporter) によるものです。Grant に感謝します。ChatScribe は AI Exporter のソースコードに依存しておらず、Grant Totinov、ChatGPT、OpenAI と提携・公認関係になく、いずれの公式製品でもありません。

## ライセンス

ChatScribe のオリジナルソフトウェアは [PolyForm Noncommercial License 1.0.0](LICENSE) の下で提供されます。個人利用、研究、教育などの非商用利用は許可されます。商用利用には著作権者から別途許可を得る必要があります。サードパーティの依存関係や素材には、それぞれのライセンスが適用されます。これはソースコードを公開する非商用ライセンスであり、OSI が定義するオープンソースライセンスではありません。
