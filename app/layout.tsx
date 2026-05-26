import './globals.css';

export const metadata = {
  title: 'Manyworlds',
  description: '跨剧本 AI 队友——最小可跑骨架',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
