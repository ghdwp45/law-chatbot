export const maxDuration = 300;

const LAW_API_KEY = "hongjeyeon";
const LAW_API_BASE = "http://www.law.go.kr/DRF";

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
  const keywords = lastUserMsg.replace(/[?!？！]/g, '').slice(0, 20);

  // 병렬로 법제처 API 조회
  const [laws, precedents, interpretations, adminRules] = await Promise.all([
    searchLaw(keywords),
    searchPrecedent(keywords),
    searchInterpretation(keywords),
    searchAdminRule(keywords),
  ]);

  // 법령 원문 조회 (상위 2개 병렬)
  let lawTexts = '';
  if (laws.length > 0) {
    const topLaws = laws.slice(0, 2);
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

  // 해석례/행정규칙 요약
  const expcSummary = interpretations.slice(0, 2)
    .map(e => `${e.제목 || ''} (${e.회신기관 || ''}, ${e.회신일자 || ''})`)
    .join('\n');
  const admrulSummary = adminRules.slice(0, 2)
    .map(a => `${a.행정규칙명 || ''} (${a.발령기관 || ''})`)
    .join('\n');

  // 법제처 조회 결과 컨텍스트
  let lawContext = '';
  if (lawTexts) lawContext += `\n\n[법령 원문]\n${lawTexts}`;
  if (precTexts) lawContext += `\n\n[관련 판례]\n${precTexts}`;
  if (expcSummary) lawContext += `\n\n[해석례]\n${expcSummary}`;
  if (admrulSummary) lawContext += `\n\n[행정규칙]\n${admrulSummary}`;

  const systemPrompt = `당신은 한국 법령 전문 AI 어시스턴트입니다. 아래 법제처 실시간 데이터를 기반으로 정확한 답변을 제공하세요.
${lawContext || '관련 법령 데이터를 찾지 못했습니다. 일반 지식으로 답변하되 정확성 한계를 안내하세요.'}

답변 형식:
===해설===
각 문단 끝에 반드시 인용한 법령을 [법령명 제X조] 형식으로 태그하세요.
판례 인용 시 [대법원 XXXX년] 형식으로 태그하세요.
충분히 상세하게 작성하세요.
===해설끝===

===관련법령===
법령명|조문번호|설명
===관련법령끝===

절대 규칙: 두 섹션 모두 반드시 포함. 제공된 법제처 원문 데이터를 우선 활용. 한국어로만 답변.`;

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
