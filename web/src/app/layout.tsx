import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Listing Reel Studio",
  description:
    "Listing photos in, three vertical property reels out. Canvas preview in the browser, ffmpeg export on Railway.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-neutral-950">{children}</body>
    </html>
  );
}
