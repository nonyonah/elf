import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata = {
  title: "Elf Settings",
  icons: {icon:"/brand/elf-mascot.png"},
  description: "Configure Slack notifications and drift preferences",
};

const themeScript = `
(function () {
  try {
    var media = window.matchMedia("(prefers-color-scheme: dark)");
    var apply = function () {
      document.documentElement.classList.toggle("dark", media.matches);
    };
    apply();
    if (media.addEventListener) media.addEventListener("change", apply);
    else if (media.addListener) media.addListener(apply);
  } catch (error) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        <Script id="elf-theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
        {children}
      </body>
    </html>
  );
}
