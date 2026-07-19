import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://missioncontrol.wallyweb.com"),
  title: { default: "Mission Control — Command your AI organization", template: "%s · Mission Control" },
  description:
    "Plan missions, coordinate AI agents, govern sensitive actions, and keep the evidence in one durable control plane.",
  openGraph: {
    title: "Mission Control",
    description: "The operating system for your AI organization.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
