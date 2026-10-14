<div align="center">
  <img src="assets/brand/chatscribe-logo-master.png" width="180" alt="ChatScribe chameleon export logo" />
  <h1>ChatScribe</h1>
  <p><strong>Copy or export conversations from chatgpt.com.</strong><br />
  Copy the full conversation, the latest answer, or selected messages.</p>
  <p>Download as Markdown, plain text, JSON, or CSV—or save a Markdown export to GitHub.</p>
  <p><a href="https://chrome.google.com/webstore/detail/aapnhkibnnhppanchcfngalkkojjfcmf">Get ChatScribe on the Chrome Web Store</a></p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_es.md">Español</a> · <a href="README_pt-BR.md">Português (Brasil)</a> · <a href="README_ru.md">Русский</a> · <a href="README_fr.md">Français</a> · <a href="README_de.md">Deutsch</a></p>
</div>

<hr>

## Features

- Copy the full conversation, the latest assistant answer, or selected messages to the clipboard.
- Select messages individually. Filter by user or assistant, select all or none, invert the selection, and expand message previews.
- Export the full conversation or selected messages as Markdown, plain text, JSON, or CSV.
- Optionally download conversation images, including generated images available in the page, and bundle them with Markdown in a ZIP. Markdown links to the image files with relative paths.
- Render supported SVG diagram templates as PNG assets in Markdown exports. Plain-text output uses a `[Diagram]` placeholder; unsupported templates are kept as provided.
- Save a Markdown export to the `exports/` directory of a GitHub repository you choose. Exports with images are saved as a ZIP.
- Set the theme, interface language, message headings and spacing, export timestamps, download prompts, and image bundling.

The interface is available in English, Simplified Chinese, Traditional Chinese, German, Spanish, French, Japanese, Korean, Brazilian Portuguese, and Russian. It detects a supported browser language automatically and falls back to English otherwise.

## Install from source

Use Node.js 22 and npm.

### Chrome

~~~sh
npm ci
npm run build:chrome
~~~

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated `dist/` directory. See [Chrome's guide to loading an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world).

### Firefox

Firefox 140 or later is required on desktop; Firefox for Android requires version 142 or later.

~~~sh
npm ci
npm run build:firefox
~~~

Open `about:debugging`, choose **This Firefox** and **Load Temporary Add-on**, then select `dist-firefox/manifest.json`. Firefox removes temporary add-ons when it restarts. See [Mozilla's temporary installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

Chrome builds go to `dist/`; Firefox builds go to `dist-firefox/`. The output directories are separate.

## Development checks

~~~sh
npm run typecheck
npm run test:run
npm run build
~~~

The CI workflow runs these checks with Node.js 22. Use `npm run build:chrome` or `npm run build:firefox` to create a browser-specific extension.

## Privacy

Conversation content is processed by the extension to carry out the action you choose. It is sent to GitHub only when you explicitly save an export there. See the [privacy policy](docs/privacy-policy.md); before publishing, host it at a public URL and keep it aligned with the extension's data practices.

## Acknowledgments

ChatScribe is developed independently. The project idea was inspired by [AI Exporter by Grant Totinov](https://github.com/GrantTotinov/AIExporter); thank you, Grant. ChatScribe does not use AI Exporter as a source-code dependency and is not affiliated with or endorsed by Grant Totinov, ChatGPT, or OpenAI. It is not an official product of any of them.

## License

ChatScribe's original software is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). It permits noncommercial use, including personal, research, and educational uses; commercial use requires separate permission from the copyright holder. Third-party dependencies and assets remain subject to their own licenses. This is a source-available license, not an OSI open-source license.
