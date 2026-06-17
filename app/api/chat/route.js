import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const runtime = 'nodejs';
export const maxDuration = 300;

const LAW_OC = process.env.LAW_OC;
const MCP_URL = `https://korean-law-mcp.fly.dev/mcp?oc=${LAW_OC}`;
const ANSWER_MODEL = 'claude-sonnet-4-6';
const IS_PROD = process.env.NODE_ENV === 'production';

const TOOL_TIMEOUT_MS = 20000;
const TOTAL_TIMEOUT_MS = 240000;
const MAX_STEPS = 8;
const MAX_TOOL_RESULT_CHARS = 16000;
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
        mst: { type: 'string', description: '법령일련번호' },
        lawId: { type: 'string', description: '법령ID' },
        jo: { type: 'string', description: "조문번호 (예: '제57조', '제57조의2', '005700')" },
        efYd: { type: 'string', description: '시행일자 YYYYMMDD (귀속연도/거래일 시점 조회 시 지정)' },
      },
      required: ['jo'],
      anyOf: [{ required: ['mst'] }, { required: ['lawId'] }],
    },
  },
  {
    name: 'search_decisions',
    description:
      '판례·해석례·심판례 등 18개 도메인 통합검색. 한 번에 한 도메인만 선택하며, 여러 도메인이 필요하면 병렬로 호출한다. ' +
      'precedent:법원판례 / interpretation:기재부 법령해석·예규 / tax_tribunal:조세심판원 / customs:관세 / nts:국세청 회신해석 / ' +
      'constitutional:헌재 / admin_appeal:행정심판 / ftc:공정위 / treaty:조세조약 등. ' +
      '세무 질문은 대개 precedent·interpretation·tax_tribunal·nts·constitutional·customs·treaty 중에서 고른다.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: DECISION_DOMAINS, description: '검색 도메인 1개' },
        query: { type: 'string', description: '검색 키워드(좁게)' },
        display: { type: 'number', description: '결과 수(기본 20, 최대 100)' },
        page: { type: 'number' },
        sort: { type: 'string', enum: ['lasc', 'ldes', 'dasc', 'ddes', 'nasc', 'ndes'] },
        options: { type: 'object', description: 'prec:{court,caseNumber,fromDate,toDate} tax_tribunal:{cls,dpaYd,rslYd} interpretation:{fromDate,toDate}' },
      },
      required: ['domain', 'query'],
    },
  },
  {
    name: 'get_decision_text',
    description: '검색으로 찾은 판례/해석례/심판례의 전문을 조회해 사건번호·예규번호를 정확히 확인한다. 판례·예규를 인용하려면 반드시 이 도구로 전문을 확인할 것.',
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
- 판례·해석례·예규·심판례는 search_decisions(domain, query)로 도메인별 조회한다. 한 호출=한 도메인, 여러 도메인은 병렬 호출.
- 판례·예규를 인용하려면 반드시 get_decision_text(domain, id)로 전문을 확인한 뒤 사건번호·예규번호를 인용한다. 검색 목록만 보고 사건번호를 인용하지 말 것. 전문으로 확인하지 않은 사건번호·예규번호는 답변에 쓰지 말 것.
- 도구 결과가 질문과 무관하면 억지로 엮지 말고 무관함을 밝힌다.

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

// 런타임 입력 방어 검증
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
    /\d{4}[가-힣]{1,3}\d{2,6}/g,          // 법원: 2019두12345
    /조심\s?\d{4}[가-힣]+\d+/g,           // 조세심판원
    /(?:서면|사전|법규|기준|징세|부가|법인|소득|재산세제)[-\s]?[가-힣A-Za-z0-9]*-?\d+/g, // 예규류
    /\d{4}헌[가-힣]\d+/g,                 // 헌재
  ];
  return [...new Set(patterns.flatMap((re) => text.match(re) || []))];
}
const normalizeId = (s) => String(s).replace(/[\s\-]/g, '');

