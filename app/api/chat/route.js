export const maxDuration = 60;

const WORKER_URL = "https://law-api.1405811.workers.dev";

async function searchLaw(query) {
  const res = await fetch(`${WORKER_URL}?query=${encodeURIComponent(query)}`);
  const data = await res.json();
  return data.laws || [];
}

async function getLawText(lawId) {
  const res = await fetch(`${WORKER_URL}?lawId=${lawId}`);
  const data = await res.json();
  return data;
}

export async function POST(req) {
  const { messages } = await req.json();
  const lastUserMsg = messages.filter(m => m.role === "user").at(-1)?.content || "";

  let lawContext = "";
  try {
    const keywords = lastUserMsg.replace(/[?!？！]/g, "").slice(0, 20);
    const laws = await searchLaw(keywords);

    if (laws.length > 0) {
      const lawId = laws[0].법령ID;
      if (lawId) {
        const lawDetail = await getLawText(lawId);
        const lawName = lawDetail.기본정보?.법령명_한글 || laws[0].법령명;
        const articles = lawDetail.조문?.조문단위;
        if (articles) {
          const artArr = Array.isArray(articles) ? articles : [articles];
          const artTexts = artArr.slice(0, 10).map(a => {
            const no = a.조문번호 || "";
            const title = a.조문제목 || "";
            const content = a.조문내용 || "";
            const items = a.항
              ? (Array.isArray(a.항) ? a.항 : [a.항])
                  .map(h => `  ${h.항번호 || ""} ${h.항내용 || ""}`)
                  .join("\n")
              : "";
            return `제${no}조${title ? `(${title})` : ""}\n${content}${items ? "\n" + items : ""}`;
          }).join("\n\n");
          lawContext = `【${lawName}】\n${artTexts}`;
        }
      }
    }
  } catch (e) {
    console.error("법제처 API 오류:", e);
  }

  const systemPrompt = `당신은 한국 법령 전문 AI 어시스턴트입니다.
아래 법령 원문 데이터를 참고하여 질문에 답변하세요.

답변 형식을 반드시 다음과 같이 구성하세요:

===법령원문===
${lawContext || "관련 법령을 찾지 못했습니다."}
===법령원문끝===

===해설===
위 법령을 바탕으로 쉽게 설명해주세요.
조문 언급 시 "제X조" 형식 사용.
===해설끝===

주의: 한국어로만 답변.`;

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
      system: systemPrompt,
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
