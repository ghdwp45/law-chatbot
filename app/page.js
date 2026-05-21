"use client";
import { useState, useRef, useEffect } from "react";

const EXAMPLES = [
  { label: "📋 원문 조회", q: "근로기준법 제60조 연차유급휴가 조문 알려줘" },
  { label: "💡 쉬운 해설", q: "퇴직금 지급 기준이 어떻게 되는지 쉽게 설명해줘" },
  { label: "🔍 법령 검색", q: "부가가치세법에서 면세 대상은 뭐야?" },
  { label: "⚠️ 처벌 규정", q: "공정거래법 위반 시 처벌 규정 알려줘" },
];

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lawPanels, setLawPanels] = useState([]);
  const [activeRef, setActiveRef] = useState(null);
  const chatRef = useRef(null);
  const textareaRef = useRef(null);
  const lawRefs = useRef({});

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, loading]);

  // 응답에서 원문/해설 분리
  const parseResponse = (text) => {
    const lawMatch = text.match(/===법령원문===([\s\S]*?)===법령원문끝===/);
    const explainMatch = text.match(/===해설===([\s\S]*?)===해설끝===/);

    const lawText = lawMatch ? lawMatch[1].trim() : "";
    const explainText = explainMatch ? explainMatch[1].trim() : text;

    // 법령 원문 파싱
    const panels = [];
    if (lawText) {
      const lawBlocks = lawText.split(/(?=【[^】]+】)/).filter(b => b.trim());
      lawBlocks.forEach(block => {
        const titleMatch = block.match(/【([^】]+)】/);
        if (!titleMatch) return;
        const title = titleMatch[1];
        const content = block.replace(/【[^】]+】/, "").trim();
        const articles = [];
        const artBlocks = content.split(/(?=제\d+조)/).filter(a => a.trim());
        artBlocks.forEach(art => {
          const noMatch = art.match(/^(제\d+조(?:의\d+)?)([^\n]*)/);
          if (noMatch) {
            articles.push({
              no: noMatch[1],
              title: noMatch[2].trim(),
              content: art.trim()
            });
          }
        });
        if (articles.length > 0) panels.push({ title, articles });
      });
    }

    return { explainText, panels };
  };

  const formatExplain = (text) => {
    return text
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/(제\d+조(?:의\d+)?(?:\s*제\d+항)?(?:\s*제\d+호)?)/g,
        `<span class="law-ref" onclick="window.highlightLaw('$1')">$1</span>`)
      .replace(/\n/g, "<br/>");
  };

  const send = async (text) => {
    const userText = text || input.trim();
    if (!userText || loading) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const newMessages = [...messages, { role: "user", content: userText }];
    setMessages(newMessages);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "오류 발생");

      const { explainText, panels } = parseResponse(data.text);
      const assistantMsg = { role: "assistant", content: explainText, rawContent: data.text };
      setMessages([...newMessages, assistantMsg]);

      if (panels.length > 0) setLawPanels(panels);

    } catch (e) {
      setMessages([...newMessages, { role: "assistant", content: `❌ ${e.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    window.highlightLaw = (ref) => {
      setActiveRef(ref);
      const refKey = ref.match(/제\d+조(?:의\d+)?/)?.[0];
      if (refKey) {
        const el = lawRefs.current[refKey];
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };
  }, []);

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
      setLawPanels([]);
      setActiveRef(null);
    }
  };

  return (
    <div style={s.root}>
      <header style={s.header}>
        <div style={s.headerLeft}>
          <div style={s.seal}>법</div>
          <div>
            <div style={s.headerTitle}>법령 AI 어시스턴트</div>
            <div style={s.headerSub}>국가법령정보 기반 · Korean Law MCP</div>
          </div>
        </div>
        <div style={s.headerRight}>
          <button onClick={resetChat} style={s.resetBtn} title="대화 초기화">⟳ 초기화</button>
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
                <p style={s.welcomeDesc}>법령 원문 조회부터 쉬운 해설까지<br/>국가법령정보센터 데이터를 기반으로 답변드립니다</p>
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

            {loading && (
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
            <div style={s.hint}>Enter 전송 · Shift+Enter 줄바꿈 · 답변의 <span style={{color:"#c0392b", fontWeight:600}}>조문번호</span> 클릭 시 원문 이동</div>
          </div>
        </div>

        <div style={s.rightPane}>
          <div style={s.rightHeader}>
            <span style={s.rightHeaderIcon}>📜</span>
            <span style={s.rightHeaderTitle}>법령 원문</span>
            {lawPanels.length > 0 && (
              <span style={s.rightHeaderBadge}>{lawPanels.reduce((a,p)=>a+p.articles.length,0)}개 조문</span>
            )}
          </div>

          <div style={s.lawContent}>
            {lawPanels.length === 0 ? (
              <div style={s.emptyLaw}>
                <div style={s.emptyIcon}>⚖️</div>
                <p style={s.emptyText}>질문하면 관련 법령 원문이<br/>여기에 표시됩니다</p>
                <p style={s.emptySubText}>답변의 조문번호를 클릭하면<br/>해당 위치로 이동합니다</p>
              </div>
            ) : (
              lawPanels.map((panel, pi) => (
                <div key={pi} style={s.lawPanel}>
                  <div style={s.lawPanelTitle}>{panel.title}</div>
                  {panel.articles.map((art, ai) => {
                    const isActive = activeRef && (art.no === activeRef.match(/제\d+조(?:의\d+)?/)?.[0]);
                    return (
                      <div
                        key={ai}
                        ref={el => lawRefs.current[art.no] = el}
                        style={{...s.article, ...(isActive ? s.articleActive : {})}}
                      >
                        <div style={s.articleNo}>{art.no} {art.title}</div>
                        <div style={s.articleContent}>{art.content.replace(/^제\d+조(?:의\d+)?[^\n]*\n?/, "").trim()}</div>
                      </div>
                    );
                  })}
                </div>
              ))
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
        .law-ref {
          color: #c0392b;
          font-weight: 600;
          cursor: pointer;
          border-bottom: 1px dashed #c0392b;
          padding: 0 1px;
        }
        .law-ref:hover { background: #fde8e8; border-radius: 2px; }
      `}</style>
    </div>
  );
}

const s = {
  root: { display:"flex", flexDirection:"column", height:"100vh", background:"#f5f0e8", fontFamily:"'Noto Sans KR',sans-serif" },
  header: { background:"#1a1208", color:"#f5f0e8", padding:"0 24px", height:52, display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, borderBottom:"3px solid #b8922a" },
  headerLeft: { display:"flex", alignItems:"center", gap:12 },
  headerRight: { display:"flex", alignItems:"center", gap:14 },
  seal: { width:34,height:34,background:"#c0392b",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Noto Serif KR',serif",fontSize:14,fontWeight:700,color:"white" },
  headerTitle: { fontFamily:"'Noto Serif KR',serif",fontSize:15,fontWeight:700,letterSpacing:1 },
  headerSub: { fontSize:11,color:"#aaa",fontWeight:300 },
  resetBtn: { background:"transparent",border:"1px solid #555",color:"#ccc",padding:"5px 10px",borderRadius:6,fontSize:11,cursor:"pointer",fontFamily:"'Noto Sans KR',sans-serif" },
  statusWrap: { display:"flex",alignItems:"center",gap:6 },
  dot: { width:8,height:8,borderRadius:"50%",transition:"background 0.3s" },
  statusText: { fontSize:11,color:"#aaa" },
  body: { display:"flex", flex:1, overflow:"hidden" },
  leftPane: { display:"flex",flexDirection:"column",flex:"0 0 50%",borderRight:"1px solid #d4c9b0",overflow:"hidden" },
  chatArea: { flex:1,overflowY:"auto",padding:"20px 16px",display:"flex",flexDirection:"column",gap:14 },
  welcome: { textAlign:"center",padding:"28px 16px" },
  welcomeIcon: { fontSize:36,marginBottom:10 },
  welcomeTitle: { fontFamily:"'Noto Serif KR',serif",fontSize:18,fontWeight:700,color:"#1a1208",marginBottom:6 },
  welcomeDesc: { fontSize:12,color:"#7a6e60",lineHeight:1.7,marginBottom:16 },
  examples: { display:"flex",flexDirection:"column",gap:7,maxWidth:400,margin:"0 auto" },
  exBtn: { background:"#fdfaf4",border:"1px solid #d4c9b0",borderRadius:8,padding:"9px 14px",fontSize:12,color:"#1a1208",cursor:"pointer",textAlign:"left",fontFamily:"'Noto Sans KR',sans-serif",lineHeight:1.5 },
  exLabel: { fontSize:10,fontWeight:700,color:"#b8922a",letterSpacing:0.5,display:"block",marginBottom:2 },
  msgRow: { display:"flex",gap:8,alignItems:"flex-start" },
  avatarAi: { width:30,height:30,background:"#1a1208",color:"#f5f0e8",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Noto Serif KR',serif",fontSize:11,fontWeight:700,flexShrink:0 },
  avatarUser: { width:30,height:30,background:"#b8922a",color:"white",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0 },
  bubbleAi: { maxWidth:"calc(100% - 60px)",padding:"10px 14px",borderRadius:"10px 10px 10px 3px",background:"#fdfaf4",border:"1px solid #d4c9b0",fontSize:13,lineHeight:1.8,color:"#1a1208" },
  bubbleUser: { maxWidth:"calc(100% - 60px)",padding:"10px 14px",borderRadius:"10px 10px 3px 10px",background:"#1a1208",color:"#f5f0e8",fontSize:13,lineHeight:1.8 },
  typing: { display:"flex",alignItems:"center",gap:4,padding:"10px 14px",background:"#fdfaf4",border:"1px solid #d4c9b0",borderRadius:"10px 10px 10px 3px" },
  typingDot: { width:6,height:6,background:"#7a6e60",borderRadius:"50%",display:"inline-block",animation:"blink 1.2s infinite" },
  inputArea: { padding:"10px 14px 14px",background:"#ede6d6",borderTop:"1px solid #d4c9b0",flexShrink:0 },
  inputRow: { display:"flex",gap:8,alignItems:"flex-end",background:"#fdfaf4",border:"1.5px solid #d4c9b0",borderRadius:10,padding:"7px 7px 7px 12px" },
  textarea: { flex:1,border:"none",outline:"none",background:"transparent",fontFamily:"'Noto Sans KR',sans-serif",fontSize:13,color:"#1a1208",resize:"none",maxHeight:120,minHeight:22,lineHeight:1.6 },
  sendBtn: { width:34,height:34,background:"#1a1208",border:"none",borderRadius:7,cursor:"pointer",color:"#f5f0e8",fontSize:13,flexShrink:0 },
  hint: { fontSize:10,color:"#7a6e60",marginTop:5,textAlign:"center" },
  rightPane: { display:"flex",flexDirection:"column",flex:"0 0 50%",overflow:"hidden",background:"#fdfaf4" },
  rightHeader: { display:"flex",alignItems:"center",gap:8,padding:"14px 18px",borderBottom:"1px solid #d4c9b0",background:"#f5f0e8",flexShrink:0 },
  rightHeaderIcon: { fontSize:16 },
  rightHeaderTitle: { fontFamily:"'Noto Serif KR',serif",fontSize:14,fontWeight:700,color:"#1a1208",flex:1 },
  rightHeaderBadge: { fontSize:11,background:"#c0392b",color:"white",padding:"2px 8px",borderRadius:10,fontWeight:500 },
  lawContent: { flex:1,overflowY:"auto",padding:"16px" },
  emptyLaw: { display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",padding:40,textAlign:"center" },
  emptyIcon: { fontSize:40,marginBottom:16,opacity:0.3 },
  emptyText: { fontSize:13,color:"#7a6e60",lineHeight:1.8,marginBottom:8 },
  emptySubText: { fontSize:11,color:"#aaa",lineHeight:1.7 },
  lawPanel: { marginBottom:20 },
  lawPanelTitle: { fontFamily:"'Noto Serif KR',serif",fontSize:13,fontWeight:700,padding:"8px 12px",background:"#1a1208",color:"#f5f0e8",borderRadius:"6px 6px 0 0",letterSpacing:0.5 },
  article: { padding:"12px 14px",borderLeft:"3px solid #d4c9b0",borderRight:"1px solid #e8e0d0",borderBottom:"1px solid #e8e0d0",background:"white",transition:"all 0.2s" },
  articleActive: { borderLeft:"3px solid #c0392b",background:"#fff8f8",boxShadow:"0 2px 8px rgba(192,57,43,0.1)" },
  articleNo: { fontSize:11,fontWeight:700,color:"#c0392b",marginBottom:6,letterSpacing:0.5 },
  articleContent: { fontSize:12,lineHeight:1.9,color:"#2c2416",whiteSpace:"pre-wrap" },
};
