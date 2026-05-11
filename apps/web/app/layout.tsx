import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Short Video Media",
  description: "Short video style media frontend",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}