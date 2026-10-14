<div align="center">
  <img src="assets/brand/chatscribe-logo-master.png" width="180" alt="ChatScribe 카멜레온 내보내기 아이콘" />
  <h1>ChatScribe</h1>
  <p><strong>chatgpt.com 대화를 복사하거나 내보내세요.</strong><br />
  전체 대화, 최신 답변 또는 선택한 메시지만 복사할 수 있습니다.</p>
  <p>Markdown, 텍스트, JSON, CSV로 저장하거나 Markdown 내보내기를 GitHub에 저장할 수 있습니다.</p>
  <p><a href="https://chrome.google.com/webstore/detail/aapnhkibnnhppanchcfngalkkojjfcmf">Chrome 웹 스토어에서 ChatScribe 설치</a></p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_es.md">Español</a> · <a href="README_pt-BR.md">Português (Brasil)</a> · <a href="README_ru.md">Русский</a> · <a href="README_fr.md">Français</a> · <a href="README_de.md">Deutsch</a></p>
</div>

<hr>

## 기능

- 전체 대화, 가장 최근의 어시스턴트 답변 또는 선택한 메시지를 클립보드에 복사합니다.
- 메시지를 하나씩 선택할 수 있습니다. 사용자 또는 어시스턴트 메시지로 필터링하고, 전체 선택·해제, 선택 반전, 미리 보기 펼치기를 사용할 수 있습니다.
- 전체 대화 또는 선택한 메시지를 Markdown, 텍스트, JSON, CSV로 내보냅니다.
- 필요하면 페이지에서 확인할 수 있는 생성 이미지를 포함해 대화 이미지를 다운로드하고 Markdown과 함께 ZIP으로 묶습니다. Markdown은 상대 경로로 이미지 파일을 연결합니다.
- Markdown 내보내기에서 지원되는 SVG 다이어그램 템플릿을 PNG 이미지로 렌더링합니다. 텍스트 내보내기에서는 `[Diagram]`으로 표시하며, 지원되지 않는 템플릿은 원문 그대로 둡니다.
- 선택한 GitHub 저장소의 `exports/` 디렉터리에 Markdown 내보내기를 저장합니다. 이미지가 포함된 경우 ZIP으로 저장됩니다.
- 테마, 인터페이스 언어, 메시지 제목과 간격, 내보내기 시간, 저장 위치 확인, 이미지 묶음 옵션을 설정할 수 있습니다.

인터페이스는 영어, 중국어(간체·번체), 독일어, 스페인어, 프랑스어, 일본어, 한국어, 브라질 포르투갈어, 러시아어를 지원합니다. 브라우저 언어를 자동 감지하며, 지원되지 않는 언어는 영어로 표시합니다.

## 소스에서 설치

Node.js 22와 npm을 사용하세요.

### Chrome

~~~sh
npm ci
npm run build:chrome
~~~

`chrome://extensions`를 열고 Developer mode를 켠 다음 **Load unpacked**를 선택해 생성된 `dist/` 디렉터리를 지정하세요. 자세한 내용은 [Chrome의 압축 해제된 확장 프로그램 설치 안내](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)를 참고하세요.

### Firefox

데스크톱 Firefox는 140 이상, Android Firefox는 142 이상이 필요합니다.

~~~sh
npm ci
npm run build:firefox
~~~

`about:debugging`에서 **This Firefox**와 **Load Temporary Add-on**을 선택한 뒤 `dist-firefox/manifest.json`을 지정하세요. 임시 부가 기능은 Firefox를 다시 시작하면 제거됩니다. [Mozilla 임시 설치 안내](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)를 참고하세요.

Chrome 빌드는 `dist/`, Firefox 빌드는 `dist-firefox/`에 생성되며 서로 덮어쓰지 않습니다.

## 개발 확인

~~~sh
npm run typecheck
npm run test:run
npm run build
~~~

CI는 Node.js 22에서 위 확인을 실행합니다. 브라우저별 확장 프로그램을 만들려면 `npm run build:chrome` 또는 `npm run build:firefox`를 사용하세요.

## 개인정보 보호

대화 내용은 사용자가 선택한 작업을 수행하기 위해 확장 프로그램 안에서 처리됩니다. 사용자가 GitHub 저장을 명시적으로 선택한 경우에만 내용이 GitHub로 전송됩니다. 자세한 내용은 [개인정보 처리방침](docs/privacy-policy.md)을 확인하세요. 현재 영어 초안이며 공개 전에 유지관리자 연락처를 추가해야 합니다.

## 감사의 말

ChatScribe는 유지 관리자가 독립적으로 개발합니다. 프로젝트 아이디어는 Grant Totinov의 [AI Exporter](https://github.com/GrantTotinov/AIExporter)에서 영감을 받았습니다. Grant에게 감사드립니다. ChatScribe는 AI Exporter의 소스 코드에 의존하지 않으며 Grant Totinov, ChatGPT 또는 OpenAI와 공식 제휴·보증 관계가 없고 어느 쪽의 공식 제품도 아닙니다.

## 라이선스

ChatScribe의 독자적인 소프트웨어는 [PolyForm Noncommercial License 1.0.0](LICENSE)에 따라 제공됩니다. 개인, 연구, 교육 목적을 포함한 비상업적 사용은 허용되며, 상업적 사용에는 저작권자의 별도 허가가 필요합니다. 타사 종속성과 자료에는 각각의 라이선스가 적용됩니다. 이는 소스 공개형 비상업 라이선스이며 OSI가 정의하는 오픈소스 라이선스는 아닙니다.
