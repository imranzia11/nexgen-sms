import type { MetadataRoute } from "next";

// Next.js auto-serves this at /manifest.webmanifest and links it from
// every page automatically - no manual <link rel="manifest"> needed.
//
// start_url points at /login (not directly at /replies) because a visitor
// who isn't signed in yet still needs to authenticate first - the
// `next=/replies` query param is what tells the login page where to go
// once they're signed in, so opening the installed icon lands on login
// (if needed) and then goes straight into Replies, never the desktop
// dashboard. display: "standalone" is what removes the browser address
// bar and back button once installed - that's the actual "feels like an
// app" switch.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nexgen Replies",
    short_name: "Replies",
    description: "Check and respond to customer SMS replies",
    start_url: "/login?next=/replies",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#0f766e",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
