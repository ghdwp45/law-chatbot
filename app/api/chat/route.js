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

답변 형식:
1. 먼저 조회한 법령 원문을 아래 형식으로 제시:
【법령명】
제X조(조문제목) 조문 내용 전체...

2. 그 아래에 쉬운 해설 제공
3. 조문 언급 시 반드시 "제X조" 형식으로 표기

주의: 반드시 MCP 도구로 실제 데이터를 조회하세요. 한국어로만 답변.`,
      messages,
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

  // Anthropic이 MCP 호출을 자체 처리한 최종 응답에서 텍스트만 추출
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return Response.json({ text: text || "답변을 생성하지 못했습니다." });
}
