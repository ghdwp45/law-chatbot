export const maxDuration = 30;

export async function POST(req) {
  const { messages } = await req.json();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 3000,
      stream: true,
      system: `당신은 한국 법령 전문 AI 어시스턴트입니다.

반드시 아래 두 섹션을 정확히 포함하여 답변하세요.

===해설===
핵심 내용 위주로 간결하고 명확하게 설명 (조문별 설명, 실무 적용, 위반 시 제재 포함)
조문 언급 시 반드시 "제X조" 형식 사용
===해설끝===

===관련법령===
법령명|조문번호|설명
(관련 법령 최대 5개)
===관련법령끝===

절대 규칙: 위 두 섹션을 반드시 포함. 한국어로만 답변.`,
      messages: messages.slice(-4).map(({ role, content }) => ({ role, content })),
    }),
  });

  if (!response.ok) {
    const data = await response.json();
    return Response.json({ error: data.error?.message || "API 오류" }, { status: response.status });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n").filter(l => l.startsWith("data: "));

          for (const line of lines) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
                const text = parsed.delta.text;
                fullText += text;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ text })}\n\n`));
              }
            } catch {}
          }
        }
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ done: true, full: fullText })}\n\n`));
      } catch (e) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: e.message })}\n\n`));
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
