import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexgen SMS Admin",
  description: "Nexgen SMS admin portal",
};

// Without this, mobile browsers render the page at a fixed desktop-width
// viewport (~980px) and shrink it to fit the screen — everything looks
// tiny and blurry until the user manually pinches to zoom in. This makes
// the page render at its real, legible size by default on every device.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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