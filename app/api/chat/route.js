export const maxDuration = 300;

const LAW_API_KEY = "hongjeyeon";
const LAW_API_BASE = "http://www.law.go.kr/DRF";

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
      system: '주어진 질문에서 관련 한국 법령명을 추출하여 JSON으로만 응답하세요. 약칭은 정식명칭으로 변환하세요. 형식: {"laws": ["법령명1", "법령명2"]} 최대 3개. JSON 외 다른 텍스트 금지.',
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

async function searchLaw(query) {
  try {
    const url = `${LAW_API_BASE}/lawSearch.do?OC=${LAW_API_KEY}&target=law&type=JSON&query=${encodeURIComponent(query)}&display=3&sort=efdate`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    return data.LawSearch?.law || [];
  } catch { return []; }
}

async function getLawText(lawId) {
  try {
    const url = `${LAW_API_BASE}/lawService.do?OC=${LAW_API_KEY}&target=law&ID=${lawId}&type=JSON`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    return data.법령 || null;
  } catch { return null; }
}

async function searchPrecedent(query) {
  try {
    const url = `${LAW_API_BASE}/lawSearch.do?OC=${LAW_API_KEY}&target=prec&type=JSON&query=${encodeURIComponent(query)}&display=3&sort=efdate`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    return data.PrecSearch?.prec || [];
  } catch { return []; }
}

async function getPrecedentText(precId) {
  try {
    const url = `${LAW_API_BASE}/lawService.do?OC=${LAW_API_KEY}&target=prec&ID=${precId}&type=JSON`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    return data.PrecService || null;
  } catch { return null; }
}

async function searchInterpretation(query) {
  try {
    const url = `${LAW_API_BASE}/lawSearch.do?OC=${LAW_API_KEY}&target=expc&type=JSON&query=${encodeURIComponent(query)}&display=3`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    return data.ExpcSearch?.expc || [];
  } catch { return []; }
}

async function searchAdminRule(query) {
  try {
    const url = `${LAW_API_BASE}/lawSearch.do?OC=${LAW_API_KEY}&target=admrul&type=JSON&query=${encodeURIComponent(query)}&display=3`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    return data.AdmrulSearch?.admrul || [];
  } catch { return []; }
}

function formatLawText(lawDetail) {
  if (!lawDetail) return '';
  const lawName = lawDetail.기본정보?.법령명_한글 || '';
  const articles = lawDetail.조문?.조문단위;
  if (!articles) return '';
  const artArr = Array.isArray(articles) ? articles : [articles];
  const artTexts = artArr.slice(0, 15).map(a => {
    const no = a.조문번호 || '';
    const title = a.조문제목 || '';
    const content = a.조문내용 || '';
    const items = a.항
      ? (Array.isArray(a.항) ? a.항 : [a.항]).map(h => `  ${h.항번호 || ''} ${h.항내용 || ''}`).join('\n')
      : '';
    return `제${no}조${title ? `(${title})` : ''}\n${content}${items ? '\n' + items : ''}`;
  }).join('\n\n');
  return `【${lawName}】\n${artTexts}`;
}

export async function POST(req) {
  const { messages } = await req.json();
  const lastUserMsg = messages.filter(m => m.role === 'user').at(-1)?.content || '';

  // 1단계: Claude Haiku로 관련 법령명 추출
  const lawNames = await extractLawNames(lastUserMsg, process.env.ANTHROPIC_API_KEY);

  // 2단계: 추출된 법령명 + 키워드로 병렬 조회
  const searchQuery = lawNames.length > 0 ? lawNames[0] : lastUserMsg.slice(0, 20);
  const precedentQuery = lawNames.length > 0 ? lawNames[0] : lastUserMsg.slice(0, 20);

  const [lawResults, precedents, interpretations, adminRules] = await Promise.all([
    // 법령은 추출된 법령명들 전부 검색
    Promise.all(lawNames.length > 0
      ? lawNames.map(n => searchLaw(n))
      : [searchLaw(searchQuery)]
    ).then(results => results.flat()),
    searchPrecedent(precedentQuery),
    searchInterpretation(searchQuery),
    searchAdminRule(searchQuery),
  ]);

  // 법령 원문 조회 (상위 2개 병렬)
  let lawTexts = '';
  if (lawResults.length > 0) {
    const topLaws = lawResults.slice(0, 2);
    const lawDetails = await Promise.all(topLaws.map(l => getLawText(l.법령ID)));
    lawTexts = lawDetails.map(formatLawText).filter(Boolean).join('\n\n');
  }

  // 판례 원문 조회 (상위 2개 병렬)
  let precTexts = '';
  if (precedents.length > 0) {
    const topPrecs = precedents.slice(0, 2);
    const precDetails = await Promise.all(topPrecs.map(p => getPrecedentText(p.판례일련번호)));
    precTexts = precDetails
      .filter(Boolean)
      .map(p => `【${p.사건명 || '판례'}】\n사건번호: ${p.사건번호 || ''}\n판시사항: ${p.판시사항 || ''}\n판결요지: ${p.판결요지 || ''}`)
      .join('\n\n');
  }

  const expcSummary = interpretations.slice(0, 2)
    .map(e => `${e.제목 || ''} (${e.회신기관 || ''}, ${e.회신일자 || ''})`)
    .join('\n');

  const admrulSummary = adminRules.slice(0, 2)
    .map(a => `${a.행정규칙명 || ''} (${a.발령기관 || ''})`)
    .join('\n');

  const hasLawData = lawTexts || precTexts || expcSummary || admrulSummary;

  let lawContext = '';
  if (lawNames.length > 0) lawContext += `\n[Claude가 추출한 관련 법령명: ${lawNames.join(', ')}]`;
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

📋 [법령 원문] ★★★ - 법제처 API에서 가져온 조문을 그대로 인용
⚖️ [판례/해석례] ★★★ - 법제처 API 판례·해석례 데이터 기반
💡 [AI 해설] ★★ - 위 원문 데이터를 바탕으로 한 AI의 해석 및 실무 설명
⚠️ [AI 추정] ★ - 법제처 API 조회 실패, AI 학습 데이터만 사용 (원문 확인 필요)

태그 사용 규칙:
- 법제처 원문을 직접 인용할 때 → 📋 [법령 원문]
- 판례·해석례를 인용할 때 → ⚖️ [판례/해석례]
- 원문을 풀어서 설명하거나 실무 적용 안내 시 → 💡 [AI 해설]
- API 조회 실패로 AI 지식만 사용할 때 → ⚠️ [AI 추정]

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
