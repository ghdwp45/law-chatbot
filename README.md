# 법령 AI 어시스턴트 - Vercel 배포 가이드

## 파일 구조
```
law-chatbot/
├── app/
│   ├── layout.js          # 레이아웃
│   ├── page.js            # 챗봇 UI
│   └── api/chat/route.js  # 백엔드 (API 키 여기서 관리)
├── package.json
├── next.config.js
└── .env.example
```

## 배포 순서

### 1단계 - GitHub에 올리기
1. github.com 접속 → 로그인
2. 우측 상단 `+` → `New repository`
3. Repository name: `law-chatbot` → `Create repository`
4. 안내대로 파일 업로드 (Upload files 클릭)
5. 이 폴더 안의 파일들 전부 끌어다 놓기
6. `Commit changes` 클릭

### 2단계 - Vercel에 배포
1. vercel.com 접속 → GitHub 계정으로 로그인
2. `Add New Project` → law-chatbot 선택
3. **중요: Environment Variables 추가**
   - Key: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-...` (API 키)
4. `Deploy` 클릭
5. 완료되면 URL 생성됨 (예: law-chatbot.vercel.app)

### 3단계 - 직원들에게 공유
- 생성된 URL만 보내주면 끝
- API 키는 Vercel 서버에만 있어서 직원들에게 노출 안 됨

## 비용
- Vercel 호스팅: 무료
- Anthropic API: 사용량에 따라 월 $5~50 수준
- Korean Law MCP: 무료
