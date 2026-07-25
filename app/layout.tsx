import type { Metadata, Viewport } from "next";
import "./globals.css";
import AnnouncementModal from "../components/AnnouncementModal";

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
    // "black-translucent" (not "default") lets the page's own content
    // render behind the iOS status bar instead of iOS drawing its own
    // opaque white bar above it - required for the mobile thread view's
    // dark green header to look like one continuous banner from the very
    // top of the screen, rather than a green bar sitting under a separate
    // white status-bar strip.
    statusBarStyle: "black-translucent",
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
  // Lets the page extend into the safe areas (notch, status bar, home
  // indicator) instead of iOS reserving that space itself - without this,
  // every env(safe-area-inset-*) used on the mobile thread view (top bar,
  // input bar) evaluates to 0, so the safe-area padding that code already
  // expects to be there silently never applies.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <AnnouncementModal />
      </body>
    </html>
  );
}