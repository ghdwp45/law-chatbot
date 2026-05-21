"use client";
import { useState, useRef, useEffect } from "react";

const EXAMPLES = [
  { label: "📋 원문 조회", q: "근로기준법 제60조 연차유급휴가 알려줘" },
  { label: "💡 쉬운 해설", q: "퇴직금 지급 기준이 어떻게 되는지 쉽게 설명해줘" },
  { label: "🔍 법령 검색", q: "부가가치세법에서 면세 대상은 뭐야?" },
  { label: "⚠️ 처벌 규정", q: "공정거래법 위반 시 처벌 규정 알려줘" },
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
      .replace(/\n/g, "<br/>");
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

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages.map(({ role, content }) => ({ role, content })) }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "오류 발생");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      setMessages(prev => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(l => l.startsWith("data: "));
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.text) {
              fullText += parsed.text;
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: "assistant", content: fullText };
                return updated;
              });
            }
            if (parsed.done && parsed.full) {
              const { explainText, links } = parseResponse(parsed.full);
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: "assistant", content: explainText };
                return updated;
              });
              if (links.length > 0) setLawLinks(links);
            }
            if (parsed.error) throw new Error(parsed.error);
          } catch {}
        }
      }
    } catch (e) {
      setMessages(prev => {
        const updated = [...prev];
        if (updated[updated.length - 1]?.role === "assistant") {
          updated[updated.length - 1] = { role: "assistant", content: `❌ ${e.message}` };
        } else {
          updated.push({ role: "assistant", content: `❌ ${e.message}` });
        }
        return updated;
      });
    } finally {
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
              <button style={{...s.sendBtn, opacity: loading ? 0.4 : 1}} onClick={() => send()} disabled={loading}>▶</button>
            </div>
            <div style={s.hint}>Enter 전송 · Shift+Enter 줄바꿈 · 답변의 <span style={{color:"#c0392b",fontWeight:600}}>조문번호</span> 클릭 시 오른쪽 하이라이트</div>
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
  welcomeTitle:{fontFamily:"'Noto Serif KR',serif",fontSize:18,fontWeight:700,color:"#1a1208",marginBottom:6},
  welcomeDesc:{fontSize:12,color:"#7a6e60",lineHeight:1.7,marginBottom:16},
  examples:{display:"flex",flexDirection:"column",gap:7,maxWidth:400,margin:"0 auto"},
  exBtn:{background:"#fdfaf4",border:"1px solid #d4c9b0",borderRadius:8,padding:"9px 14px",fontSize:12,color:"#1a1208",cursor:"pointer",textAlign:"left",fontFamily:"'Noto Sans KR',sans-serif",lineHeight:1.5},
  exLabel:{fontSize:10,fontWeight:700,color:"#b8922a",letterSpacing:0.5,display:"block",marginBottom:2},
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
  hint:{fontSize:10,color:"#7a6e60",marginTop:5,textAlign:"center"},
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
