export const metadata = { title: "법령 AI 어시스턴트", description: "국가법령정보 기반 AI 챗봇" };
// 모바일 뷰포트 명시: 기기 폭에 맞춰 렌더(초기 배율 1). 확대는 접근성 위해 허용.
export const viewport = { width: "device-width", initialScale: 1 };
export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body style={{margin:0, padding:0}}>{children}</body>
    </html>
  );
}
