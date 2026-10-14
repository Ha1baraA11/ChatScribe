<div align="center">
  <img src="assets/brand/chatscribe-logo-master.png" width="180" alt="Icono del camaleón exportador de ChatScribe" />
  <h1>ChatScribe</h1>
  <p><strong>Copia o exporta conversaciones de chatgpt.com.</strong><br />
  Copia la conversación completa, la respuesta más reciente o los mensajes que elijas.</p>
  <p>Descarga en Markdown, texto, JSON o CSV, o guarda una exportación Markdown en GitHub.</p>
  <p><a href="https://chrome.google.com/webstore/detail/aapnhkibnnhppanchcfngalkkojjfcmf">Instala ChatScribe desde Chrome Web Store</a></p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_es.md">Español</a> · <a href="README_pt-BR.md">Português (Brasil)</a> · <a href="README_ru.md">Русский</a> · <a href="README_fr.md">Français</a> · <a href="README_de.md">Deutsch</a></p>
</div>

<hr>

## Funciones

- Copia al portapapeles la conversación completa, la respuesta más reciente del asistente o los mensajes seleccionados.
- Selecciona mensajes individualmente. Filtra por usuario o asistente, selecciona todos o ninguno, invierte la selección y amplía las vistas previas.
- Exporta la conversación completa o los mensajes seleccionados a Markdown, texto, JSON o CSV.
- Si quieres, descarga las imágenes de la conversación —incluidas las imágenes generadas disponibles en la página— y agrúpalas con el Markdown en un ZIP. El Markdown enlaza las imágenes mediante rutas relativas.
- En las exportaciones Markdown, las plantillas de diagramas SVG compatibles se convierten en imágenes PNG. En texto se muestra el marcador `[Diagram]`; las plantillas no compatibles se conservan tal cual.
- Guarda una exportación Markdown en el directorio `exports/` del repositorio de GitHub que elijas. Si incluye imágenes, se guarda como ZIP.
- Configura el tema, el idioma de la interfaz, los encabezados y el espacio entre mensajes, las marcas de tiempo, la confirmación de descarga y el empaquetado de imágenes.

La interfaz está disponible en inglés, chino, alemán, español, francés y ruso. Detecta automáticamente un idioma compatible del navegador; si no lo está, usa inglés.

## Instalación desde el código fuente

Usa Node.js 22 y npm.

### Chrome

~~~sh
npm ci
npm run build:chrome
~~~

Abre `chrome://extensions`, activa el modo de desarrollador, elige **Load unpacked** y selecciona el directorio `dist/` generado. Consulta la [guía de Chrome para cargar una extensión sin empaquetar](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world).

### Firefox

Se requiere Firefox 140 o posterior en escritorio y Firefox para Android 142 o posterior.

~~~sh
npm ci
npm run build:firefox
~~~

Abre `about:debugging`, elige **This Firefox** y **Load Temporary Add-on**, y selecciona `dist-firefox/manifest.json`. Firefox elimina los complementos temporales al reiniciarse. Consulta la [guía de instalación temporal de Mozilla](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

La compilación de Chrome se genera en `dist/` y la de Firefox en `dist-firefox/`; los directorios son independientes.

## Comprobaciones de desarrollo

~~~sh
npm run typecheck
npm run test:run
npm run build
~~~

El flujo de CI ejecuta estas comprobaciones con Node.js 22. Para crear una extensión específica para un navegador, usa `npm run build:chrome` o `npm run build:firefox`.

## Privacidad

La extensión procesa el contenido de la conversación para realizar la acción que elijas. Solo envía contenido a GitHub cuando seleccionas explícitamente guardarlo allí. Consulta la [política de privacidad](docs/privacy-policy.md); antes de publicarla, aloja una copia en una URL pública y asegúrate de que coincida con las prácticas de datos de la extensión.

## Agradecimientos

ChatScribe se desarrolla de forma independiente. La idea del proyecto se inspiró en [AI Exporter, de Grant Totinov](https://github.com/GrantTotinov/AIExporter); gracias a Grant. ChatScribe no depende del código fuente de AI Exporter, no está afiliado ni cuenta con el respaldo oficial de Grant Totinov, ChatGPT u OpenAI y no es un producto oficial de ninguno de ellos.

## Licencia

El software original de ChatScribe se distribuye bajo la [PolyForm Noncommercial License 1.0.0](LICENSE). Permite usos no comerciales, incluidos los personales, de investigación y educativos; el uso comercial requiere un permiso independiente de la persona titular de los derechos de autor. Las dependencias y los recursos de terceros siguen sujetos a sus propias licencias. Es una licencia de código fuente disponible para uso no comercial, no una licencia de código abierto según la definición de la OSI.
