import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UpSurge — AI Voice Agent Platform",
  description:
    "Multi-tenant orchestration for Retell AI voice agents across FollowUpBoss & HighLevel.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
