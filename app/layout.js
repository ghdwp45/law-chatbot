export const metadata = { title: "법령 AI 어시스턴트", description: "국가법령정보 기반 AI 챗봇" };
export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body style={{margin:0, padding:0}}>{children}</body>
    </html>
  );
}
