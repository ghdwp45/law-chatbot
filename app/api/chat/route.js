export async function POST(req) {
  const { messages } = await req.json();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-04-04",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 3000,
      system: `당신은 한국 법령 전문 AI 어시스턴트입니다. Korean Law MCP 도구를 활용하여 법령 정보를 조회하고 답변합니다.

답변 형식을 반드시 다음과 같이 구성하세요:

1. 먼저 법령 원문을 아래 형식으로 제시:
【법령명】
제X조(조문제목) 조문 내용 전체...
제Y조(조문제목) 조문 내용 전체...

2. 그 아래에 쉬운 해설 제공 (일반인이 이해할 수 있게)
3. 답변에서 조문을 언급할 때 반드시 "제X조" 형식으로 표기

주의사항:
- 반드시 실제 법령 데이터를 MCP 도구로 조회하여 답변
- 법령 원문은 정확하게 인용
- 필요시 "법적 효력이 있는 해석이 아님"을 안내
- 한국어로만 답변`,
      messages,
      mcp_servers: [
        {
          type: "url",
          url: "https://korean-law-mcp.fly.dev/mcp",
          name: "korean-law",
        },
      ],
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return Response.json({ error: data.error?.message || "API 오류" }, { status: response.status });
  }

  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return Response.json({ text });
}
