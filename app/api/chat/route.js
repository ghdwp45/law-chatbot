export const maxDuration = 300;

const MCP_URL = `https://korean-law-mcp.fly.dev/mcp?oc=${process.env.LAW_OC}`;
const ANSWER_MODEL = 'claude-sonnet-4-6';
const IDLE_TIMEOUT_MS = 120000;
const TOTAL_TIMEOUT_MS = 250000;

const systemPrompt = `당신은 대한민국 법률 전문가 AI 어시스턴트입니다.
korean-law MCP 도구로 법제처 실시간 데이터(법령·판례·해석례·행정규칙 등)를 조회한 뒤,
그 데이터를 최우선 근거로 정확하고 완전한 답변을 제공합니다.

[도구 사용 원칙]
- 질문을 받으면 먼저 korean-law 도구로 관련 법령·판례·해석례를 조회할 것.
- 질문 성격에 맞는 도구를 충분히 활용할 것: 판례·결정례가 필요하면 search_decisions,
  별표·서식이 필요하면 get_annexes, 다단계 리서치가 필요하면 chain 계열 도구 등 적절히 사용.
- 답변에 인용한 조문은 verify_citations로 실존 여부를 검증하여 환각을 방지할 것.
- 도구 결과가 질문과 명백히 무관하면 억지로 엮지 말고, AI 학습 지식으로 원칙을 설명할 것.

[법적 위계 준수 - 핵심 규칙]
1. 원칙 기준: 세무·법률 판단의 원칙은 반드시 [법령 원문]과 [기획재정부/국세청 예규·해석례]를 기준으로 먼저 서술할 것.
2. 심판례/판례의 제한적 해석: 조세심판원 결정례나 판례에서 납세자가 승소했다고 해서, 그 예외적 방식이 세법상 '합법' 또는 '표준 실무'라고 확대 해석 금지.
3. 구조 분리: [원칙적인 세무 실무]와 [예외적 구제 및 참고 심판례]를 엄격히 분리. 심판례는 "예외적 구제 가능성"으로만 제시.
4. 원칙 우선 결론: 핵심 결론은 법령·예규 원칙 기준으로 작성. 심판례로 결론을 뒤집지 말 것.

[출처 태그 - 모든 내용에 필수]
📋 [법령 원문] - MCP로 조회한 조문 인용 시
⚖️ [판례/해석례] - 판례/예규 인용 시 반드시 사건번호 또는 예규번호 명시
💡 [AI 해설] - 법령 지식 기반 해석 및 실무 설명
⚠️ [AI 추정] - 출처를 특정할 수 없거나 불확실한 내용
- 별표(★)·신뢰도 표시(★★★) 사용 금지
- 한국어로만 답변

[답변 형식]
===해설===
# 📌 사안의 쟁점
질문을 1~2줄로 명확히 재구성

# 💡 핵심 결론
핵심 답변을 2~3줄로 요약 (두괄식)

# 📖 상세 해설
법령이 사안에 적용되는 과정을 논리적 순서로 설명.
전문 용어는 쉽게 풀어서. 각 내용 앞에 출처 태그를 반드시 표시.
===해설끝===

===관련법령===
법령명|조문번호|설명
===관련법령끝===`;

export async function POST(req) {
  const { messages } = await req.json();
  const lastUserMsg = messages.filter(m => m.role === 'user').at(-1)?.content || '';

  // ★ OC 키 진단 로그 (값은 안 찍고 세팅 여부만)
  console.log('[DEBUG] OC:', process.env.LAW_OC ? `set(len=${process.env.LAW_OC.length})` : '❌ MISSING');
  console.log('[DEBUG] MCP_URL:', MCP_URL.replace(/oc=([^&]+)/, 'oc=***'));
  console.log('[DEBUG] 사용자 질문:', lastUserMsg.slice(0, 50));

  const abort = new AbortController();
  let abortReason = null;

  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { abortReason = 'IDLE'; abort.abort(); }, IDLE_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(() => { abortReason = 'TOTAL'; abort.abort(); }, TOTAL_TIMEOUT_MS);
  const clearTimers = () => { clearTimeout(idleTimer); clearTimeout(totalTimer); };
  resetIdle();

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04',
      },
      body: JSON.stringify({
        model: ANSWER_MODEL,
        max_tokens: 16000,
        stream: true,
        system: systemPrompt,
        messages: messages.slice(-4).map(({ role, content }) => ({ role, content })),
        mcp_servers: [{
          type: 'url',
          url: MCP_URL,
          name: 'korean-law',
        }],
      }),
    });
  } catch (e) {
    clearTimers();
    console.error('[ERROR] Claude API 호출 실패:', e.message);
    return Response.json({ error: 'API 호출 실패: ' + e.message }, { status: 502 });
  }

  if (!response.ok) {
    clearTimers();
    const data = await response.json().catch(() => ({}));
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
      const enc = new TextEncoder();
      let buffer = '';
      let fullText = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdle(); // 바이트 오면 무조건 idle 리셋
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const ev = JSON.parse(data);

              if (ev.type === 'error' || ev.error) {
                console.error('[ERROR] 스트림 이벤트 에러:', JSON.stringify(ev));
                controller.enqueue(enc.encode(
                  'data: ' + JSON.stringify({ error: ev.error?.message || JSON.stringify(ev) }) + '\n\n'
                ));
                continue;
              }

              if (ev.type === 'content_block_start' && ev.content_block?.type === 'mcp_tool_use') {
                console.log('[DEBUG] MCP 도구 호출:', ev.content_block.name);
                controller.enqueue(enc.encode(
                  'data: ' + JSON.stringify({ tool: ev.content_block.name }) + '\n\n'
                ));
              }

              if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                fullText += ev.delta.text;
                controller.enqueue(enc.encode(
                  'data: ' + JSON.stringify({ text: ev.delta.text }) + '\n\n'
                ));
              }

              if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
                console.log('[DEBUG] stop_reason:', ev.delta.stop_reason);
                if (ev.delta.stop_reason === 'max_tokens') {
                  controller.enqueue(enc.encode(
                    'data: ' + JSON.stringify({ truncated: true }) + '\n\n'
                  ));
                }
              }
            } catch {}
          }
        }
        controller.enqueue(enc.encode(
          'data: ' + JSON.stringify({ done: true, full: fullText }) + '\n\n'
        ));
      } catch (e) {
        let msg;
        if (abortReason === 'IDLE') {
          msg = '법령 서버 응답이 끊겼습니다(연결 무응답). 잠시 후 다시 시도해 주세요.';
        } else if (abortReason === 'TOTAL') {
          msg = '처리 시간이 초과됐습니다. 질문을 나눠서 다시 시도해 주세요.';
        } else {
          msg = e.message;
        }
        console.error('[ERROR] 스트림 처리:', abortReason || e.name, e.message);
        controller.enqueue(enc.encode(
          'data: ' + JSON.stringify({ error: msg }) + '\n\n'
        ));
      } finally {
        clearTimers();
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
