export const maxDuration = 300;

const LAMBDA_URL = "https://25l6ystkmh553nezjtj3vxuram0uqtvv.lambda-url.ap-northeast-2.on.aws";

// Haiku 호출 결과: { laws: [...], error: "OVERLOADED" 등 } 형태
async function extractLawNames(question, apiKey) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 200,
        system: `당신은 한국 법령 전문가입니다.
주어진 질문의 의미와 맥락을 파악하여 관련 한국 법령을 추론하고 JSON으로만 응답하세요.

규칙:
1. 아래 축약어 테이블을 최우선으로 적용하세요.
2. 테이블에 없는 약칭도 법제처 공식 명칭으로 변환하세요.
3. 법령명이 없으면 주제와 맥락으로 관련 법령을 추론하세요.
4. 최대 3개, 가장 핵심적인 순으로 반환하세요.

[축약어 → 정식명칭]
외감법, 외부감사법 → 주식회사 등의 외부감사에 관한 법률
자본시장법 → 자본시장과 금융투자업에 관한 법률
공정거래법 → 독점규제 및 공정거래에 관한 법률
지배구조법 → 금융회사의 지배구조에 관한 법률
상법 → 상법
근로기준법 → 근로기준법
소득세법 → 소득세법
법인세법 → 법인세법
부가세법 → 부가가치세법
개인정보보호법 → 개인정보 보호법

중요: 질문이 해설, 설명, 검색 등 어떤 형태이든 반드시 관련 법령명만 JSON으로 반환하세요. 거부하거나 다른 텍스트를 출력하지 마세요.

형식: {"laws": ["법령명1", "법령명2"], "taxKeyword": "조세심판원 검색용 핵심 키워드 1~3단어"}
taxKeyword: 질문의 핵심 세무/법률 주제를 반드시 1~2단어로만 추출. 공백 없이 붙여쓰거나 핵심어 하나만. 예: "월합계세금계산서", "부당해고", "연차휴가", "퇴직금"
JSON 외 다른 텍스트 금지.`,
        messages: [{ role: 'user', content: question }],
      }),
    });

    console.log('[DEBUG] Haiku HTTP status:', res.status);
    const data = await res.json();

    if (data.error) {
      console.error('[ERROR] Haiku API 오류:', data.error.message);
      const isOverloaded = data.error.message?.toLowerCase().includes('overload')
        || data.error.type?.toLowerCase().includes('overload');
      return { laws: [], error: isOverloaded ? 'OVERLOADED' : data.error.message };
    }

    const text = data.content?.[0]?.text || '{"laws":[]}';
    console.log('[DEBUG] Haiku text:', text);

    const clean = text.replace(/```json|```/g, '').trim();
    const parsedData = JSON.parse(clean);
    const parsed = parsedData.laws || [];
    const taxKeyword = parsedData.taxKeyword || '';
    console.log('[DEBUG] 추출된 법령명:', JSON.stringify(parsed));
    console.log('[DEBUG] 조세심판원 키워드:', taxKeyword);
    return { laws: parsed, taxKeyword };

  } catch (e) {
    console.error('[ERROR] extractLawNames 실패:', e.message);
    return { laws: [], error: e.message };
  }
}

