import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MCP_URL = `https://korean-law-mcp.fly.dev/mcp?oc=${process.env.LAW_OC}`;
const ANSWER_MODEL = 'claude-sonnet-4-6';

const TOOL_TIMEOUT_MS = 20000;
const TOTAL_TIMEOUT_MS = 240000;
const MAX_STEPS = 8;
const MAX_TOOL_RESULT_CHARS = 12000;
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
    description: '법령의 특정 조문 본문을 조회. mst 또는 lawId 중 하나는 필수. 전체 법령을 통째로 받지 말고 jo로 핵심 조문만 지정할 것.',
    input_schema: {
      type: 'object',
      properties: {
        mst: { type: 'string', description: 'search_law에서 얻은 법령일련번호' },
        lawId: { type: 'string', description: 'search_law에서 얻은 법령ID' },
        jo: { type: 'string', description: "조문번호 (예: '제57조' 또는 '005700')" },
        efYd: { type: 'string', description: '시행일자 YYYYMMDD (선택)' },
      },
      required: [],
    },
  },
  {
    name: 'search_precedents',
    description: '법원 판례 검색.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색 키워드' },
        display: { type: 'number', description: '결과 수(기본 20, 최대 100)' },
        page: { type: 'number' },
        court: { type: 'string', description: '법원명(선택)' },
        caseNumber: { type: 'string', description: '사건번호(선택)' },
        fromDate: { type: 'string', description: 'YYYYMMDD' },
        toDate: { type: 'string', description: 'YYYYMMDD' },
        sort: { type: 'string', enum: ['lasc', 'ldes', 'dasc', 'ddes', 'nasc', 'ndes'] },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_interpretations',
    description: '기획재정부·국세청 등의 법령해석·예규(해석례) 검색.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색 키워드' },
        display: { type: 'number', description: '결과 수(기본 20, 최대 100)' },
        page: { type: 'number' },
        fromDate: { type: 'string', description: '회신일 시작 YYYYMMDD' },
        toDate: { type: 'string', description: '회신일 종료 YYYYMMDD' },
        sort: { type: 'string', enum: ['lasc', 'ldes', 'dasc', 'ddes', 'nasc', 'ndes'] },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_tax_tribunal_decisions',
    description: '조세심판원 결정례 검색.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색 키워드' },
        display: { type: 'number', description: '결과 수(기본 20, 최대 100)' },
        page: { type: 'number' },
        cls: { type: 'string', description: '재결구분코드(선택)' },
        dpaYd: { type: 'string', description: '처분일 범위 YYYYMMDD~YYYYMMDD' },
        rslYd: { type: 'string', description: '결정일 범위 YYYYMMDD~YYYYMMDD' },
        sort: { type: 'string', enum: ['lasc', 'ldes', 'dasc', 'ddes', 'nasc', 'ndes'] },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_decision_text',
    description: '검색으로 찾은 판례/해석례/심판례의 전문을 조회해 사건번호·예규번호를 정확히 확인한다.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: '검색한 도메인',
          enum: ['precedent', 'interpretation', 'tax_tribunal', 'nts', 'constitutional', 'treaty'],
        },
        id: { type: 'string', description: '검색 결과의 일련번호/ID' },
        full: { type: 'boolean', description: 'true=전문, 미지정=축약' },
      },
      required: ['domain', 'id'],
    },
  },
];

const ALLOWED = new Set(TOOL_DEFS.map((t) => t.name));
const systemPrompt = `당신은 대한민국 법률·세무 전문가 AI 어시스턴트입니다.
korean-law 도구로 법제처 실시간 데이터를 조회한 뒤, 그 데이터를 최우선 근거로 답변합니다.

[도구 사용 원칙]
- 먼저 search_law로 법령을 찾고(mst 획득), get_law_text로 핵심 조문만(mst+jo 지정) 조회한다. 법령 전체를 통째로 받지 말 것.
- 판례·해석례·심판례가 필요하면 도메인별 도구를 병렬로 호출한다:
  · search_precedents (법원 판례)
  · search_interpretations (기재부·국세청 법령해석·예규)
  · search_tax_tribunal_decisions (조세심판원 결정례)
- 핵심 항목은 get_decision_text(domain, id)로 전문을 확인해 사건번호·예규번호를 정확히 인용한다.
- 같은 도메인을 반복 호출하지 말고, 키워드를 좁혀 한두 번이면 충분하다.
- 도구 결과가 질문과 무관하면 억지로 엮지 말고 AI 지식으로 원칙을 설명한다.

[법적 위계 준수]
1. 원칙은 [법령 원문]과 [기재부/국세청 예규·해석례] 기준으로 먼저 서술.
2. 심판례·판례에서 납세자가 승소했다고 그 방식을 '합법/표준 실무'로 확대 해석 금지.
3. [원칙적 세무 실무]와 [예외적 구제 및 참고 심판례]를 분리. 심판례는 "예외적 구제 가능성"으로만 제시.
4. 핵심 결론은 법령·예규 기준으로 작성. 심판례로 결론을 뒤집지 말 것.

[출처 태그 - 모든 내용에 필수]
📋 [법령 원문] / ⚖️ [판례·해석례](사건번호·예규번호 명시) / 💡 [AI 해설] / ⚠️ [AI 추정]
- 별표(★)·신뢰도 표시 금지. 한국어로만 답변.

[답변 형식]
===해설===
# 📌 사안의 쟁점
질문을 1~2줄로 재구성
# 💡 핵심 결론
2~3줄 두괄식 요약
# 📖 상세 해설
법령 적용 과정을 논리적으로. 각 내용 앞에 출처 태그.
===해설끝===

===관련법령===
법령명|조문번호|설명
===관련법령끝===`;

