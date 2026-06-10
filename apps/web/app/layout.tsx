import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Nav from "./nav";

export const metadata: Metadata = {
  title: "Mission Control",
  description: "Proactive chief-of-staff engine",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#111827",
};

// Function over form (brief §2.4): system font, one nav, no styling framework.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "0 auto", maxWidth: 720, padding: 16 }}>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
