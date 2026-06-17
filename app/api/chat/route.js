import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const runtime = 'nodejs';
export const maxDuration = 300;

const LAW_OC = process.env.LAW_OC;
const MCP_URL = `https://korean-law-mcp.fly.dev/mcp?oc=${LAW_OC}`;
const ANSWER_MODEL = process.env.ANSWER_MODEL || 'claude-sonnet-4-6';
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-sonnet-4-6';
const IS_PROD = process.env.NODE_ENV === 'production';

const TOOL_TIMEOUT_MS = 20000;
const TOTAL_TIMEOUT_MS = 240000;
const MAX_STEPS = 12;
const REWRITE_STEPS = 5;
const MAX_TOOL_RESULT_CHARS = 16000;
const EVIDENCE_BUDGET = 24000;
const EVIDENCE_PER_CALL = 6000;
const JUDGE_MIN_REMAINING_MS = 25000;
const REQUIRED_TOOLS = ['search_law', 'get_law_text'];

const FALLBACK_BANNER =
  '> [주의: MCP 미조회/근거 불충분, 내장 지식 기반 — 실제 조문·기준서를 직접 확인하시기 바랍니다.]';

const DECISION_DOMAINS = [
  'precedent', 'interpretation', 'tax_tribunal', 'customs', 'nts',
  'constitutional', 'admin_appeal', 'ftc', 'pipc', 'nlrc', 'acr',
  'appeal_review', 'acr_special', 'school', 'public_corp', 'public_inst',
  'treaty', 'english_law',
];

const TOOL_DEFS = [
  {
    name: 'search_law',
    description: '법령을 이름으로 검색해 mst(법령일련번호)와 lawId를 얻는다. 조문 본문은 get_law_text로 따로 조회.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "법령명 (예: '법인세법')" },
        display: { type: 'number', description: '최대 결과 수(기본 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_law_text',
    description: '법령의 특정 조문 본문을 조회. mst 또는 lawId 중 하나와 jo(조문번호)는 필수. 전체 법령을 통째로 받지 말 것.',
    input_schema: {
      type: 'object',
      properties: {
        mst: { type: 'string', description: 'search_law에서 얻은 법령일련번호' },
        lawId: { type: 'string', description: 'search_law에서 얻은 법령ID' },
        jo: { type: 'string', description: "조문번호 (예: '제57조', '제57조의2', '005700')" },
        efYd: { type: 'string', description: '시행일자 YYYYMMDD (귀속연도/거래일 시점 조회 시 지정)' },
      },
      required: ['jo'],
    },
  },
  {
    name: 'search_decisions',
    description:
      '판례·해석례·심판례 등 18개 도메인 통합검색. 한 번에 한 도메인만 선택하며, 여러 도메인이 필요하면 병렬로 호출한다. ' +
      'precedent:법원판례 / interpretation:기재부 법령해석·예규 / tax_tribunal:조세심판원 / customs:관세 / nts:국세청 회신해석 / ' +
      'constitutional:헌재 / admin_appeal:행정심판 / ftc:공정위 / treaty:조세조약 등. ' +
      '세무 질문은 대개 precedent·interpretation·tax_tribunal·nts·constitutional·customs·treaty 중에서 고른다. ' +
      '도메인별 세부 필터는 options 객체 안에 넣는다.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: DECISION_DOMAINS, description: '검색 도메인 1개' },
        query: { type: 'string', description: '검색 키워드(좁게)' },
        display: { type: 'number', description: '결과 수(기본 20, 최대 100)' },
        page: { type: 'number' },
        sort: { type: 'string', enum: ['lasc', 'ldes', 'dasc', 'ddes', 'nasc', 'ndes'] },
        options: {
          type: 'object',
          description:
            '도메인별 세부 필터(여기 안에 넣어야 서버가 인식). ' +
            'precedent:{court,caseNumber,fromDate,toDate} ' +
            'tax_tribunal:{cls,gana,dpaYd,rslYd} ' +
            'interpretation:{fromDate,toDate} ' +
            'customs:{inq,rpl,gana,explYd} constitutional:{caseNumber} treaty:{cls,natCd,eftYd,concYd}',
        },
      },
      required: ['domain', 'query'],
    },
  },
  {
    name: 'get_decision_text',
    description: '검색으로 찾은 판례/해석례/심판례의 전문을 조회해 사건번호·예규번호를 정확히 확인한다. 판례·예규를 인용하려면 가급적 이 도구로 전문을 확인할 것.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: DECISION_DOMAINS, description: 'search_decisions에서 검색한 도메인' },
        id: { type: 'string', description: '검색 결과의 일련번호/ID' },
        full: { type: 'boolean', description: 'true=전문, 미지정=축약' },
      },
      required: ['domain', 'id'],
    },
  },
];

