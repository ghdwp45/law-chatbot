"use client";
import { useState, useRef, useEffect } from "react";

const EXAMPLES = [
  { label: "📋 원문 조회", q: "근로기준법 제55조 제2항 원문 찾아줘" },
  { label: "💡 쉬운 해설", q: "감사인 독립성이 뭔지 쉽게 설명해줘" },
  { label: "🔍 법령 검색", q: "의제매입세액 공제와 관련된 법령을 찾아줘" },
  
];

const TAG_GUIDE = [
  { icon: "📋", label: "법령원문", desc: "법제처 원문 직접 인용" },
  { icon: "⚖️", label: "판례/해석례", desc: "법제처 판례·해석례 데이터 기반" },
  { icon: "💡", label: "AI 해설", desc: "원문 데이터를 바탕으로 한 AI 해석" },
  { icon: "⚠️", label: "AI 추정", desc: "원문 없이 AI 학습 데이터만 사용 (참고용으로만 활용, 법제처 원문 확인 권장)" },
];

const getLawSearchUrl = (lawName) =>
  `https://www.law.go.kr/lsSc.do?section=&menuId=1&subMenuId=15&tabMenuId=81&eventGubun=060101&query=${encodeURIComponent(lawName)}`;

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lawLinks, setLawLinks] = useState([]);
  const [activeArticle, setActiveArticle] = useState(null);
  const chatRef = useRef(null);
  const textareaRef = useRef(null);
  const linkRefs = useRef({});
  const readerRef = useRef(null);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, loading]);

  const parseResponse = (text) => {
    const explainMatch = text.match(/===해설===([\s\S]*?)===해설끝===/);
    const lawMatch = text.match(/===관련법령===([\s\S]*?)===관련법령끝===/);
    const explainText = explainMatch ? explainMatch[1].trim() : text;
    const links = [];
    if (lawMatch) {
      const lines = lawMatch[1].trim().split("\n").filter(l => l.includes("|"));
      lines.forEach(line => {
        const parts = line.split("|");
        if (parts.length >= 2) {
          links.push({ lawName: parts[0].trim(), articleNo: parts[1].trim(), desc: parts[2]?.trim() || "" });
        }
      });
    }
    return { explainText, links };
  };

  const handleArticleClick = (articleNo) => {
    setActiveArticle(articleNo);
    const key = articleNo.match(/제\d+조(?:의\d+)?/)?.[0];
    if (key && linkRefs.current[key]) {
      linkRefs.current[key].scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  useEffect(() => {
    window._clickArticle = handleArticleClick;
  }, [lawLinks]);

  const formatExplain = (text) => {
    return text
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/(제\d+조(?:의\d+)?(?:\s*제\d+항)?(?:\s*제\d+호)?)/g,
        `<span class="law-ref" onclick="window._clickArticle('$1')">$1</span>`)
      .replace(/\[([^\]]+?)(제\d+조(?:의\d+)?)\]/g,
        `<span class="law-tag" onclick="window._clickArticle('$2')">$1 $2</span>`)
      .replace(/\n/g, "<br/>");
  };

  const stopGeneration = () => {
    if (readerRef.current) {
      readerRef.current.cancel();
      readerRef.current = null;
    }
    setLoading(false);
  };

  const send = async (text) => {
    const userText = text || input.trim();
    if (!userText || loading) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setActiveArticle(null);

    const newMessages = [...messages, { role: "user", content: userText }];
    setMessages(newMessages);
    setLoading(true);

    // 빈 assistant 메시지 미리 추가
    setMessages(prev => [...prev, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages.map(({ role, content }) => ({ role, content })) }),
      });

      if (!res.ok) {
        const err = await res.json();
        const isOverloaded = err.error?.toLowerCase().includes("overload");
        throw new Error(isOverloaded ? "OVERLOADED" : (err.error || "오류 발생"));
      }

      const reader = res.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let streamBuf = "";   // 잠정(provisional) 스트리밍 버퍼: answerDelta 누적
      let buffer = "";

      // 라이브 표시용 정리: 스트리밍 중엔 ===마커와 관련법령 블록을 숨겨 본문만 보여준다.
      const liveExplain = (buf) => {
        let t = buf;
        const lawIdx = t.indexOf("===관련법령===");
        if (lawIdx !== -1) t = t.slice(0, lawIdx);
        return t.replace("===해설===", "").replace("===해설끝===", "").trim();
      };
      const renderLast = (content) => setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: "assistant", content };
        return updated;
      });

      // 하나의 완결된 SSE 이벤트(여러 data: 줄 가능, ': ping' 주석 줄 제외)를 처리.
      // OVERLOADED는 throw로 바깥 try/catch까지 전파한다.
      // 이벤트 계약: answerDelta=잠정 토큰(append) / discardDraft=잠정 폐기 /
      //             text·done.full=최종 권위(치환). 최종본은 비스트리밍과 동일.
      const handleEvent = (evt) => {
        const dataLines = evt.split("\n").filter(l => l.startsWith("data:"));
        if (dataLines.length === 0) return; // ': ping' 등 주석/빈 이벤트
        const json = dataLines.map(l => l.replace(/^data:\s?/, "")).join("");
        if (!json) return;
        let parsed;
        try {
          parsed = JSON.parse(json);
        } catch {
          return; // 비JSON/불완전 → 무시 (정상 이벤트는 버퍼로 완결됨)
        }
        // 잠정 토큰: 라이브 프리뷰에 누적 렌더
        if (parsed.answerDelta) {
          streamBuf += parsed.answerDelta;
          renderLast(liveExplain(streamBuf));
        }
        // 잠정 폐기: 도구 호출 전 중간출력 또는 재작성 직전 → 버퍼 비우고 '조회 중' 표시로 복귀
        if (parsed.discardDraft) {
          streamBuf = "";
          renderLast("");
        }
        // 최종 권위 텍스트(원본): 스트리밍분을 폐기하고 치환
        if (parsed.text) {
          streamBuf = "";
          renderLast(liveExplain(parsed.text));
        }
        // 최종 완료: 형식 파싱 후 해설 본문으로 치환 + 관련법령 링크 표시
        if (parsed.done && parsed.full) {
          const { explainText, links } = parseResponse(parsed.full);
          renderLast(explainText);
          if (links.length > 0) setLawLinks(links);
        }
        if (parsed.error) {
          const isOverloaded = parsed.error.toLowerCase().includes("overload");
          throw new Error(isOverloaded ? "OVERLOADED" : parsed.error);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // 청크를 누적: read()는 SSE 이벤트 경계와 무관하게 쪼개져 들어온다.
        buffer += decoder.decode(value, { stream: true });
        // 이벤트 경계는 빈 줄(\n\n). 마지막 미완성 조각은 버퍼에 남겨둔다.
        const parts = buffer.split("\n\n");
        buffer = parts.pop();
        for (const evt of parts) handleEvent(evt);
      }
      // 스트림 종료 후 남은 완결 이벤트 처리
      if (buffer.trim()) handleEvent(buffer);
    } catch (e) {
      const isOverloaded = e.message === "OVERLOADED" || e.message?.toLowerCase().includes("overload");
      const errMsg = isOverloaded
        ? "⚠️ 서버 과부하 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
        : `❌ ${e.message}`;

      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: "assistant", content: errMsg };
        return updated;
      });
    } finally {
      readerRef.current = null;
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const autoResize = (e) => {
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  const resetChat = () => {
    if (messages.length === 0) return;
    if (confirm("대화 내용을 초기화하시겠습니까?")) {
      setMessages([]);
      setLawLinks([]);
      setActiveArticle(null);
    }
  };

  return (
    <div style={s.root}>
      <header style={s.header}>
        <div style={s.headerLeft}>
          <div style={s.seal}>법</div>
          <div>
            <div style={s.headerTitle}>법령 AI 어시스턴트</div>
            <div style={s.headerSub}>국가법령정보 기반 · law.go.kr 연동</div>
          </div>
        </div>
        <div style={s.headerRight}>
          <button onClick={resetChat} style={s.resetBtn}>⟳ 초기화</button>
          <div style={s.statusWrap}>
            <div style={{...s.dot, background: loading ? "#f39c12" : "#2ecc71"}} />
            <span style={s.statusText}>{loading ? "조회 중..." : "연결됨"}</span>
          </div>
        </div>
      </header>

      <div style={s.body}>
        <div style={s.leftPane}>
          <div style={s.chatArea} ref={chatRef}>
            {messages.length === 0 && (
              <div style={s.welcome}>
                <div style={s.welcomeIcon}>⚖️</div>
                <h2 style={s.welcomeTitle}>한국 법령 AI 어시스턴트</h2>
                <p style={s.welcomeDesc}>법령 해설부터 관련 조문 검색까지<br/>답변의 <span style={{color:"#c0392b",fontWeight:600}}>조문번호</span>를 클릭하면 오른쪽에서 하이라이트됩니다</p>
                <div style={s.examples}>
                  {EXAMPLES.map((ex) => (
                    <button key={ex.q} style={s.exBtn} onClick={() => send(ex.q)}>
                      <span style={s.exLabel}>{ex.label}</span>
                      {ex.q}
                    </button>
                  ))}
                </div>
                {/* 태그 안내 */}
                <div style={s.tagGuide}>
                  <div style={s.tagGuideTitle}>답변에 표시되는 출처 태그 안내</div>
                  {TAG_GUIDE.map((t) => (
                    <div key={t.label} style={s.tagGuideRow}>
                      <span style={s.tagGuideIcon}>{t.icon}</span>
                      <span style={s.tagGuideLabel}>{t.label}</span>
                      <span style={s.tagGuideDesc}>— {t.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} style={{...s.msgRow, justifyContent: m.role === "user" ? "flex-end" : "flex-start"}}>
                {m.role === "assistant" && <div style={s.avatarAi}>법</div>}
                <div
                  style={m.role === "user" ? s.bubbleUser : s.bubbleAi}
                  dangerouslySetInnerHTML={{ __html: m.role === "assistant" ? formatExplain(m.content) : m.content }}
                />
                {m.role === "user" && <div style={s.avatarUser}>나</div>}
              </div>
            ))}

            {loading && messages[messages.length-1]?.content === "" && (
              <div style={{...s.msgRow, justifyContent: "flex-start"}}>
                <div style={s.avatarAi}>법</div>
                <div style={s.typing}>
                  {[0,1,2].map(i => <span key={i} style={{...s.typingDot, animationDelay:`${i*0.2}s`}}/>)}
                </div>
              </div>
            )}
          </div>

          <div style={s.inputArea}>
            <div style={s.inputRow}>
              <textarea
                ref={textareaRef}
                style={s.textarea}
                value={input}
                onChange={(e) => { setInput(e.target.value); autoResize(e); }}
                onKeyDown={handleKey}
                placeholder="법령명, 조문번호, 또는 궁금한 내용을 입력하세요..."
                rows={1}
              />
              {loading ? (
                <button style={s.stopBtn} onClick={stopGeneration}>■</button>
              ) : (
                <button style={s.sendBtn} onClick={() => send()}>▶</button>
              )}
            </div>
            <div style={s.hint}>
              Enter 전송 · Shift+Enter 줄바꿈 · 답변 생성 중 ■ 버튼으로 중단
              <span style={s.hintDivider}>│</span>
              📋 법령원문 · 💡 AI해설(원문 기반) · ⚠️ AI추정(원문 없음) · ⚖️ 판례/해석례
            </div>
          </div>
        </div>

        <div style={s.rightPane}>
          <div style={s.rightHeader}>
            <span style={s.rightHeaderIcon}>📜</span>
            <span style={s.rightHeaderTitle}>관련 법령</span>
            {lawLinks.length > 0 && <span style={s.rightHeaderBadge}>{lawLinks.length}개</span>}
          </div>

          <div style={s.lawContent}>
            {lawLinks.length === 0 ? (
              <div style={s.emptyLaw}>
                <div style={s.emptyIcon}>⚖️</div>
                <p style={s.emptyText}>질문하면 관련 법령 링크가<br/>여기에 표시됩니다</p>
                <p style={s.emptySubText}>클릭하면 국가법령정보센터에서<br/>원문을 바로 확인할 수 있습니다</p>
              </div>
            ) : (
              <div>
                <div style={s.lawNote}>💡 왼쪽 답변의 <strong>조문번호</strong>를 클릭하면 해당 법령이 하이라이트됩니다</div>
                {lawLinks.map((link, i) => {
                  const key = link.articleNo.match(/제\d+조(?:의\d+)?/)?.[0];
                  const isActive = activeArticle && link.articleNo.includes(activeArticle.match(/제\d+조(?:의\d+)?/)?.[0] || activeArticle);
                  return (
                    <a key={i}
                      ref={el => { if (key) linkRefs.current[key] = el; }}
                      href={getLawSearchUrl(link.lawName)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{...s.lawLink, ...(isActive ? s.lawLinkActive : {})}}
                    >
                      {isActive && <div style={s.highlightBadge}>👆 현재 선택된 조문</div>}
                      <div style={s.lawLinkTop}>
                        <span style={s.lawLinkName}>{link.lawName}</span>
                        <span style={{...s.lawLinkArticle, ...(isActive ? s.lawLinkArticleActive : {})}}>{link.articleNo}</span>
                      </div>
                      {link.desc && <div style={s.lawLinkDesc}>{link.desc}</div>}
                      <div style={s.lawLinkUrl}>🔗 law.go.kr에서 원문 보기 →</div>
                    </a>
                  );
                })}
                <div style={s.lawDirectSearch}>
                  <div style={s.lawDirectTitle}>📌 직접 검색</div>
                  <a href="https://www.law.go.kr" target="_blank" rel="noopener noreferrer" style={s.lawDirectLink}>
                    국가법령정보센터 바로가기 →
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@700&family=Noto+Sans+KR:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Noto Sans KR', sans-serif; overflow: hidden; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #d4c9b0; border-radius: 2px; }
        @keyframes blink { 0%,60%,100%{transform:translateY(0);opacity:.4} 30%{transform:translateY(-5px);opacity:1} }
        @keyframes highlight-pulse { 0%,100%{box-shadow:0 0 0 3px rgba(192,57,43,0.3)} 50%{box-shadow:0 0 0 6px rgba(192,57,43,0.1)} }
        .law-ref { color:#c0392b; font-weight:700; cursor:pointer; border-bottom:1.5px dashed #c0392b; padding:0 2px; }
        .law-ref:hover { background:#fde8e8; border-radius:3px; }
        .law-tag {
          display: inline-block;
          background: #1a1208;
          color: #f5f0e8;
          font-size: 10px;
          font-weight: 600;
          padding: 2px 7px;
          border-radius: 10px;
          margin-left: 4px;
          cursor: pointer;
          vertical-align: middle;
          transition: background 0.15s;
        }
        .law-tag:hover { background: #c0392b; }
      `}</style>
    </div>
  );
}

const s = {
  root:{display:"flex",flexDirection:"column",height:"100vh",background:"#f5f0e8",fontFamily:"'Noto Sans KR',sans-serif"},
  header:{background:"#1a1208",color:"#f5f0e8",padding:"0 24px",height:52,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,borderBottom:"3px solid #b8922a"},
  headerLeft:{display:"flex",alignItems:"center",gap:12},
  headerRight:{display:"flex",alignItems:"center",gap:14},
  seal:{width:34,height:34,background:"#c0392b",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Noto Serif KR',serif",fontSize:14,fontWeight:700,color:"white"},
  headerTitle:{fontFamily:"'Noto Serif KR',serif",fontSize:15,fontWeight:700,letterSpacing:1},
  headerSub:{fontSize:11,color:"#aaa",fontWeight:300},
  resetBtn:{background:"transparent",border:"1px solid #555",color:"#ccc",padding:"5px 10px",borderRadius:6,fontSize:11,cursor:"pointer",fontFamily:"'Noto Sans KR',sans-serif"},
  statusWrap:{display:"flex",alignItems:"center",gap:6},
  dot:{width:8,height:8,borderRadius:"50%",transition:"background 0.3s"},
  statusText:{fontSize:11,color:"#aaa"},
  body:{display:"flex",flex:1,overflow:"hidden"},
  leftPane:{display:"flex",flexDirection:"column",flex:"0 0 50%",borderRight:"1px solid #d4c9b0",overflow:"hidden"},
  chatArea:{flex:1,overflowY:"auto",padding:"20px 16px",display:"flex",flexDirection:"column",gap:14},
  welcome:{textAlign:"center",padding:"28px 16px"},
  welcomeIcon:{fontSize:36,marginBottom:10},
  welcomeTitle:{fontFamily:"'Noto Serif KR',serif",fontSize:22,fontWeight:700,color:"#1a1208",marginBottom:6},
  welcomeDesc:{fontSize:14,color:"#7a6e60",lineHeight:1.7,marginBottom:16},
  examples:{display:"flex",flexDirection:"column",gap:7,maxWidth:400,margin:"0 auto"},
  exBtn:{background:"#fdfaf4",border:"1px solid #d4c9b0",borderRadius:8,padding:"11px 16px",fontSize:14,color:"#1a1208",cursor:"pointer",textAlign:"left",fontFamily:"'Noto Sans KR',sans-serif",lineHeight:1.5},
  exLabel:{fontSize:12,fontWeight:700,color:"#b8922a",letterSpacing:0.5,display:"block",marginBottom:2},
  tagGuide:{maxWidth:400,margin:"16px auto 0",padding:"12px 16px",background:"#fdfaf4",border:"1px solid #d4c9b0",borderRadius:8,textAlign:"left"},
  tagGuideTitle:{fontSize:13,fontWeight:700,color:"#1a1208",marginBottom:8,letterSpacing:0.3},
  tagGuideRow:{display:"flex",alignItems:"flex-start",gap:6,marginBottom:6,fontSize:13,lineHeight:1.5},
  tagGuideIcon:{flexShrink:0,width:18},
  tagGuideLabel:{fontWeight:700,color:"#1a1208",flexShrink:0,width:72},
  tagGuideDesc:{color:"#7a6e60"},
  msgRow:{display:"flex",gap:8,alignItems:"flex-start"},
  avatarAi:{width:30,height:30,background:"#1a1208",color:"#f5f0e8",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Noto Serif KR',serif",fontSize:11,fontWeight:700,flexShrink:0},
  avatarUser:{width:30,height:30,background:"#b8922a",color:"white",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0},
  bubbleAi:{maxWidth:"calc(100% - 60px)",padding:"10px 14px",borderRadius:"10px 10px 10px 3px",background:"#fdfaf4",border:"1px solid #d4c9b0",fontSize:13,lineHeight:1.8,color:"#1a1208"},
  bubbleUser:{maxWidth:"calc(100% - 60px)",padding:"10px 14px",borderRadius:"10px 10px 3px 10px",background:"#1a1208",color:"#f5f0e8",fontSize:13,lineHeight:1.8},
  typing:{display:"flex",alignItems:"center",gap:4,padding:"10px 14px",background:"#fdfaf4",border:"1px solid #d4c9b0",borderRadius:"10px 10px 10px 3px"},
  typingDot:{width:6,height:6,background:"#7a6e60",borderRadius:"50%",display:"inline-block",animation:"blink 1.2s infinite"},
  inputArea:{padding:"10px 14px 14px",background:"#ede6d6",borderTop:"1px solid #d4c9b0",flexShrink:0},
  inputRow:{display:"flex",gap:8,alignItems:"flex-end",background:"#fdfaf4",border:"1.5px solid #d4c9b0",borderRadius:10,padding:"7px 7px 7px 12px"},
  textarea:{flex:1,border:"none",outline:"none",background:"transparent",fontFamily:"'Noto Sans KR',sans-serif",fontSize:13,color:"#1a1208",resize:"none",maxHeight:120,minHeight:22,lineHeight:1.6},
  sendBtn:{width:34,height:34,background:"#1a1208",border:"none",borderRadius:7,cursor:"pointer",color:"#f5f0e8",fontSize:13,flexShrink:0},
  stopBtn:{width:34,height:34,background:"#c0392b",border:"none",borderRadius:7,cursor:"pointer",color:"white",fontSize:13,flexShrink:0},
  hint:{fontSize:12,color:"#7a6e60",marginTop:5,textAlign:"center",lineHeight:1.8},
  hintDivider:{margin:"0 6px",color:"#d4c9b0"},
  rightPane:{display:"flex",flexDirection:"column",flex:"0 0 50%",overflow:"hidden",background:"#fdfaf4"},
  rightHeader:{display:"flex",alignItems:"center",gap:8,padding:"14px 18px",borderBottom:"1px solid #d4c9b0",background:"#f5f0e8",flexShrink:0},
  rightHeaderIcon:{fontSize:16},
  rightHeaderTitle:{fontFamily:"'Noto Serif KR',serif",fontSize:14,fontWeight:700,color:"#1a1208",flex:1},
  rightHeaderBadge:{fontSize:11,background:"#c0392b",color:"white",padding:"2px 8px",borderRadius:10,fontWeight:500},
  lawContent:{flex:1,overflowY:"auto",padding:"16px"},
  emptyLaw:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",padding:40,textAlign:"center"},
  emptyIcon:{fontSize:40,marginBottom:16,opacity:0.3},
  emptyText:{fontSize:13,color:"#7a6e60",lineHeight:1.8,marginBottom:8},
  emptySubText:{fontSize:11,color:"#aaa",lineHeight:1.7},
  lawNote:{fontSize:11,color:"#7a6e60",marginBottom:12,padding:"8px 12px",background:"#f5f0e8",borderRadius:6,lineHeight:1.6},
  lawLink:{display:"block",padding:"14px 16px",border:"1px solid #d4c9b0",borderRadius:8,marginBottom:10,background:"white",textDecoration:"none",color:"inherit",transition:"all 0.2s"},
  lawLinkActive:{border:"2px solid #c0392b",background:"#fff8f8",animation:"highlight-pulse 1.5s ease-in-out"},
  highlightBadge:{fontSize:10,color:"#c0392b",fontWeight:700,marginBottom:6,letterSpacing:0.5},
  lawLinkTop:{display:"flex",alignItems:"center",gap:8,marginBottom:4},
  lawLinkName:{fontFamily:"'Noto Serif KR',serif",fontSize:13,fontWeight:700,color:"#1a1208"},
  lawLinkArticle:{fontSize:11,background:"#c0392b",color:"white",padding:"2px 7px",borderRadius:10},
  lawLinkArticleActive:{background:"#c0392b",boxShadow:"0 0 0 2px #c0392b,0 0 0 4px rgba(192,57,43,0.2)"},
  lawLinkDesc:{fontSize:12,color:"#7a6e60",marginBottom:6},
  lawLinkUrl:{fontSize:11,color:"#b8922a",fontWeight:500},
  lawDirectSearch:{marginTop:20,padding:"14px 16px",border:"1px dashed #d4c9b0",borderRadius:8},
  lawDirectTitle:{fontSize:12,fontWeight:700,color:"#1a1208",marginBottom:8},
  lawDirectLink:{fontSize:12,color:"#b8922a",fontWeight:500,textDecoration:"none"},
};
