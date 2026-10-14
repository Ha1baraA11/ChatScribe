<div align="center">
  <img src="assets/brand/chatscribe-logo-master.png" width="180" alt="Chamäleon-Exportsymbol von ChatScribe" />
  <h1>ChatScribe</h1>
  <p><strong>Unterhaltungen auf chatgpt.com kopieren oder exportieren.</strong><br />
  Kopiere die gesamte Unterhaltung, die letzte Antwort oder ausgewählte Nachrichten.</p>
  <p>Als Markdown, Text, JSON oder CSV herunterladen oder einen Markdown-Export in GitHub speichern.</p>
  <p><a href="https://chrome.google.com/webstore/detail/aapnhkibnnhppanchcfngalkkojjfcmf">ChatScribe im Chrome Web Store herunterladen</a></p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_es.md">Español</a> · <a href="README_pt-BR.md">Português (Brasil)</a> · <a href="README_ru.md">Русский</a> · <a href="README_fr.md">Français</a> · <a href="README_de.md">Deutsch</a></p>
</div>

<hr>

## Funktionen

- Die gesamte Unterhaltung, die letzte Antwort des Assistenten oder ausgewählte Nachrichten in die Zwischenablage kopieren.
- Nachrichten einzeln auswählen: nach Nutzer oder Assistent filtern, alle oder keine auswählen, Auswahl umkehren und Vorschauen erweitern.
- Die gesamte Unterhaltung oder ausgewählte Nachrichten als Markdown, Text, JSON oder CSV exportieren.
- Optional Unterhaltungsbilder herunterladen, einschließlich der auf der Seite verfügbaren generierten Bilder, und zusammen mit Markdown in einer ZIP-Datei bündeln. Markdown verlinkt die Bilddateien über relative Pfade.
- Unterstützte SVG-Diagrammvorlagen werden beim Markdown-Export in PNG-Dateien umgewandelt. In der Textausgabe erscheinen sie als `[Diagram]`; nicht unterstützte Vorlagen bleiben unverändert.
- Einen Markdown-Export im Verzeichnis `exports/` eines GitHub-Repositories deiner Wahl speichern. Enthält der Export Bilder, wird er als ZIP gespeichert.
- Design, Oberflächensprache, Nachrichtenüberschriften und -abstände, Zeitstempel, Download-Abfrage und Bildpakete konfigurieren.

Die Oberfläche ist auf Englisch, vereinfachtem und traditionellem Chinesisch, Deutsch, Spanisch, Französisch, Japanisch, Koreanisch, brasilianischem Portugiesisch und Russisch verfügbar. Die Browsersprache wird automatisch erkannt; bei nicht unterstützten Sprachen wird Englisch verwendet.

## Installation aus dem Quellcode

Verwende Node.js 22 und npm.

### Chrome

~~~sh
npm ci
npm run build:chrome
~~~

Öffne `chrome://extensions`, aktiviere den Entwicklermodus, wähle **Load unpacked** und anschließend das erzeugte Verzeichnis `dist/`. Siehe die [Chrome-Anleitung zum Laden einer ungepackten Erweiterung](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world).

### Firefox

Auf dem Desktop wird Firefox 140 oder neuer benötigt, unter Android Firefox 142 oder neuer.

~~~sh
npm ci
npm run build:firefox
~~~

Öffne `about:debugging`, wähle **This Firefox** und **Load Temporary Add-on** und dann `dist-firefox/manifest.json`. Temporäre Add-ons werden beim Neustart von Firefox entfernt. Siehe Mozillas [Anleitung zur temporären Installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

Der Chrome-Build wird in `dist/`, der Firefox-Build in `dist-firefox/` erstellt. Die Verzeichnisse sind getrennt.

## Entwicklungsprüfungen

~~~sh
npm run typecheck
npm run test:run
npm run build
~~~

Der CI-Workflow führt diese Prüfungen mit Node.js 22 aus. Für ein browser-spezifisches Paket verwendest du `npm run build:chrome` oder `npm run build:firefox`.

## Datenschutz

Die Erweiterung verarbeitet Gesprächsinhalte, um die von dir gewählte Aktion auszuführen. Inhalte werden nur dann an GitHub gesendet, wenn du ausdrücklich das Speichern dort auswählst. Siehe die [Datenschutzerklärung](docs/privacy-policy.md); vor der Veröffentlichung muss sie unter einer öffentlichen URL erreichbar sein und mit den tatsächlichen Datenpraktiken der Erweiterung übereinstimmen.

## Danksagung

ChatScribe wird unabhängig entwickelt. Die Projektidee wurde von [AI Exporter von Grant Totinov](https://github.com/GrantTotinov/AIExporter) inspiriert. Danke an Grant. ChatScribe verwendet AI Exporter nicht als Quellcode-Abhängigkeit, ist weder mit Grant Totinov, ChatGPT noch OpenAI offiziell verbunden oder von ihnen unterstützt und ist kein offizielles Produkt einer dieser Parteien.

## Lizenz

Die originale ChatScribe-Software steht unter der [PolyForm Noncommercial License 1.0.0](LICENSE). Sie erlaubt nichtkommerzielle Nutzung, einschließlich privater, wissenschaftlicher und Bildungszwecke; für eine kommerzielle Nutzung ist eine gesonderte Genehmigung der Rechteinhaberin oder des Rechteinhabers erforderlich. Für Abhängigkeiten und Materialien Dritter gelten weiterhin deren jeweilige Lizenzen. Dies ist eine Lizenz mit einsehbarem Quellcode für nichtkommerzielle Nutzung, keine Open-Source-Lizenz nach der Definition der OSI.