function toToolResultText(r) {
  if (r && r.__error) return `조회 실패: ${r.message}`;
  const parts = Array.isArray(r?.content) ? r.content : [];
  let text = parts.map((p) => p?.text ?? (typeof p === 'string' ? p : JSON.stringify(p))).join('\n');
  if (!text) text = JSON.stringify(r);
  return text.length > MAX_TOOL_RESULT_CHARS
    ? text.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…(결과가 길어 일부 생략)'
    : text;
}
export async function POST(req) {
  const { messages } = await req.json();
  const lastUserMsg = messages.filter((m) => m.role === 'user').at(-1)?.content || '';
  console.log('[DEBUG] OC:', process.env.LAW_OC ? `set(len=${process.env.LAW_OC.length})` : '❌ MISSING');
  console.log('[DEBUG] 질문:', lastUserMsg.slice(0, 50));

  if (!process.env.LAW_OC) {
    return Response.json({ error: '서버 설정 오류: 법령 API 키 미설정' }, { status: 500 });
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const enc = new TextEncoder();
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode('data: ' + JSON.stringify(obj) + '\n\n'));

      const mcpClient = new Client({ name: 'law-chatbot', version: '1.0.0' }, { capabilities: {} });
      let mcpConnected = false;
      try {
        await mcpClient.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
        mcpConnected = true;
      } catch (e) {
        console.error('[ERROR] MCP 연결 실패:', e.message);
        send({ error: '법령 서버 연결 실패: ' + e.message });
        controller.close();
        return;
      }

      async function runTool(name, input) {
        if (!ALLOWED.has(name)) {
          return { __error: true, message: `비활성 도구(${name})` };
        }
        console.log('[DEBUG] 도구:', name, '입력:', JSON.stringify(input));
        try {
          return await mcpClient.callTool({ name, arguments: input }, undefined, { timeout: TOOL_TIMEOUT_MS });
        } catch (e) {
          console.error('[ERROR] 도구 타임아웃/실패:', name, e.message);
          return { __error: true, message: `${name} 조회 실패로 건너뜀` };
        }
      }

      const convo = messages.slice(-4).map(({ role, content }) => ({ role, content }));
      let fullText = '';

      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          if (Date.now() > deadline) throw new Error('TOTAL_TIMEOUT');
          const signal = AbortSignal.timeout(Math.max(1000, deadline - Date.now()));

          const ms = anthropic.messages.stream(
            {
              model: ANSWER_MODEL,
              max_tokens: 16000,
              system: systemPrompt,
              tools: TOOL_DEFS,
              messages: convo,
            },
            { signal }
          );

          for await (const ev of ms) {
            if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
              console.log('[DEBUG] MCP 도구 호출:', ev.content_block.name);
              send({ tool: ev.content_block.name });
            } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              fullText += ev.delta.text;
              send({ text: ev.delta.text });
            }
          }

          const final = await ms.finalMessage();
          if (final.stop_reason === 'max_tokens') send({ truncated: true });

          const toolUses = final.content.filter((c) => c.type === 'tool_use');
          if (toolUses.length === 0) break;

          convo.push({ role: 'assistant', content: final.content });
          const results = await Promise.all(
            toolUses.map(async (tu) => ({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: toToolResultText(await runTool(tu.name, tu.input)),
            }))
          );
          convo.push({ role: 'user', content: results });
        }

        send({ done: true, full: fullText });
      } catch (e) {
        const msg =
          e.message === 'TOTAL_TIMEOUT' || e.name === 'TimeoutError' || e.name === 'AbortError'
            ? '처리 시간이 초과됐습니다. 질문을 나눠서 다시 시도해 주세요.'
            : e.message;
        console.error('[ERROR] 루프:', e.name, e.message);
        send({ error: msg });
      } finally {
        if (mcpConnected) await mcpClient.close().catch(() => {});
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