export async function POST(req) {
  const { messages } = await req.json();
  const lastUserMsg = messages.filter(m => m.role === 'user').at(-1)?.content || '';

  console.log('[DEBUG] 사용자 질문:', lastUserMsg.slice(0, 50));

  // 1단계: Claude Haiku로 법령명 추출
  const haikuResult = await extractLawNames(lastUserMsg, process.env.ANTHROPIC_API_KEY);

  // Overloaded면 즉시 에러 응답
  if (haikuResult.error === 'OVERLOADED') {
    return Response.json(
      { error: 'Overloaded: 서버 과부하 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' },
      { status: 529 }
    );
  }

  const lawNames = haikuResult.laws;
  const keywords = lastUserMsg.slice(0, 100);

  // 2단계: Lambda(서울)로 법제처 API 조회
  let lawTexts = '', precTexts = '', expcSummary = '', ministryInterpTexts = '', taxTribunalTexts = '', admrulSummary = '';
  let hasLawData = false;
  try {
    const lambdaRes = await fetch(LAMBDA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lawNames, keywords, taxKeyword: haikuResult.taxKeyword || '' }),
    });
    const lambdaText = await lambdaRes.text();
    const lawData = JSON.parse(lambdaText);
    console.log('[DEBUG] Lambda hasData:', lawData.hasData);
    lawTexts = lawData.lawTexts || '';
    precTexts = lawData.precTexts || '';
    expcSummary = lawData.expcSummary || '';
    ministryInterpTexts = lawData.ministryInterpTexts || '';
    taxTribunalTexts = lawData.taxTribunalTexts || '';
    admrulSummary = lawData.admrulSummary || '';
    hasLawData = lawData.hasData === true;
  } catch (e) {
    console.error('[ERROR] Lambda 호출 실패:', e.message);
  }

  console.log('[DEBUG] 최종 hasLawData:', hasLawData);

  let lawContext = '';
  if (lawNames.length > 0) lawContext += `\n[관련 법령명: ${lawNames.join(', ')}]`;
  if (lawTexts) lawContext += `\n\n[법령 원문 - 법제처 실시간 조회]\n${lawTexts}`;
  if (precTexts) lawContext += `\n\n[관련 판례 - 법제처 실시간 조회]\n${precTexts}`;
  if (expcSummary) lawContext += `\n\n[해석례 - 법제처 실시간 조회]\n${expcSummary}`;
  if (ministryInterpTexts) lawContext += `\n\n[기획재정부/고용노동부 법령해석례 - 법제처 실시간 조회]\n${ministryInterpTexts}`;
  if (taxTribunalTexts) lawContext += `\n\n[조세심판원 결정례 - 법제처 실시간 조회]\n${taxTribunalTexts}`;

  if (admrulSummary) lawContext += `\n\n[행정규칙 - 법제처 실시간 조회]\n${admrulSummary}`;

  const systemPrompt = `당신은 대한민국 법률 전문가 AI 어시스턴트입니다. 법제처 API 실시간 데이터와 AI 학습 데이터를 결합하여 정확하고 완전한 답변을 제공합니다.

${hasLawData
  ? `아래는 법제처 API에서 실시간으로 조회한 법령·판례 데이터입니다. 이 데이터를 최우선으로 활용하되, API에서 제공되지 않는 기획재정부 예규, 국세청 해석례, 행정해석 등 관련 내용은 AI 학습 데이터로 보완하여 완전한 답변을 제공하십시오.\n${lawContext}`
  : `이번 질문에 대해 법제처 API 조회 결과가 없습니다. AI 학습 데이터 기반으로 답변합니다.`
}

[절대 규칙]
- 별표(★) 및 신뢰도 표시(★★★ 등) 사용 금지
- 두 섹션(===해설=== / ===관련법령===) 모두 반드시 포함
- 모든 내용에 아래 출처 태그 중 하나를 반드시 표시
- 한국어로만 답변

[법적 위계 준수 - 핵심 규칙]
1. 원칙 기준: 세무·법률 판단의 원칙은 반드시 [법령 원문]과 [기획재정부/국세청 예규·해석례]를 기준으로 먼저 서술할 것.
2. 조세심판원/판례의 제한적 해석: [조세심판원 결정례]나 [판례]에서 납세자가 승소하거나 가산세가 취소되었다고 해서, 그 예외적 방식이 세법상 '합법' 또는 '표준 실무'라고 확대 해석 절대 금지.
3. 구조 분리: 답변 시 반드시 [원칙적인 세무 실무]와 [예외적 구제 및 참고 심판례]를 엄격히 분리하여 서술할 것. 심판례는 "예외적 구제 가능성"으로만 제시.
4. 원칙 우선 결론: 핵심 결론은 법령·예규 원칙 기준으로 작성. 심판례로 결론을 뒤집지 말 것.

[출처 태그 4종 - 모든 내용에 필수]
📋 [법령 원문] - 법제처 API에서 가져온 조문 인용 시 사용. AI가 알고 있는 조문 내용도 사용 가능하나 API 데이터 우선.
⚖️ [판례/해석례] - 두 가지 경우 모두 사용 가능:
  1) API 데이터에 있는 판례/해석례: 반드시 사건번호 또는 예규번호 명시
  2) AI 학습 데이터의 판례/해석례(기획재정부 예규, 국세청 해석례 등): 반드시 출처(예규번호, 사건번호) 명시. 단, 출처가 불확실하면 ⚠️[AI 추정] 사용.
💡 [AI 해설] - API 데이터 및 법령 지식을 바탕으로 한 AI의 해석 및 실무 설명
⚠️ [AI 추정] - 출처를 특정할 수 없는 내용, 또는 불확실한 내용

중요: API 데이터와 AI 학습 데이터가 상충할 경우 API 데이터 우선. AI 학습 데이터로 판례/예규 인용 시 반드시 출처 명시.
중요: 제공된 법령·판례·해석례 데이터가 사용자 질문과 명백히 무관하다고 판단될 경우, 억지로 연관 짓지 말고 해당 API 데이터를 무시한 채 AI 학습 지식으로 원칙을 설명할 것.



[답변 형식]
===해설===
# 📌 사안의 쟁점
사용자의 질문을 1~2줄로 명확하고 알기 쉽게 재구성하여 요약

# 💡 핵심 결론
질문에 대한 핵심 답변을 2~3줄로 요약 (두괄식, 명확하게)

# 📖 상세 해설
법령이 사안에 적용되는 과정을 논리적 순서에 따라 설명.
전문 용어는 반드시 쉽게 풀어서 설명할 것.
각 내용마다 위 출처 태그 중 하나를 반드시 앞에 표시할 것.
===해설끝===

===관련법령===
법령명|조문번호|설명
===관련법령끝===`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      stream: true,
      system: systemPrompt,
      messages: messages.slice(-4).map(({ role, content }) => ({ role, content })),
    }),
  });

  if (!response.ok) {
    const data = await response.json();
    const errMsg = data.error?.message || 'API 오류';
    const isOverloaded = errMsg.toLowerCase().includes('overload') || response.status === 529;
    if (isOverloaded) {
      return Response.json(
        { error: 'Overloaded: 서버 과부하 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' },
        { status: 529 }
      );
    }
    return Response.json({ error: errMsg }, { status: response.status });
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
