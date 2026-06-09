import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

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
        <nav style={{ display: "flex", gap: 16, paddingBottom: 12, borderBottom: "1px solid #ddd" }}>
          <a href="/">Home</a>
          <a href="/briefs">Briefs</a>
          <a href="/runs">Runs</a>
          <a href="/settings">Settings</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
