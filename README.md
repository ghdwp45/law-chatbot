# 법령 AI 어시스턴트 (law-chatbot)

대한민국 법령·세무 질문에 답하는 AI 챗봇입니다. 답을 지어내지 않고, **법제처 국가법령정보(law.go.kr)의 실시간 데이터를 먼저 조회한 뒤** 그 원문을 근거로 답변합니다. 답변마다 어떤 근거에서 나온 내용인지 출처 태그(📋 법령 원문 / ⚖️ 판례·해석례 / 💡 AI 해설 / ⚠️ AI 추정)를 붙여, 사용자가 신뢰도를 한눈에 구분할 수 있습니다.

> 쉽게 말하면: 일반 AI 챗봇은 외운 지식으로 그냥 대답하지만, 이 챗봇은 "실제 법 조문을 찾아본 다음" 대답합니다. 그래서 틀린 조문을 지어내는 일(이른바 '환각')을 크게 줄였습니다.

## 주요 기능

- **실시간 법령 조회** — 질문을 받으면 법령명을 검색하고(`search_law`) 필요한 조문 본문만 골라서 가져옵니다(`get_law_text`).
- **판례·예규·심판례 검색** — 법원 판례, 기재부 예규, 국세청 해석, 조세심판원 등 18개 도메인을 통합 검색합니다(`search_decisions` / `get_decision_text`).
- **자동 검증(LLM-judge)** — AI가 만든 답변을 다른 AI가 한 번 더 검사해서, 결론과 근거가 어긋나거나 조회하지 않은 사건번호를 인용한 경우를 잡아내고 필요하면 다시 작성합니다.
- **출처 태그 + 검증 경고** — 원문 확인 없이 내장 지식으로만 답한 부분에는 경고 배너를 붙입니다.
- **스트리밍 응답** — 답변이 생성되는 즉시 화면에 흘려 보내 체감 대기 시간을 줄입니다.
- **클릭 가능한 조문 링크** — 답변 속 조문번호를 누르면 오른쪽 패널에서 해당 법령이 하이라이트되고, 국가법령정보센터 원문으로 바로 연결됩니다.
- **남용 방지** — IP 기준 호출 제한, 과도한 검색·재시도 차단 등 안전장치가 들어 있습니다.

## 기술 스택

- **Next.js 14** (App Router) + **React 18**
- **Anthropic Claude API** (`@anthropic-ai/sdk`) — 답변 생성 및 검증
- **MCP (Model Context Protocol)** (`@modelcontextprotocol/sdk`) — 법제처 데이터 조회 서버(`korean-law-mcp`)와 통신
- 배포: **Vercel**

## 파일 구조

```
law-chatbot/
├── app/
│   ├── layout.js            # 공통 레이아웃 (HTML 뼈대)
│   ├── page.js              # 챗봇 화면 (UI·스트리밍 처리)
│   └── api/chat/route.js    # 백엔드 핵심 로직 (법령 조회·AI 호출·검증)
├── next.config.js
├── package.json
└── README.md
```

## 환경 변수

배포·실행 전에 아래 값을 설정해야 합니다. 로컬에서는 프로젝트 루트에 `.env.local` 파일을 만들어 넣고, Vercel에서는 프로젝트 설정의 Environment Variables에 등록합니다.

| 변수명 | 필수 | 설명 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic Claude API 키 (`sk-ant-...`) |
| `LAW_OC` | ✅ | 법제처 OPEN API 인증 코드(OC). 없으면 법령 조회가 동작하지 않습니다 |
| `GEMINI_API_KEY` | ✅ | Google Gemini API 키. 국세청·K-IFRS·판례 RAG 검색의 쿼리 임베딩에 사용됩니다 |
| `TURSO_DATABASE_URL` | ✅ | Turso(libsql) 데이터베이스 URL. RAG 벡터/전문검색 데이터가 저장된 곳 |
| `TURSO_AUTH_TOKEN` | ✅ | Turso 인증 토큰(로컬 파일 DB가 아니면 필요) |
| `ANSWER_MODEL` | | 답변 생성 모델 (기본: `claude-sonnet-4-6`) |
| `FAST_JUDGE_MODEL` | | 저위험 검증용 모델 (기본: `claude-haiku-4-5`) |
| `STRICT_JUDGE_MODEL` | | 고위험 검증용 모델 (기본: `claude-sonnet-4-6`) |
| `HEALTH_TOKEN` | | 진단 API(`/api/health/rag`) 접근 토큰. 설정 시 이 값이 일치해야 진단 정보를 조회할 수 있습니다 |
| `RATE_LIMIT_MAX` | | IP당 시간창 내 최대 요청 수 (기본: 10) |
| `RATE_LIMIT_WINDOW_MS` | | 요청 제한 시간창(ms) (기본: 60000) |
| `MAX_MESSAGES` | | 한 요청의 최대 대화 메시지 수 (기본: 50) |
| `MAX_INPUT_CHARS` | | 한 요청의 최대 입력 글자 수 (기본: 100000) |

> `LAW_OC`는 법제처 OPEN API([open.law.go.kr](https://open.law.go.kr))에서 신청해 발급받는 사용자 식별 코드입니다.
>
> `GEMINI_API_KEY`·`TURSO_*`는 국세청 질의회신·K-IFRS·판례 검색(로컬 RAG)에 필요합니다. 이 값들이 없으면 법령 조문 조회는 되지만 RAG 검색은 실패합니다. Turso 데이터베이스 스키마는 `turso/001_schema.reference.sql`(재구성 참조본)을 참고하세요.

## 로컬 실행

```bash
npm install
# 루트에 .env.local 파일을 만들고 ANTHROPIC_API_KEY, LAW_OC, GEMINI_API_KEY, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN 를 넣은 뒤
npm run dev
```

브라우저에서 `http://localhost:3000` 접속.

## Vercel 배포

1. 이 저장소를 GitHub에 올린다 (이미 `github.com/ghdwp45/law-chatbot` 에 연결됨).
2. [vercel.com](https://vercel.com)에 GitHub 계정으로 로그인 → `Add New Project` → `law-chatbot` 선택.
3. **Environment Variables**에 `ANTHROPIC_API_KEY`, `LAW_OC`, `GEMINI_API_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`을 등록한다. (필요하면 위 표의 다른 변수도 추가)
4. `Deploy` 클릭 → 완료되면 `https://law-chatbot.vercel.app` 같은 URL이 생성된다.
5. 직원·동료에게는 이 URL만 공유하면 된다. **API 키는 Vercel 서버에만 저장되어 사용자에게 노출되지 않는다.**

## 비용 (참고)

- Vercel 호스팅: 무료 플랜으로 시작 가능
- Anthropic API: 사용량 기반 (월 $5~50 수준)
- 법제처 OPEN API / korean-law MCP: 무료

## 한계 및 주의

- 이 챗봇의 답변은 **참고용**이며 법적 자문을 대체하지 않습니다. 중요한 판단은 반드시 원문과 전문가 확인을 거쳐야 합니다.
- 회계기준(K-IFRS 등) 원문은 이 도구로 직접 조회하지 못하는 경우가 있어, 해당 내용은 `⚠️ [AI 추정]`으로 표시됩니다.
- 국세청 해석례(nts)는 법제처 API가 전문 조회를 지원하지 않아, 제목·문서번호·링크만 인용합니다.
</content>
</invoke>
