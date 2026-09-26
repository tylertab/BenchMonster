import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { AuthProvider } from "@/components/AuthProvider";
import { Header } from "@/components/Header";
import "./globals.css";

const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "BenchMonster",
  description: "Benchmark hosted and custom LLMs on your own data: accuracy, speed, and cost.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <AuthProvider>
          <Header />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
