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
  const chatRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, loading]);

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
      setMessages([...newMessages, { role: "assistant", content: data.text }]);
    } catch (e) {
      setMessages([...newMessages, { role: "assistant", content: `❌ ${e.message}` }]);
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

  const formatText = (text) => {
    return text
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br/>");
  };

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.seal}>법</div>
          <div>
            <div style={styles.headerTitle}>법령 AI 어시스턴트</div>
            <div style={styles.headerSub}>국가법령정보 기반 · Korean Law MCP</div>
          </div>
        </div>
        <div style={styles.statusWrap}>
          <div style={{...styles.dot, background: loading ? "#f39c12" : "#2ecc71"}} />
          <span style={styles.statusText}>{loading ? "조회 중..." : "연결됨"}</span>
        </div>
      </header>

      <div style={styles.chatArea} ref={chatRef}>
        {messages.length === 0 && (
          <div style={styles.welcome}>
            <div style={styles.welcomeIcon}>⚖️</div>
            <h2 style={styles.welcomeTitle}>한국 법령 AI 어시스턴트</h2>
            <p style={styles.welcomeDesc}>법령 원문 조회부터 쉬운 해설까지<br/>국가법령정보센터 데이터를 기반으로 답변드립니다</p>
            <div style={styles.examples}>
              {EXAMPLES.map((ex) => (
                <button key={ex.q} style={styles.exBtn} onClick={() => send(ex.q)}>
                  <span style={styles.exLabel}>{ex.label}</span>
                  {ex.q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{...styles.msgRow, justifyContent: m.role === "user" ? "flex-end" : "flex-start"}}>
            {m.role === "assistant" && <div style={styles.avatarAi}>법</div>}
            <div style={m.role === "user" ? styles.bubbleUser : styles.bubbleAi}
              dangerouslySetInnerHTML={{ __html: formatText(m.content) }} />
            {m.role === "user" && <div style={styles.avatarUser}>나</div>}
          </div>
        ))}

        {loading && (
          <div style={{...styles.msgRow, justifyContent: "flex-start"}}>
            <div style={styles.avatarAi}>법</div>
            <div style={styles.typing}>
              {[0,1,2].map(i => <span key={i} style={{...styles.typingDot, animationDelay: `${i*0.2}s`}} />)}
            </div>
          </div>
        )}
      </div>

      <div style={styles.inputArea}>
        <div style={styles.inputRow}>
          <textarea
            ref={textareaRef}
            style={styles.textarea}
            value={input}
            onChange={(e) => { setInput(e.target.value); autoResize(e); }}
            onKeyDown={handleKey}
            placeholder="법령명, 조문번호, 또는 궁금한 내용을 입력하세요..."
            rows={1}
          />
          <button style={{...styles.sendBtn, opacity: loading ? 0.4 : 1}} onClick={() => send()} disabled={loading}>
            ▶
          </button>
        </div>
        <div style={styles.hint}>Enter로 전송 · Shift+Enter 줄바꿈 · 법률 전문가 검토를 권장합니다</div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@700&family=Noto+Sans+KR:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Noto Sans KR', sans-serif; }
        @keyframes blink { 0%,60%,100%{transform:translateY(0);opacity:.4} 30%{transform:translateY(-5px);opacity:1} }
      `}</style>
    </div>
  );
}

const styles = {
  root: { display:"flex", flexDirection:"column", height:"100vh", background:"#f5f0e8", fontFamily:"'Noto Sans KR', sans-serif" },
  header: { background:"#1a1208", color:"#f5f0e8", padding:"0 24px", height:56, display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, borderBottom:"3px solid #b8922a" },
  headerLeft: { display:"flex", alignItems:"center", gap:12 },
  seal: { width:36, height:36, background:"#c0392b", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Noto Serif KR', serif", fontSize:14, fontWeight:700, color:"white" },
  headerTitle: { fontFamily:"'Noto Serif KR', serif", fontSize:15, fontWeight:700, letterSpacing:1 },
  headerSub: { fontSize:11, color:"#aaa", fontWeight:300 },
  statusWrap: { display:"flex", alignItems:"center", gap:6 },
  dot: { width:8, height:8, borderRadius:"50%", transition:"background 0.3s" },
  statusText: { fontSize:11, color:"#aaa" },
  chatArea: { flex:1, overflowY:"auto", padding:"24px 20px", display:"flex", flexDirection:"column", gap:16 },
  welcome: { textAlign:"center", padding:"32px 20px" },
  welcomeIcon: { fontSize:40, marginBottom:12 },
  welcomeTitle: { fontFamily:"'Noto Serif KR', serif", fontSize:20, fontWeight:700, color:"#1a1208", marginBottom:8 },
  welcomeDesc: { fontSize:13, color:"#7a6e60", lineHeight:1.7, marginBottom:20 },
  examples: { display:"flex", flexDirection:"column", gap:8, maxWidth:460, margin:"0 auto" },
  exBtn: { background:"#fdfaf4", border:"1px solid #d4c9b0", borderRadius:8, padding:"10px 16px", fontSize:12, color:"#1a1208", cursor:"pointer", textAlign:"left", fontFamily:"'Noto Sans KR', sans-serif", lineHeight:1.5 },
  exLabel: { fontSize:10, fontWeight:700, color:"#b8922a", letterSpacing:0.5, display:"block", marginBottom:2 },
  msgRow: { display:"flex", gap:10, alignItems:"flex-start" },
  avatarAi: { width:32, height:32, background:"#1a1208", color:"#f5f0e8", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Noto Serif KR', serif", fontSize:12, fontWeight:700, flexShrink:0 },
  avatarUser: { width:32, height:32, background:"#b8922a", color:"white", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700, flexShrink:0 },
  bubbleAi: { maxWidth:"calc(100% - 80px)", padding:"12px 16px", borderRadius:"12px 12px 12px 4px", background:"#fdfaf4", border:"1px solid #d4c9b0", fontSize:13, lineHeight:1.8, color:"#1a1208" },
  bubbleUser: { maxWidth:"calc(100% - 80px)", padding:"12px 16px", borderRadius:"12px 12px 4px 12px", background:"#1a1208", color:"#f5f0e8", fontSize:13, lineHeight:1.8 },
  typing: { display:"flex", alignItems:"center", gap:4, padding:"12px 16px", background:"#fdfaf4", border:"1px solid #d4c9b0", borderRadius:"12px 12px 12px 4px" },
  typingDot: { width:6, height:6, background:"#7a6e60", borderRadius:"50%", display:"inline-block", animation:"blink 1.2s infinite" },
  inputArea: { padding:"12px 16px 16px", background:"#ede6d6", borderTop:"1px solid #d4c9b0", flexShrink:0 },
  inputRow: { display:"flex", gap:8, alignItems:"flex-end", background:"#fdfaf4", border:"1.5px solid #d4c9b0", borderRadius:12, padding:"8px 8px 8px 14px" },
  textarea: { flex:1, border:"none", outline:"none", background:"transparent", fontFamily:"'Noto Sans KR', sans-serif", fontSize:13, color:"#1a1208", resize:"none", maxHeight:120, minHeight:22, lineHeight:1.6 },
  sendBtn: { width:36, height:36, background:"#1a1208", border:"none", borderRadius:8, cursor:"pointer", color:"#f5f0e8", fontSize:14, flexShrink:0 },
  hint: { fontSize:10, color:"#7a6e60", marginTop:6, textAlign:"center" },
};