// 프롬프트 주석은 문자열 밖에서만 단다 (템플릿 안에 // 주석 금지)
function buildSystemPrompt(today) {
  return `당신은 대한민국 법률·세무 전문가 AI 어시스턴트입니다. 오늘은 ${today}(Asia/Seoul)입니다.
korean-law 도구로 법제처 실시간 데이터를 조회한 뒤, 그 데이터를 최우선 근거로 답변합니다. 모든 답변은 한국어로만 작성합니다.

[도구 사용 원칙]
- search_law로 법령을 찾아 mst를 얻고, get_law_text로 핵심 조문만(mst/lawId + jo) 조회한다. 법령 전체를 통째로 받지 말 것.
- 판례·해석례·예규·심판례는 search_decisions(domain, query)로 도메인별 조회한다. 한 호출=한 도메인, 여러 도메인은 병렬 호출. 같은 도메인을 반복 호출하지 말고 키워드를 좁혀 한두 번이면 충분하다.
- 판례·예규를 인용하려면 get_decision_text(domain, id)로 전문을 확인한 뒤 사건번호·예규번호를 인용한다. 검색 목록에서 확인한 사건번호만 인용하고, 도구로 조회하지 않은 사건번호·예규번호를 지어내지 말 것.
- 도구 결과가 질문과 무관하면 억지로 엮지 말고 무관함을 밝힌다.

[해석쟁점 필수 조회]
- 적법성·허용 여부·공급시기·귀속시기·과세대상 여부처럼 법령 문언만으로 단정하기 어려운 해석 쟁점은, 반드시 search_decisions로 기재부 예규(interpretation)·국세청 해석(nts)·조세심판원(tax_tribunal)·법원 판례(precedent)를 조회한 뒤 결론을 내린다. 법령 조문만 읽고 적법/위법을 단정하지 말 것.
- 핵심 결론은 상세 해설 및 확인된 근거와 반드시 일치해야 한다. 본문에서 의문·예외·요건미충족 가능성을 제기했다면, 핵심 결론에서 '허용된다/적법하다'고 단정하지 말 것.
- 작성 순서: 먼저 상세 해설에서 법령·예규·심판례 검토를 끝내 결론을 도출한 뒤, 그 결과를 핵심 결론에 그대로 옮긴다. 본문에서 '위반·미충족·불가·허용되지 않음·❌·가산세 위험'을 한 번이라도 언급했다면 핵심 결론에 '적법/가능/허용'이라는 단정 표현을 쓰지 않는다.
- search_decisions 결과가 비거나 부족해도 '해석례가 없다'고 단정하지 말고 '현재 조회 범위에서는 확인하지 못함'으로 표현하며, 키워드를 바꿔 최소 1회 재검색한 뒤에만 그렇게 적는다. 해석쟁점에서 근거를 끝내 못 찾으면 결론을 단정하지 말고 보류한다.

[세법 조회 보강 원칙]
- 세법 질문은 원칙적으로 법률·시행령·시행규칙을 함께 검토한다. 법률 조문만으로 결론이 어려우면 시행령·시행규칙을 추가 조회한다.
- 결론은 법령 → 시행령 → 시행규칙 → 기재부/국세청 해석 → 심판례·판례 순으로 정리한다.

[시점(시행일자) 원칙]
- 질문에 과세연도·사업연도·거래일·신고기한·처분일이 있으면 그 시점의 시행일자(efYd)를 우선 적용한다.
- 시점이 불명확하면 '현재 시행 법령 기준'임을 명시하고, 과거 거래에는 결론이 달라질 수 있음을 표시한다.

[회계기준 한계]
- 회계처리·K-IFRS·일반기업회계기준·내부회계관리제도 관련 질문에서 이 도구로 기준서 원문을 확인하지 못한 경우, 법령 조회 결과와 회계기준 판단을 명확히 분리한다.
- 회계기준 원문·감독기관 질의회신을 확인하지 못한 내용은 반드시 ⚠️ [AI 추정]으로 표시하고, 세법상 처리와 회계상 처리가 다를 수 있음을 명시한다.

[미조회/근거불충분 배너]
- 도구 결과가 없거나 실패해 내장 지식으로 답해야 하면, 답변 맨 위에 정확히 다음 문구를 표시한다:
  ${FALLBACK_BANNER}

[법적 위계 준수]
1. 원칙은 [법령 원문]과 [기재부/국세청 예규·해석례] 기준으로 먼저 서술한다.
2. 심판례·판례의 납세자 승소를 '합법/표준 실무'로 확대 해석하지 말 것.
3. [원칙적 세무 실무]와 [예외적 구제 및 참고 심판례]를 분리하고, 심판례는 "예외적 구제 가능성"으로만 제시한다.
4. 핵심 결론은 법령·예규 기준으로 작성하고, 심판례로 결론을 뒤집지 말 것.

[작성 형식]
- 도구 호출 전에 중간 계획·진행상황을 출력하지 말 것. 최종 답변만 아래 형식으로 출력한다.
- 법령 인용 시 법령명+조문 번호 명시 (예: "상법 제447조").

[참고 예시 - 월합계 세금계산서]
- 질문: 전월 26일~당월 25일 공급분을 월합계 세금계산서 1장으로 발급할 수 있는가?
- 올바른 방향: 원칙적으로 불가. 부가가치세법 제34조 제3항의 월합계 특례는 '달의 1일부터 말일까지(1역월)' 또는 '그 달 안에서 임의로 정한 기간'만 허용하므로, 두 역월에 걸치는 26~25일 구간을 한 장으로 묶을 수 없다. 계속적 용역의 공급시기(대가 확정 시점) 판단은 별개 쟁점이며 2역월 합산을 자동으로 정당화하지 않는다. 결론은 반드시 search_decisions로 기재부 예규(interpretation)·국세청(nts)·조세심판원(tax_tribunal)을 조회해 확인한 근거로 뒷받침한다.

[출처 태그 - 필수]
📋 [법령 원문] / ⚖️ [판례·해석례](사건번호·예규번호 명시) / 💡 [AI 해설] / ⚠️ [AI 추정]
- 별표(★)·신뢰도 점수 표시 금지.

[답변 형식]
===해설===
# 📌 사안의 쟁점
# 💡 핵심 결론
# 📖 상세 해설
===해설끝===

===관련법령===
법령명|조문번호|설명
===관련법령끝===`;
}

