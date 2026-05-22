export const maxDuration = 300;

const LAMBDA_URL = "https://25l6ystkmh553nezjtj3vxuram0uqtvv.lambda-url.ap-northeast-2.on.aws";

async function extractLawNames(question, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: `당신은 한국 법령 전문가입니다.
주어진 질문의 의미와 맥락을 파악하여 관련 한국 법령을 추론하고 JSON으로만 응답하세요.

규칙:
1. 질문에 법령명이 명시된 경우: 약칭·축약어를 법제처 공식 명칭으로 변환하세요.
2. 질문에 법령명이 없는 경우: 질문의 주제와 맥락을 파악해 관련 법령을 전문가적으로 추론하세요.
3. 법령명은 반드시 법제처 공식 전체 명칭으로 반환하세요. (예: "외감법" → "주식회사 등의 외부감사에 관한 법률")
4. 최대 3개까지만 반환하세요. 가장 핵심적인 법령 순으로.

형식: {"laws": ["법령명1", "법령명2"]}
JSON 외 다른 텍스트 금지.`,
      messages: [{ role: 'user', content: question }],
    }),
  });
  const data = await res.json();
  const text = data.content?.[0]?.text || '{"laws":[]}';
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean).laws || [];
  } catch { return []; }
}

export async function POST(req) {
  const { messages } = await req.json();
  const lastUserMsg = messages.filter(m => m.role === 'user').at(-1)?.content || '';

  // 1단계: Claude Haiku로 법령명 추출
  const lawNames = await extractLawNames(lastUserMsg, process.env.ANTHROPIC_API_KEY);
  console.log('[DEBUG] 추출된 법령명:', JSON.stringify(lawNames));
  const keywords = lastUserMsg.slice(0, 20);

  // 2단계: Lambda(서울)로 법제처 API 조회
  let lawTexts = '', precTexts = '', expcSummary = '', admrulSummary = '';
  let hasLawData = false;
  try {
    const lambdaRes = await fetch(LAMBDA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lawNames, keywords }),
    });
    const lawData = await lambdaRes.json();
    lawTexts = lawData.lawTexts || '';
    precTexts = lawData.precTexts || '';
    expcSummary = lawData.expcSummary || '';
    admrulSummary = lawData.admrulSummary || '';
    hasLawData = lawData.hasData || false;
  } catch (e) {
    console.error('Lambda 호출 실패:', e.message);
  }

  let lawContext = '';
  if (lawNames.length > 0) lawContext += `\n[관련 법령명: ${lawNames.join(', ')}]`;
  if (lawTexts) lawContext += `\n\n[법령 원문 - 법제처 실시간 조회]\n${lawTexts}`;
  if (precTexts) lawContext += `\n\n[관련 판례 - 법제처 실시간 조회]\n${precTexts}`;
  if (expcSummary) lawContext += `\n\n[해석례 - 법제처 실시간 조회]\n${expcSummary}`;
  if (admrulSummary) lawContext += `\n\n[행정규칙 - 법제처 실시간 조회]\n${admrulSummary}`;

  const systemPrompt = `당신은 한국 법령 전문 AI 어시스턴트입니다.
${hasLawData
  ? `아래는 법제처 API에서 실시간으로 조회한 데이터입니다. 이를 최우선으로 활용하세요.\n${lawContext}`
  : `이번 질문에 대해 법제처 API 조회 결과가 없습니다. AI 학습 데이터 기반으로만 답변합니다.`
}

답변 형식을 반드시 다음과 같이 작성하세요:

===해설===
## 결론
질문에 대한 핵심 답변을 2~3줄로 먼저 요약합니다. (두괄식)

## 상세 해설
각 내용에 반드시 아래 4가지 태그 중 하나를 붙여 출처와 신뢰도를 표시하세요:

📋 [법령 원문] ★★★ - 법제처 API에서 가져온 조문을 그대로 인용 (신뢰도: ★★★)
⚖️ [판례/해석례] ★★★ - 법제처 API 판례·해석례 데이터 기반 (신뢰도: ★★★)
💡 [AI 해설] ★★☆ - 위 원문 데이터를 바탕으로 한 AI의 해석 및 실무 설명 (신뢰도: ★★☆)
⚠️ [AI 추정] ★☆☆ - 법제처 API 조회 실패, AI 학습 데이터만 사용 (신뢰도: ★☆☆, 원문 확인 필요)

${!hasLawData ? '중요: 이번 답변은 법제처 API 조회 실패로 전부 ⚠️ [AI 추정] 태그를 사용하고, 답변 마지막에 "※ 이 답변은 AI 학습 데이터 기반입니다. 정확한 원문은 법제처(law.go.kr)에서 반드시 확인하시기 바랍니다." 라고 명시하세요.' : ''}

판례 인용 시 사건번호도 함께 표기하세요. 충분히 상세하게 작성하세요.
===해설끝===

===관련법령===
법령명|조문번호|설명
===관련법령끝===

절대 규칙: 두 섹션 모두 반드시 포함. 모든 내용에 태그 필수. 한국어로만 답변.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      stream: true,
      system: systemPrompt,
      messages: messages.slice(-4).map(({ role, content }) => ({ role, content })),
    }),
  });

  if (!response.ok) {
    const data = await response.json();
    return Response.json({ error: data.error?.message || 'API 오류' }, { status: response.status });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
                fullText += parsed.delta.text;
                controller.enqueue(new TextEncoder().encode(
                  'data: ' + JSON.stringify({ text: parsed.delta.text }) + '\n\n'
                ));
              }
            } catch {}
          }
        }
        controller.enqueue(new TextEncoder().encode(
          'data: ' + JSON.stringify({ done: true, full: fullText }) + '\n\n'
        ));
      } catch (e) {
        controller.enqueue(new TextEncoder().encode(
          'data: ' + JSON.stringify({ error: e.message }) + '\n\n'
        ));
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
