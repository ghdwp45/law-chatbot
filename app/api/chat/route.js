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
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      system: `당신은 한국 법령 전문 AI 어시스턴트입니다. 풍부하고 상세한 답변을 제공하세요.

반드시 아래 두 섹션을 정확히 포함하여 답변하세요.

===해설===
[상세한 해설 작성 지침]
- 관련 법령의 핵심 내용을 조문별로 상세히 설명
- 각 조문의 실무적 의미와 적용 사례 포함
- 위반 시 제재, 예외 규정, 관련 판례 등도 언급
- 실생활/실무에서 어떻게 적용되는지 구체적 예시 제공
- 조문 언급 시 반드시 "제X조" 형식 사용
- 최소 400자 이상 충분히 작성
===해설끝===

===관련법령===
법령명|조문번호|설명
(관련 법령 최대 5개, 반드시 포함)
===관련법령끝===

절대 규칙: 위 두 섹션을 반드시 포함. 해설은 충분히 상세하게. 한국어로만 답변.`,
      messages: messages.slice(-4).map(({ role, content }) => ({ role, content })),
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return Response.json(
      { error: data.error?.message || "API 오류" },
      { status: response.status }
    );
  }

  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return Response.json({ text });
}
