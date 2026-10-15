import type { Metadata, Viewport } from "next";
import { Cairo, Geist_Mono } from "next/font/google";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages } from "next-intl/server";
import { UiDirection } from "@/components/shell/ui-direction";
import { Toaster } from "@/components/ui/toast";
import { FORMATS } from "@/lib/i18n/formats";
import { routing } from "@/lib/i18n/routing";
import "../globals.css";

const cairo = Cairo({
  variable: "--font-sans",
  subsets: ["arabic", "latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KayEdu",
  description: "KayEdu — multi-tenant education center management",
};

// The mobile browser's chrome takes the canvas colour (--bg-canvas), so the
// page and the bar above it read as one surface (DES).
export const viewport: Viewport = { themeColor: "#f5f6f8", colorScheme: "light" };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function RootLayout({
  children,
  params,
}: LayoutProps<"/[locale]">) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  const messages = await getMessages();
  const dir = locale === "ar" ? "rtl" : "ltr";

  return (
    <html
      lang={locale}
      dir={dir}
      className={`${cairo.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider messages={messages} formats={FORMATS}>
          <UiDirection direction={dir}>
            {children}
            {/* One toast layer for every experience (docs/04 §14.2). */}
            <Toaster />
          </UiDirection>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