function maskSecrets(s) {
  if (!s) return s;
  let out = String(s);
  if (LAW_OC) out = out.split(LAW_OC).join('***');
  return out;
}

// 텍스트 추출 공통화 — isToolSuccess와 toToolResultText가 같은 기준을 쓰도록
function extractToolText(r) {
  const parts = Array.isArray(r?.content) ? r.content : [];
  let text = parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p?.text) return p.text;
      if (p) return JSON.stringify(p);
      return '';
    })
    .join('\n')
    .trim();
  if (!text && r) text = JSON.stringify(r);
  return text;
}

function isToolSuccess(r) {
  if (!r || r.__error || r.isError) return false;
  return extractToolText(r).length > 0;
}

function toToolResultText(r) {
  if (r && r.__error) return { text: `조회 실패: ${r.message}`, truncated: false };
  const raw = extractToolText(r);
  if (r && r.isError) return { text: `조회 실패(서버 오류): ${raw.slice(0, 500)}`, truncated: false };
  if (raw.length > MAX_TOOL_RESULT_CHARS) {
    return {
      text:
        raw.slice(0, MAX_TOOL_RESULT_CHARS) +
        '\n\n[경고: 결과가 길어 일부가 잘렸습니다. 이 문서는 불완전하므로 단정적으로 인용하지 말고, jo로 핵심 조문만 다시 조회하십시오.]',
      truncated: true,
    };
  }
  return { text: raw, truncated: false };
}

// 런타임 입력 방어 검증 (스키마 anyOf는 API가 거부하므로 여기서 강제)
function validateToolInput(name, input) {
  if (name === 'get_law_text') {
    if (!input?.jo) return 'get_law_text에는 jo(조문번호)가 필요합니다.';
    if (!input?.mst && !input?.lawId) return 'get_law_text에는 mst 또는 lawId가 필요합니다.';
    const jo = String(input.jo).trim();
    if (!(/^제?\d+조(의\d+)?/.test(jo) || /^\d{6}$/.test(jo))) {
      return "get_law_text의 jo는 '제57조'·'제57조의2'·'005700' 형식이어야 합니다.";
    }
  }
  if (name === 'get_decision_text' && (!input?.domain || !input?.id)) {
    return 'get_decision_text에는 domain과 id가 필요합니다.';
  }
  return null;
}

