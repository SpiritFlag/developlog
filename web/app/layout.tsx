import type { Metadata } from "next";
import "./theme.css";
import { ClerkProvider } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Developlog — 디벨롭로그",
  description: "프로젝트가 지금 무엇이고, 왜 이렇게 되었는지. 주제로 읽고 AI와 이어가는 프로젝트의 현재.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
