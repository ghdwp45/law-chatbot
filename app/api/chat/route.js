export const maxDuration = 60;

export async function POST(req) {
  const { messages } = await req.json();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-11-20",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      system: `당신은 한국 법령 전문 AI 어시스턴트입니다. Korean Law MCP 도구를 반드시 사용하여 실제 법령 데이터를 조회하고 답변합니다.

답변 형식을 반드시 다음과 같이 두 부분으로 명확히 구분하세요:

===법령원문===
【법령명】
제X조(조문제목)
조문 내용 전체...

【다른 법령명】
제Y조(조문제목)
조문 내용 전체...
===법령원문끝===

===해설===
여기에 일반인이 이해할 수 있는 해설을 작성합니다.
조문 언급 시 "제X조" 형식 사용.
===해설끝===

중요 규칙:
- 반드시 위 마커(===)를 정확히 사용
- 법령원문 섹션에는 오직 조문 원문만 (해설 금지)
- 해설 섹션에는 설명만 (원문 인용은 짧게 "제X조"로만 참조)
- MCP 도구로 실제 데이터 조회 필수
- 한국어로만 답변`,
      messages: messages.slice(-4),
      mcp_servers: [
        {
          type: "url",
          url: "https://korean-law-mcp.fly.dev/mcp?oc=hongjeyeon",
          name: "korean-law",
        },
      ],
      tools: [
        {
          type: "mcp_toolset",
          mcp_server_name: "korean-law",
        },
      ],
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

  return Response.json({ text: text || "답변을 생성하지 못했습니다." });
}
