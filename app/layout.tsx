import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexgen SMS Admin",
  description: "Nexgen SMS admin portal",
  // iOS Safari ignores most of the web manifest (app/manifest.ts) and
  // needs its own meta tags to get the same "installed app" effect -
  // full-screen, no address bar, its own icon - when added to the home
  // screen. appleWebApp.capable is what actually turns standalone mode on
  // for iOS; icons.apple points at a plain (non-transparent, non-rounded -
  // iOS applies its own mask) PNG, which manifest icons don't cover.
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Nexgen Replies",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
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