# 백그라운드 번역 설치

SillyTavern 설치 폴더에 있는 터미널에서 실행합니다. 먼저 Interpres Custom 확장 파일을 이 버전으로 업데이트합니다.

```bash
find data public -path '*/server-plugin/install.cjs' -exec node {} \;
```

설치 완료 문구가 나오면 SillyTavern 서버를 재시작합니다. 확장의 **모델 → 커넥션 프로필**에서 Vertex AI 또는 Google AI Studio 연결을 고르고 **서버에서 백그라운드 번역**을 켭니다. 서버 플러그인은 `plugins/interpres-background`에 설치되며 `config.yaml`의 `enableServerPlugins`를 활성화합니다. 최초 설정 파일은 `.before-interpres-background` 파일로 백업합니다.

기존 Vertex 연결 분리 패치를 적용한 서버를 기준으로 합니다. 번역할 모든 조각과 번역용 프롬프트를 서버에 한 번에 전송합니다. 서버는 기존 SillyTavern API 처리 코드와 서버에 저장된 키를 사용하며, 결과를 메모리에 최대 2시간 보관합니다. 브라우저 화면이 중단되어도 서버가 조각 번역과 검증 재시도를 처리합니다. 같은 탭으로 돌아오거나 새로고침하면 결과를 조회합니다. 원문이 바뀐 메시지나 다른 스와이프에 결과를 적용하지 않습니다. 브라우저가 생성된 원문을 받기 전에 정지하면 번역 작업을 시작할 수 없습니다.

SillyTavern 서버가 종료되거나 재시작되면 작업과 결과가 사라집니다. Termux에서는 `termux-wake-lock`을 실행하고 Android의 Termux 배터리 설정을 제한 없음으로 설정해야 합니다. 이는 운영체제의 강제 종료까지 보장하지 않습니다. 탭을 닫으면 자동 복귀 정보가 사라질 수 있습니다. 대기 중인 작업은 해당 메시지의 취소 버튼으로 취소합니다. 설정을 끄면 다음 번역부터 브라우저 방식으로 처리합니다.

범위: Vertex AI·Google AI Studio의 커넥션 프로필을 지원합니다. 현재 채팅 연결·직접 입력 API·리버스 프록시는 서버 번역을 지원하지 않습니다. 서버 번역을 켠 상태로 다른 방으로 이동하거나 스와이프하면 해당 작업을 취소합니다. 여러 메시지 일괄 번역은 현재 메시지 작업만 서버에 전송되며 다음 메시지는 브라우저 복귀 후 시작합니다.

제거: 실행 중 작업을 취소하고 설정을 끈 다음, `plugins/interpres-background` 폴더를 제거하고 서버를 재시작합니다. 다른 서버 플러그인이 있다면 `enableServerPlugins`를 끄지 마세요.

검증은 가짜 API와 Node 테스트로 수행했습니다. 사용자 휴대폰·실제 Google API를 통한 검증은 별도로 필요합니다.
