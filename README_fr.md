<div align="center">
  <img src="assets/brand/chatscribe-logo-master.png" width="180" alt="Icône caméléon d’exportation de ChatScribe" />
  <h1>ChatScribe</h1>
  <p><strong>Copiez ou exportez les conversations de chatgpt.com.</strong><br />
  Copiez toute la conversation, la dernière réponse ou les messages de votre choix.</p>
  <p>Téléchargez en Markdown, texte, JSON ou CSV, ou enregistrez un export Markdown sur GitHub.</p>
  <p><a href="https://chrome.google.com/webstore/detail/aapnhkibnnhppanchcfngalkkojjfcmf">Installer ChatScribe depuis le Chrome Web Store</a></p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_es.md">Español</a> · <a href="README_pt-BR.md">Português (Brasil)</a> · <a href="README_ru.md">Русский</a> · <a href="README_fr.md">Français</a> · <a href="README_de.md">Deutsch</a></p>
</div>

<hr>

## Fonctionnalités

- Copiez dans le presse-papiers toute la conversation, la dernière réponse de l’assistant ou les messages sélectionnés.
- Sélectionnez les messages individuellement. Filtrez par utilisateur ou assistant, sélectionnez tout ou rien, inversez la sélection et développez les aperçus.
- Exportez toute la conversation ou les messages sélectionnés en Markdown, texte, JSON ou CSV.
- En option, téléchargez les images de la conversation, y compris les images générées accessibles sur la page, et regroupez-les avec le Markdown dans un ZIP. Le Markdown contient des liens relatifs vers les fichiers image.
- Pour les exports Markdown, les modèles de diagrammes SVG pris en charge sont convertis en images PNG. En texte, ils sont remplacés par `[Diagram]` ; les modèles non pris en charge restent inchangés.
- Enregistrez un export Markdown dans le dossier `exports/` du dépôt GitHub de votre choix. Si l’export contient des images, il est enregistré dans un ZIP.
- Configurez le thème, la langue de l’interface, les titres et l’espacement des messages, les horodatages, la demande de confirmation du téléchargement et l’inclusion des images.

L’interface est disponible en anglais, chinois, allemand, espagnol, français et russe. La langue du navigateur est détectée automatiquement ; si elle n’est pas prise en charge, l’anglais est utilisé.

## Installation depuis les sources

Utilisez Node.js 22 et npm.

### Chrome

~~~sh
npm ci
npm run build:chrome
~~~

Ouvrez `chrome://extensions`, activez le mode développeur, choisissez **Load unpacked**, puis sélectionnez le dossier `dist/` généré. Consultez le [guide Chrome pour charger une extension non empaquetée](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world).

### Firefox

Firefox 140 ou ultérieur est requis sur ordinateur ; Firefox pour Android nécessite la version 142 ou ultérieure.

~~~sh
npm ci
npm run build:firefox
~~~

Ouvrez `about:debugging`, choisissez **This Firefox** puis **Load Temporary Add-on**, et sélectionnez `dist-firefox/manifest.json`. Firefox supprime les modules temporaires au redémarrage. Consultez le [guide d’installation temporaire de Mozilla](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

Le build Chrome est généré dans `dist/` et celui de Firefox dans `dist-firefox/` ; les dossiers sont distincts.

## Vérifications de développement

~~~sh
npm run typecheck
npm run test:run
npm run build
~~~

Le workflow CI exécute ces vérifications avec Node.js 22. Pour créer l’extension d’un navigateur précis, utilisez `npm run build:chrome` ou `npm run build:firefox`.

## Confidentialité

L’extension traite le contenu de la conversation pour effectuer l’action que vous avez choisie. Le contenu n’est envoyé à GitHub que si vous choisissez explicitement de l’y enregistrer. Consultez la [politique de confidentialité](docs/privacy-policy.md) ; avant la publication, hébergez-la à une adresse publique et veillez à ce qu’elle corresponde aux pratiques de traitement des données de l’extension.

## Remerciements

ChatScribe est développé de manière indépendante. L’idée du projet s’inspire de [AI Exporter de Grant Totinov](https://github.com/GrantTotinov/AIExporter) ; merci à Grant. ChatScribe ne dépend pas du code source d’AI Exporter, n’est ni affilié ni officiellement soutenu par Grant Totinov, ChatGPT ou OpenAI, et n’est le produit officiel d’aucun d’entre eux.

## Licence

Le logiciel original de ChatScribe est distribué sous la [PolyForm Noncommercial License 1.0.0](LICENSE). Elle autorise les usages non commerciaux, notamment personnels, de recherche et d’enseignement ; tout usage commercial nécessite une autorisation distincte du titulaire des droits d’auteur. Les dépendances et ressources tierces restent soumises à leurs propres licences. Il s’agit d’une licence à code source accessible pour un usage non commercial, et non d’une licence open source selon la définition de l’OSI.