// 답변에서 사건번호/예규번호 후보 추출 (보수적)
function extractCaseLikeIds(text) {
  const patterns = [
    /\d{4}[가-힣]{1,3}\d{2,6}/g,          // 법원·국심: 2019두12345, 2006구1527
    /조심\s?\d{4}[가-힣]+\d+/g,           // 조세심판원
    /(?:서면|사전|법규|기준|징세|부가|법인|소득|재산세제)[-\s]?[가-힣A-Za-z0-9]*-?\d+/g, // 예규류
    /\d{4}헌[가-힣]\d+/g,                 // 헌재
  ];
  return [...new Set(patterns.flatMap((re) => text.match(re) || []))];
}
const normalizeId = (s) => String(s).replace(/[\s\-]/g, '');

// 답변에서 특정 헤더 섹션만 추출 (핵심 결론/상세 해설 등)
function extractSection(text, headingRegex) {
  const re = new RegExp(`${headingRegex}[\\s\\S]*?(?=\\n#|\\n===|$)`);
  return String(text).match(re)?.[0] || '';
}

// 결론↔본문 모순: 핵심 결론은 '적법/가능' 단정인데 본문은 '위반/미충족'을 말하는 경우.
// 단, 핵심 결론이 조건부(다만/예외/가능성 등)면 모순으로 보지 않아 과차단 방지.
function hasConclusionContradiction(answerText) {
  const concl = extractSection(answerText, '핵심\\s*결론');
  const detail = extractSection(answerText, '상세\\s*해설') || answerText;
  const positive =
    /(적법|가능합니다|가능하다|허용(된다|됩니다|됨)|문제\s*없|발급\s*가능|발행\s*가능)/.test(concl);
  const negative =
    /(요건\s*위반|위반\s*가능성|불가|허용되지\s*않|가산세\s*위험|미충족|사실과\s*다른|❌)/.test(detail);
  const conditional =
    /(다만|조건|전제|경우에는|예외|별도\s*검토|가능성|단정하기\s*어렵|권장|주의)/.test(concl);
  return positive && negative && !conditional;
}

// 고위험 해석쟁점(적법성·공급시기·가산세 등) 질문 판별
function isHighRiskLegalQuestion(q) {
  return /(적법|위법|허용|가능한가|가능한지|가산세|공급시기|귀속시기|과세대상|월합계|1역월|역월|세금계산서|신고|공제|불공제)/.test(
    String(q)
  );
}

// 결정적 근거 정합성 평가 → fatal(차단) / warning(배너). 의미 검증은 LLM-judge가 담당하므로 게이트는 최소 안전망.
function evaluateIntegrity(answerText, stats) {
  const fatal = [];
  const warnings = [];

  // 하드 차단: 조사 자체가 없거나 출력 형식이 깨진 경우만
  if (stats.attempted === 0) fatal.push('법령 조회가 수행되지 않음');
  if (!answerText.includes('===해설===') || !answerText.includes('===관련법령끝===')) {
    fatal.push('지정 답변 형식 누락');
  }

  // 경고(표시 + 주의 배너): 결정적 규칙은 자문 수준 — 정답을 죽이지 않음
  if (answerText.includes('📋 [법령 원문]') && !stats.lawTextSucceeded) {
    warnings.push('법령 원문 조회 성공 없이 [법령 원문] 인용');
  }
  if (answerText.includes('⚖️ [판례·해석례]') && !stats.decisionTextSucceeded) {
    warnings.push('전문 조회 성공 없이 [판례·해석례] 인용');
  }
  const ids = extractCaseLikeIds(answerText);
  if (ids.length) {
    const unverified = ids.filter((id) => !stats.decisionIds.has(normalizeId(id)));
    if (unverified.length) {
      warnings.push(`도구 조회에서 확인되지 않은 번호(원문 대조 필요): ${unverified.slice(0, 5).join(', ')}`);
    }
  }
  if (stats.lawTextTruncated && answerText.includes('📋 [법령 원문]')) {
    warnings.push('절단된 조문 기반 인용 가능성');
  }
  if (stats.attempted > 0 && !stats.lawTextSucceeded && !stats.decisionTextSucceeded) {
    warnings.push('검증된 원문 근거 미확보');
  }
  if (stats.truncated) warnings.push('일부 도구 결과가 절단됨');

  return { fatal, warnings };
}

