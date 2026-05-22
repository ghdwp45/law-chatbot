export const maxDuration = 300;

const LAW_API_KEY = "hongjeyeon";
const LAW_API_BASE = "http://www.law.go.kr/DRF";

const LAW_ALIASES = {
  "외부감사법": "주식회사 등의 외부감사에 관한 법률",
  "공정거래법": "독점규제 및 공정거래에 관한 법률",
  "하도급법": "하도급거래 공정화에 관한 법률",
  "개인정보보호법": "개인정보 보호법",
  "전자상거래법": "전자상거래 등에서의 소비자보호에 관한 법률",
  "표시광고법": "표시·광고의 공정화에 관한 법률",
  "가맹사업법": "가맹사업거래의 공정화에 관한 법률",
  "자본시장법": "자본시장과 금융투자업에 관한 법률",
  "금융소비자보호법": "금융소비자 보호에 관한 법률",
  "화관법": "화학물질관리법",
  "산안법": "산업안전보건법",
  "중대재해법": "중대재해 처벌 등에 관한 법률",
  "파견법": "파견근로자보호 등에 관한 법률",
  "기간제법": "기간제 및 단시간근로자 보호 등에 관한 법률",
  "노조법": "노동조합 및 노동관계조정법",
  "퇴직급여법": "근로자퇴직급여 보장법",
  "남녀고용평등법": "남녀고용평등과 일·가정 양립 지원에 관한 법률",
  "대규모유통업법": "대규모유통업에서의 거래 공정화에 관한 법률",
};

function normalizeLawName(query) {
  for (const [alias, full] of Object.entries(LAW_ALIASES)) {
    if (query.includes(alias)) return full;
  }
  return query;
}

async function searchLaw(query) {
  try {
    const normalized = normalizeLawName(query);
    const url = `${LAW_API_BASE}/lawSearch.do?OC=${LAW_API_KEY}&target=law&type=JSON&query=${encodeURIComponent(normalized)}&display=3&sort=efdate`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    const results = data.LawSearch?.law || [];
    if (results.length === 0 && normalized !== query) {
      const url2 = `${LAW_API_BASE}/lawSearch.do?OC=${LAW_API_KEY}&target=law&type=JSON&query=${encodeURIComponent(query)}&display=3&sort=efdate`;
      const res2 = await fetch(url2, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data2 = await res2.json();
      return data2.LawSearch?.law || [];
    }
    return results;
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

  const [laws, precedents, interpretations, adminRules] = await Promise.all([
    searchLaw(keywords),
    searchPrecedent(keywords),
    searchInterpretation(keywords),
    searchAdminRule(keywords),
  ]);

  let lawTexts = '';
  if (laws.length > 0) {
    const topLaws = laws.slice(0, 2);
    const lawDetails = await Promise.all(topLaws.map(l => getLawText(l.법령ID)));
    lawTexts = lawDetails.map(formatLawText).filter(Boolean).join('\n\n');
  }

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

  // 법제처 조회 성공 여부 판단
  const hasLawData = lawTexts || precTexts || expcSummary || admrulSummary;

  let lawContext = '';
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
