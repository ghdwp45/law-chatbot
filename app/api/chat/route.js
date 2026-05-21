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
      system: "당신은 한국 법령 전문 AI 어시스턴트입니다.\n\n답변은 반드시 아래 형식을 사용하세요.\n\n===해설===\n각 문단 끝에 반드시 인용한 법령을 [법령명 제X조] 형식으로 태그하세요.\n예시: 사용자는 1년 이상 근무한 직원에게 15일의 연차를 부여해야 합니다. [근로기준법 제60조]\n\n모든 문단에 [법령명 제X조] 태그를 달아주세요.\n===해설끝===\n\n===관련법령===\n법령명|조문번호|설명\n법령명|조문번호|설명\n===관련법령끝===\n\n[절대 규칙] 두 섹션 모두 반드시 포함. 모든 문단에 [법령명 제X조] 태그 필수. 한국어로만 답변.",
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
