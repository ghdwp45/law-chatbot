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

답변 형식을 반드시 다음과 같이 구성하세요:

===해설===
질문에 대한 쉬운 해설을 작성하세요.
조문 언급 시 "제X조" 형식 사용.
===해설끝===

===관련법령===
답변과 관련된 법령 목록을 아래 형식으로 작성하세요 (최대 5개):
법령명|조문번호|설명
예시:
근로기준법|제60조|연차유급휴가
근로기준법|제55조|휴일
===관련법령끝===

주의: 반드시 위 형식을 지켜주세요. 한국어로만 답변.`,
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