function blockedAnswer(reasons) {
  return (
    `${FALLBACK_BANNER}\n\n` +
    `===해설===\n# 📌 사안의 쟁점\n💡 [AI 해설] 법령 근거 검증 중 문제가 발견되었습니다.\n` +
    `# 💡 핵심 결론\n⚠️ [AI 추정] ${reasons.join(' / ')} 사유로 단정 답변을 제공할 수 없습니다.\n` +
    `# 📖 상세 해설\n⚠️ [AI 추정] 질문을 더 구체화하거나 다시 시도해 주세요. 정확한 답변을 위해서는 관련 법령·예규의 원문 조회가 완료되어야 합니다.\n` +
    `===해설끝===\n\n===관련법령===\n법령명|조문번호|설명\n===관련법령끝===`
  );
}

// LLM-judge 출력 파싱 (실패 시 fail-open=pass, 결정적 게이트가 여전히 방어)
function parseJudge(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    const o = JSON.parse(m[0]);
    return {
      action: ['pass', 'revise', 'block'].includes(o.action) ? o.action : 'pass',
      reasons: Array.isArray(o.reasons) ? o.reasons.map(String) : [],
      requireDecisionLookup: Boolean(o.requireDecisionLookup),
      instructions: typeof o.instructions === 'string' ? o.instructions : '',
    };
  } catch {
    return { action: 'pass', reasons: ['judge 파싱 실패(검증 생략)'], requireDecisionLookup: false, instructions: '' };
  }
}