// 근거 정합성 평가 → fatal(차단) / warning(배너)
function evaluateIntegrity(answerText, stats) {
  const fatal = [];
  const warnings = [];

  if (stats.attempted === 0) fatal.push('법령 조회가 수행되지 않음');

  // 태그를 실제로 단 경우에만 차단 (과차단 방지)
  if (answerText.includes('📋 [법령 원문]') && !stats.lawTextSucceeded) {
    fatal.push('법령 원문 조회 성공 없이 [법령 원문] 인용');
  }
  if (answerText.includes('⚖️ [판례·해석례]') && !stats.decisionTextSucceeded) {
    fatal.push('전문 조회 성공 없이 [판례·해석례] 인용');
  }

  // 답변에 번호가 있을 때만, 전문에서 추출한 ID set과 대조
  const ids = extractCaseLikeIds(answerText);
  if (ids.length) {
    const unverified = ids.filter((id) => !stats.decisionIds.has(normalizeId(id)));
    if (unverified.length) {
      fatal.push(`전문으로 확인되지 않은 사건·예규번호 인용: ${unverified.slice(0, 5).join(', ')}`);
    }
  }

  // 절단된 '조문'으로 법령 원문 인용 → 차단 (결정례 절단은 제외)
  if (stats.lawTextTruncated && answerText.includes('📋 [법령 원문]')) {
    fatal.push('절단된 조문 기반 [법령 원문] 인용');
  }

  if (!answerText.includes('===해설===') || !answerText.includes('===관련법령끝===')) {
    fatal.push('지정 답변 형식 누락');
  }

  // 원문 근거를 하나도 못 받았으나 위험 태그·번호도 없는 경우 → 경고(배너)로 완화
  if (stats.attempted > 0 && !stats.lawTextSucceeded && !stats.decisionTextSucceeded) {
    warnings.push('검증된 원문 근거(조문 본문·결정례 전문) 미확보');
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

const INCOMPLETE_ANSWER = blockedAnswer(['조회가 제한 횟수 내에 완료되지 않음']);

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

      const mcpClient = new Client({ name: 'law-chatbot', version: '2.3.0' }, { capabilities: {} });
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

      // 호출 이력/근거 추적
      const stats = {
        attempted: 0,
        lawTextSucceeded: false,
        decisionTextSucceeded: false,
        lawTextTruncated: false,
        truncated: false,
        calls: [],
        decisionIds: new Set(),
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

      let answerText = '';
      let truncatedOut = false;

      try {
        for (let step = 0; step < MAX_STEPS; step++) {
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

          if (toolUses.length === 0) { answerText = stepText; break; }
          if (step === MAX_STEPS - 1) { answerText = INCOMPLETE_ANSWER; break; }

          convo.push({ role: 'assistant', content: final.content });
          const results = await Promise.all(
            toolUses.map(async (tu) => {
              const r = await runTool(tu.name, tu.input);
              const success = isToolSuccess(r);
              const { text, truncated } = toToolResultText(r);
              stats.attempted += 1;
              stats.calls.push({ name: tu.name, input: tu.input, success, truncated });
              if (truncated) stats.truncated = true;
              if (success) {
                if (tu.name === 'get_law_text') {
                  stats.lawTextSucceeded = true;
                  if (truncated) stats.lawTextTruncated = true;
                }
                if (tu.name === 'get_decision_text') {
                  stats.decisionTextSucceeded = true;
                  extractCaseLikeIds(text).forEach((id) => stats.decisionIds.add(normalizeId(id)));
                }
              }
              return { type: 'tool_result', tool_use_id: tu.id, content: text };
            })
          );
          convo.push({ role: 'user', content: results });
        }

        // fatal=차단, warning=배너 (MAX_STEPS 미완료는 이미 INCOMPLETE_ANSWER로 대체됨)
        if (answerText !== INCOMPLETE_ANSWER) {
          const { fatal, warnings } = evaluateIntegrity(answerText, stats);
          if (!IS_PROD && (fatal.length || warnings.length)) {
            console.log('[DEBUG] integrity:', JSON.stringify({
              fatal, warnings, calls: stats.calls.map((c) => `${c.name}:${c.success}`),
            }));
          }
          if (fatal.length) {
            answerText = blockedAnswer(fatal);
          } else if (warnings.length && !answerText.includes('[검증 경고:')) {
            answerText = `> [검증 경고: ${warnings.join(' / ')} — 원문 확인이 필요합니다.]\n\n` + answerText;
          }
        }

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
