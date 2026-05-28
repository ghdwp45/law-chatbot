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

형식: {"laws": ["법령명1", "법령명2"]}
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
    console.log('[DEBUG] 추출된 법령명:', JSON.stringify(parsed));
    return { laws: parsed };

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
  let lawTexts = '', precTexts = '', expcSummary = '', admrulSummary = '';
  let hasLawData = false;
  try {
    const lambdaRes = await fetch(LAMBDA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lawNames, keywords }),
    });
    const lambdaText = await lambdaRes.text();
    const lawData = JSON.parse(lambdaText);
    console.log('[DEBUG] Lambda hasData:', lawData.hasData);
    lawTexts = lawData.lawTexts || '';
    precTexts = lawData.precTexts || '';
    expcSummary = lawData.expcSummary || '';
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
  if (admrulSummary) lawContext += `\n\n[행정규칙 - 법제처 실시간 조회]\n${admrulSummary}`;

  const systemPrompt = `당신은 대한민국 국가법령정보센터 API 데이터를 기반으로 사용자의 법률 질의에 답변하는 수석 전문 법률 AI 어시스턴트입니다.

${hasLawData
  ? `아래는 법제처 API에서 실시간으로 조회한 법령·판례 데이터입니다. 반드시 이 데이터에만 근거하여 답변하십시오. 제공된 데이터에 없는 내용은 임의로 유추하거나 지어내지 마십시오.\n${lawContext}`
  : `이번 질문에 대해 법제처 API 조회 결과가 없습니다. AI 학습 데이터 기반으로만 답변해야 하는 상황입니다.`
}

[절대 규칙]
- 별표(★) 및 신뢰도 표시(★★★ 등) 사용 금지
- 두 섹션(===해설=== / ===관련법령===) 모두 반드시 포함
- 모든 내용에 아래 출처 태그 중 하나를 반드시 표시
- 한국어로만 답변

[출처 태그 4종 - 모든 내용에 필수]
📋 [법령 원문] - 법제처 API에서 가져온 조문만 인용 가능. AI 학습 데이터 기반 법령 내용 인용 절대 금지.
⚖️ [판례/해석례] - 위 <law_data>의 [관련 판례] 섹션에 실제로 존재하는 데이터만 사용 가능. 반드시 사건번호 또는 예규번호를 함께 표기. <law_data>에 판례/해석례 데이터가 없으면 이 태그 사용 절대 금지. 국세청 예규, 기획재정부 해석, 대법원 판례 등을 AI가 기억하고 있더라도 <law_data>에 없으면 절대 사용 불가.
💡 [AI 해설] - 위 API 원문 데이터를 바탕으로 한 AI의 해석 및 실무 설명
⚠️ [AI 추정] - API 데이터 없이 AI 학습 데이터만 사용하는 모든 내용

중요: ⚖️ 태그는 <law_data>에 판례 데이터가 실제로 있을 때만 사용. 없으면 무조건 ⚠️ [AI 추정] 태그 사용.
⚖️ 태그 사용 시 반드시 해당 판례의 사건번호(예: 대법원 2023다12345) 또는 예규번호(예: 부가-1234)를 명시.

${!hasLawData ? `
[⚠️ AI 추정 답변 - 반드시 답변 최상단에 아래 경고문 표시]
╔══════════════════════════════════════╗
⚠️  AI 추정 답변 안내
법제처 API 데이터를 가져오지 못했습니다.
아래 내용은 AI의 자의적 추정이므로
반드시 법제처(law.go.kr)에서 원문을 확인하세요.
╚══════════════════════════════════════╝
모든 내용에 ⚠️ [AI 추정] 태그 사용. 답변 마지막에 "※ 본 답변은 AI 학습 데이터 기반이며, 법적 효력이 없습니다. 정확한 원문은 법제처(law.go.kr)에서 반드시 확인하십시오." 명시.` : ''}

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