export async function POST(req) {
  const { messages } = await req.json();
  const lastUserMsg = messages.filter((m) => m.role === 'user').at(-1)?.content || '';
  console.log('[DEBUG] OC:', LAW_OC ? `set(len=${LAW_OC.length})` : '❌ MISSING');
  if (!IS_PROD) console.log('[DEBUG] 질문 길이:', String(lastUserMsg).length);

  if (!LAW_OC) return Response.json({ error: '서버 설정 오류: 법령 API 키 미설정' }, { status: 500 });

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const enc = new TextEncoder();
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const today = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode('data: ' + JSON.stringify(obj) + '\n\n'));

      const mcpClient = new Client({ name: 'law-chatbot', version: '3.2.0' }, { capabilities: {} });
      let mcpConnected = false;
      try {
        await mcpClient.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
        mcpConnected = true;
      } catch (e) {
        console.error('[ERROR] MCP 연결 실패:', maskSecrets(e.message));
        send({ error: '법령 조회 서버 연결 실패로 답변을 제공할 수 없습니다: ' + maskSecrets(e.message) });
        controller.close();
        return;
      }

      // 서버에 실존하는 도구만 노출 + 필수 도구 없으면 hard fail
      let activeToolDefs = TOOL_DEFS;
      let activeAllowed = new Set(TOOL_DEFS.map((t) => t.name));
      try {
        const { tools } = await mcpClient.listTools();
        const serverNames = new Set(tools.map((t) => t.name));
        activeToolDefs = TOOL_DEFS.filter((t) => serverNames.has(t.name));
        activeAllowed = new Set(activeToolDefs.map((t) => t.name));
        const missing = TOOL_DEFS.map((t) => t.name).filter((n) => !serverNames.has(n));
        if (missing.length) console.error('[WARN] 서버에 없는 도구 정의(미노출):', missing.join(', '));
      } catch (e) {
        console.error('[WARN] listTools 검증 실패(전체 도구로 진행):', e.message);
      }
      const missingRequired = REQUIRED_TOOLS.filter((n) => !activeAllowed.has(n));
      if (missingRequired.length) {
        send({ error: `필수 법령 조회 도구가 없어 답변을 제공할 수 없습니다: ${missingRequired.join(', ')}` });
        if (mcpConnected) await mcpClient.close().catch(() => {});
        controller.close();
        return;
      }

      const stats = {
        question: lastUserMsg,
        attempted: 0,
        lawTextSucceeded: false,
        decisionTextSucceeded: false,
        decisionSearchAttempted: 0,
        decisionSearchSucceeded: false,
        domainsSearched: new Set(),
        lawTextTruncated: false,
        truncated: false,
        calls: [],
        decisionIds: new Set(),
        evidence: '',
      };

      async function runTool(name, input) {
        if (!activeAllowed.has(name)) return { __error: true, message: `서버에서 사용 불가한 도구(${name})` };
        const verr = validateToolInput(name, input);
        if (verr) return { __error: true, message: verr };
        try {
          return await mcpClient.callTool({ name, arguments: input }, undefined, { timeout: TOOL_TIMEOUT_MS });
        } catch (e) {
          console.error('[ERROR] 도구 실패:', name, e.message);
          return { __error: true, message: `${name} 조회 실패로 건너뜀` };
        }
      }

      const convo = messages.slice(-8).map(({ role, content }) => ({ role, content }));
      const systemPrompt = buildSystemPrompt(today);
      let truncatedOut = false;

      // 스텝 소진 시: 도구 없이 강제로 최종 답변을 합성(수집한 근거 활용)
      async function synthesize() {
        if (Date.now() > deadline) throw new Error('TOTAL_TIMEOUT');
        const signal = AbortSignal.timeout(Math.max(1000, deadline - Date.now()));
        const ms = anthropic.messages.stream(
          { model: ANSWER_MODEL, max_tokens: 16000, system: systemPrompt, messages: convo },
          { signal }
        );
        let t = '';
        for await (const ev of ms) {
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') t += ev.delta.text;
        }
        const final = await ms.finalMessage();
        if (final.stop_reason === 'max_tokens') truncatedOut = true;
        return { answerText: t };
      }

      // 한 번의 생성 패스(도구 루프). convo·stats를 공유·누적한다.
      async function generate(maxSteps) {
        for (let step = 0; step < maxSteps; step++) {
          if (Date.now() > deadline) throw new Error('TOTAL_TIMEOUT');
          const signal = AbortSignal.timeout(Math.max(1000, deadline - Date.now()));

          const ms = anthropic.messages.stream(
            { model: ANSWER_MODEL, max_tokens: 16000, system: systemPrompt, tools: activeToolDefs, messages: convo },
            { signal }
          );

          let stepText = '';
          for await (const ev of ms) {
            if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
              send({ tool: ev.content_block.name });
            } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              stepText += ev.delta.text;
            }
          }

          const final = await ms.finalMessage();
          if (final.stop_reason === 'max_tokens') truncatedOut = true;
          const toolUses = final.content.filter((c) => c.type === 'tool_use');

          if (toolUses.length === 0) return { answerText: stepText };

          convo.push({ role: 'assistant', content: final.content });
          const results = await Promise.all(
            toolUses.map(async (tu) => {
              const r = await runTool(tu.name, tu.input);
              const success = isToolSuccess(r);
              const { text, truncated } = toToolResultText(r);
              stats.attempted += 1;
              stats.calls.push({ name: tu.name, success });
              if (truncated) stats.truncated = true;
              if (tu.name === 'search_decisions') {
                stats.decisionSearchAttempted += 1;
                if (tu.input?.domain) stats.domainsSearched.add(tu.input.domain);
                if (success) stats.decisionSearchSucceeded = true;
              }
              if (success) {
                if (tu.name === 'get_law_text') {
                  stats.lawTextSucceeded = true;
                  if (truncated) stats.lawTextTruncated = true;
                }
                if (tu.name === 'get_decision_text') stats.decisionTextSucceeded = true;
                // 검색 결과·전문 모두에서 사건번호 수집 (검색 목록의 번호도 법제처 DB의 실재 번호)
                if (tu.name === 'get_decision_text' || tu.name === 'search_decisions') {
                  extractCaseLikeIds(text).forEach((id) => stats.decisionIds.add(normalizeId(id)));
                }
                if (stats.evidence.length < EVIDENCE_BUDGET) {
                  stats.evidence +=
                    `\n--- ${tu.name}(${JSON.stringify(tu.input).slice(0, 120)}) ---\n` +
                    text.slice(0, EVIDENCE_PER_CALL);
                }
              }
              return { type: 'tool_result', tool_use_id: tu.id, content: text };
            })
          );
          convo.push({ role: 'user', content: results });
        }
        // 스텝 소진 → 수집한 근거로 강제 합성 (캔드 메시지로 버리지 않음)
        send({ synthesizing: true });
        return await synthesize();
      }

      // LLM-judge: 결론↔근거 정합성 + 해석쟁점 미조회 + 무근거 인용 검증
      async function runJudge(question, answer) {
        const remaining = deadline - Date.now();
        if (remaining < JUDGE_MIN_REMAINING_MS) {
          return { action: 'pass', reasons: ['시간 부족으로 judge 생략'], requireDecisionLookup: false, instructions: '' };
        }
        const judgeSystem = `당신은 한국 세무·법률 답변의 근거 정합성을 검증하는 심사관입니다. 반드시 아래 형식의 JSON 하나만 출력합니다(코드블록·설명·여는말 금지).
{"action":"pass|revise|block","reasons":["..."],"requireDecisionLookup":true,"instructions":"..."}

검증 항목:
1. 결론 정합성: '핵심 결론'이 '상세 해설'·제시된 [확보된 근거]와 모순되는가, 또는 근거가 지지하지 않는 단정을 하는가. 본문에서 요건 미충족·예외 가능성을 제기했는데 핵심 결론에서 '허용/적법'이라고 단정하면 모순으로 본다.
2. 해석쟁점 미조회: 적법성·허용여부·공급시기·귀속시기 등 해석이 필요한 쟁점인데 예규·해석례·심판례(기재부/국세청/조세심판원/법원) 근거 없이 법령 조문 문언만으로 단정했는가. 그렇다면 requireDecisionLookup=true.
3. 무근거 인용: 답변의 사건번호·예규번호·핵심 사실이 [확보된 근거]에 전혀 등장하지 않는가.

판정: 문제 없으면 action="pass". 추가 조회·수정으로 고칠 수 있으면 "revise"(대부분). 근거를 댈 수 없는 위험한 단정이면 "block". instructions에는 무엇을 어떻게 고칠지 한국어로 구체적으로 적는다.`;

        const judgeUser =
          `[질문]\n${String(question).slice(0, 3000)}\n\n` +
          `[도구 호출 요약]\n${stats.calls.map((c) => `${c.name}:${c.success ? '성공' : '실패'}`).join(', ') || '(없음)'}\n\n` +
          `[확보된 근거(발췌)]\n${stats.evidence.slice(0, EVIDENCE_BUDGET) || '(없음)'}\n\n` +
          `[검증 대상 답변]\n${answer}`;

        try {
          const signal = AbortSignal.timeout(Math.max(1000, Math.min(60000, deadline - Date.now())));
          const res = await anthropic.messages.create(
            { model: JUDGE_MODEL, max_tokens: 1500, system: judgeSystem, messages: [{ role: 'user', content: judgeUser }] },
            { signal }
          );
          const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
          const parsed = parseJudge(text);
          // 파싱 실패로 검증을 건너뛴 경우, 고위험 질문은 보수적으로 재작성시킨다.
          if (parsed.reasons.some((r) => r.includes('파싱 실패')) && isHighRiskLegalQuestion(question)) {
            return {
              action: 'revise',
              reasons: ['judge 출력 파싱 실패 + 고위험 세무·법률 쟁점'],
              requireDecisionLookup: true,
              instructions:
                '검증 결과를 신뢰할 수 없으므로 보수적으로 재작성하라. 단정 표현을 피하고, 법령·예규·심판례로 확인된 범위에서만 결론을 제시하라.',
            };
          }
          return parsed;
        } catch (e) {
          console.error('[WARN] judge 실패(검증 생략):', e.name, e.message);
          // 고위험 세무·법률 질문은 judge 실패 시 pass가 아니라 revise로 보수 처리.
          if (isHighRiskLegalQuestion(question)) {
            return {
              action: 'revise',
              reasons: ['고위험 세무·법률 쟁점에서 judge 검증 실패'],
              requireDecisionLookup: true,
              instructions:
                '검증 실패로 인해 보수적으로 재작성하라. 단정 표현을 피하고, 법령·예규·심판례 근거가 확인된 범위에서만 결론을 제시하라.',
            };
          }
          return { action: 'pass', reasons: ['judge 호출 실패(검증 생략)'], requireDecisionLookup: false, instructions: '' };
        }
      }

      try {
        let { answerText } = await generate(MAX_STEPS);

        // LLM-judge 검증 + 1회 재작성
        const judge = await runJudge(lastUserMsg, answerText);
        const det = evaluateIntegrity(answerText, stats);

        // 결정적 안전망: judge가 놓쳐도 잡아야 하는 신호 (블록이 아니라 재작성 강제)
        const softReasons = [];
        if (hasConclusionContradiction(answerText)) {
          softReasons.push('핵심 결론이 상세 해설의 위반·미충족 판단과 모순됨(긍정 단정 ↔ 본문 부정)');
        }
        const missingDecisionLookup =
          isHighRiskLegalQuestion(stats.question) && stats.decisionSearchAttempted === 0;
        if (missingDecisionLookup) {
          softReasons.push('해석 쟁점인데 예규·심판례(search_decisions) 검색이 수행되지 않음');
        }

        const needRewrite =
          judge.action === 'revise' || judge.action === 'block' || det.fatal.length > 0 || softReasons.length > 0;

        if (!IS_PROD) {
          console.log('[DEBUG] judge:', JSON.stringify({ action: judge.action, reasons: judge.reasons, fatal: det.fatal, soft: softReasons }));
        }

        if (needRewrite) {
          send({ revising: true });
          const reasons = [...new Set([...judge.reasons, ...det.fatal, ...softReasons])];
          // 모순·미검색이 감지되면 해석례 재조회를 강제한다.
          if (softReasons.length) judge.requireDecisionLookup = true;
          const reviseMsg =
            `직전 답변에 다음 문제가 있어 재작성이 필요합니다:\n- ${reasons.join('\n- ')}\n\n` +
            `${judge.instructions ? judge.instructions + '\n' : ''}` +
            `${judge.requireDecisionLookup ? '특히 적법성·공급시기 등 해석 쟁점이므로 search_decisions(interpretation·nts·tax_tribunal·precedent)와 get_decision_text로 관련 예규·심판례를 반드시 조회한 뒤, 도구로 확인한 사건·예규번호만 인용하라.\n' : ''}` +
            `핵심 결론은 상세 해설·확인된 근거와 일치시키고, 지정된 ===해설=== / ===관련법령=== 형식을 지켜 한국어로 다시 작성하라.`;

          convo.push({ role: 'assistant', content: answerText });
          convo.push({ role: 'user', content: reviseMsg });

          const second = await generate(REWRITE_STEPS);
          if (second.answerText) answerText = second.answerText;
        }

        // 최종 결정적 게이트 (재작성 후에도 잔존하는 결함만 차단, 나머지는 경고)
        const { fatal, warnings } = evaluateIntegrity(answerText, stats);
        // 재작성 후에도 결론↔본문 모순이 남으면 통째로 버리지 않고 강한 경고를 붙인다.
        if (hasConclusionContradiction(answerText)) {
          warnings.unshift('핵심 결론이 본문 판단과 모순될 수 있음 — 결론보다 상세 해설의 근거를 우선 확인하십시오');
        }
        if (isHighRiskLegalQuestion(stats.question) && stats.decisionSearchAttempted === 0) {
          warnings.push('예규·심판례 미조회 — 법령 문언만으로 도출된 결론이므로 단정에 주의');
        }
        if (fatal.length) {
          answerText = blockedAnswer(fatal);
        } else if (warnings.length && !answerText.includes('[검증 경고:')) {
          answerText = `> [검증 경고: ${warnings.join(' / ')} — 원문 확인이 필요합니다.]\n\n` + answerText;
        }

        console.log('[INFO] 요약:', JSON.stringify({
          calls: stats.calls.map((c) => `${c.name}:${c.success ? 'O' : 'X'}`),
          law: stats.lawTextSucceeded, dec: stats.decisionTextSucceeded,
          decSearch: stats.decisionSearchAttempted, domains: [...stats.domainsSearched],
          judge: judge.action, rewrote: needRewrite, fatal, truncated: truncatedOut,
        }));

        if (truncatedOut) send({ truncated: true });
        send({ text: answerText });
        send({ done: true, full: answerText });
      } catch (e) {
        const msg =
          e.message === 'TOTAL_TIMEOUT' || e.name === 'TimeoutError' || e.name === 'AbortError'
            ? '처리 시간이 초과됐습니다. 질문을 나눠서 다시 시도해 주세요.'
            : maskSecrets(e.message);
        console.error('[ERROR] 루프:', e.name, maskSecrets(e.message));
        send({ error: msg });
      } finally {
        if (mcpConnected) await mcpClient.close().catch(() => {});
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
