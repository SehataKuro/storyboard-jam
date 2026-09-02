import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og-conte.png`;
  return {
    title: "CONTE LIVE — みんなで作る絵コンテ",
    description: "描く、聴く、合わせる。オンライン共同絵コンテ編集ツール。",
    openGraph: { title: "CONTE LIVE", description: "描く、聴く、合わせる。", images: [{ url: imageUrl, width: 1734, height: 907 }] },
    twitter: { card: "summary_large_image", title: "CONTE LIVE", description: "描く、聴く、合わせる。", images: [imageUrl] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
