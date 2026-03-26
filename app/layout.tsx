import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexgen SMS Admin",
  description: "Nexgen SMS admin portal",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}