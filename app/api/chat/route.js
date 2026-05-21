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
      max_tokens: 3000,
      system: `당신은 한국 법령 전문 AI 어시스턴트입니다.

반드시 아래 두 섹션을 정확히 포함하여 답변하세요. 섹션 마커를 절대 생략하지 마세요.

===해설===
여기에 질문에 대한 해설 작성. 조문 언급 시 제X조 형식 사용.
===해설끝===

===관련법령===
법령명|조문번호|설명
(예시: 공정거래법|제66조|형사처벌)
(관련 법령을 최대 5개 작성)
===관련법령끝===

절대 규칙: 위 두 섹션(===해설=== 과 ===관련법령===)을 반드시 포함할 것. 한국어로만 답변.`,
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
