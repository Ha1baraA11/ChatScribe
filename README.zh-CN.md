<div align="center">
  <img src="assets/brand/chatscribe-logo-master.png" width="180" alt="ChatScribe 变色龙导出图标" />
  <h1>ChatScribe</h1>
  <p><strong>复制或导出 chatgpt.com 上的对话。</strong><br />
  可复制整段对话、最近一条回答，或自行选择的消息。</p>
  <p>支持 Markdown、纯文本、JSON 和 CSV，也可将 Markdown 导出保存到 GitHub。</p>
  <p><a href="https://chrome.google.com/webstore/detail/aapnhkibnnhppanchcfngalkkojjfcmf">在 Chrome 网上应用店获取 ChatScribe</a></p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_es.md">Español</a> · <a href="README_pt-BR.md">Português (Brasil)</a> · <a href="README_ru.md">Русский</a> · <a href="README_fr.md">Français</a> · <a href="README_de.md">Deutsch</a></p>
</div>

<hr>

## 功能

- 将整段对话、最近一条助手回答或选定的消息复制到剪贴板。
- 可逐条选择消息，按用户或助手筛选，全选、取消全选、反选，并展开消息预览。
- 将整段对话或选定消息导出为 Markdown、纯文本、JSON 或 CSV。
- 可选下载对话中的图片（包括页面中可获取的生成图片），并与 Markdown 一起打包为 ZIP。Markdown 会通过相对路径链接图片文件。
- 导出 Markdown 时，可将支持的 SVG 图表模板渲染为 PNG 图片。纯文本中以 `[Diagram]` 占位；不支持的模板会保留原样。
- 将 Markdown 导出保存到自行选择的 GitHub 仓库的 `exports/` 目录。导出包含图片时会保存为 ZIP。
- 可设置主题、界面语言、消息标题与间距、导出时间戳、下载位置提示和图片打包选项。

界面支持英语、中文、德语、西班牙语、法语和俄语。可以自动检测受支持的浏览器语言；不支持时会回退到英语。

## 从源码安装

使用 Node.js 22 和 npm。

### Chrome

~~~sh
npm ci
npm run build:chrome
~~~

打开 `chrome://extensions`，启用开发者模式，选择 **Load unpacked（加载已解压的扩展程序）**，然后选中生成的 `dist/` 目录。参见 [Chrome 未打包扩展加载指南](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)。

### Firefox

桌面版 Firefox 需为 140 或更高版本；Android 版 Firefox 需为 142 或更高版本。

~~~sh
npm ci
npm run build:firefox
~~~

打开 `about:debugging`，选择 **This Firefox** 和 **Load Temporary Add-on**，然后选中 `dist-firefox/manifest.json`。Firefox 重启后会移除临时附加组件。参见 [Mozilla 临时安装指南](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)。

Chrome 构建输出到 `dist/`，Firefox 构建输出到 `dist-firefox/`，两者互不覆盖。

## 开发检查

~~~sh
npm run typecheck
npm run test:run
npm run build
~~~

CI 工作流使用 Node.js 22 执行这些检查。要生成浏览器专用扩展包，请运行 `npm run build:chrome` 或 `npm run build:firefox`。

## 隐私

扩展只在执行你选择的操作时处理对话内容。只有在你明确选择保存到 GitHub 时，内容才会发送到 GitHub。详见[隐私政策](docs/privacy-policy.md)；上架前请将其发布到公开网址，并确保内容与扩展实际的数据处理方式一致。

## 致谢

ChatScribe 由维护者独立开发。项目思路受到 Grant Totinov 的 [AI Exporter](https://github.com/GrantTotinov/AIExporter) 启发，感谢 Grant。ChatScribe 不依赖 AI Exporter 的源代码，也与 Grant Totinov、ChatGPT 或 OpenAI 均无官方关联或背书，不是其中任何一方的官方产品。

## 许可证

ChatScribe 的原创软件采用 [PolyForm 非商业许可证 1.0.0](LICENSE)。该许可证允许非商业用途，包括个人、研究和教育用途；商业用途需另行获得版权持有者许可。第三方依赖和素材仍适用各自的许可证。这是一种源代码可见的非商业许可证，不属于 OSI 定义的开源许可证。
