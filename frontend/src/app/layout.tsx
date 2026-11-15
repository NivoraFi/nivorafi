import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { WalletProvider } from "@/context/WalletProvider";
import { MarketProvider } from "@/context/MarketContext";
import { ToastProvider } from "@/context/ToastContext";
import { Toaster } from "@/components/ui/Toaster";
import { constructMetadata, SITE_CONFIG } from "@/lib/seo";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-code",
  display: "swap",
});

export const viewport: Viewport = {
  themeColor: "var(--bg-canvas)",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export const metadata: Metadata = {
  ...constructMetadata({ path: "/" }),
  title: {
    template: SITE_CONFIG.titleTemplate,
    default: SITE_CONFIG.defaultTitle,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: SITE_CONFIG.name,
        url: SITE_CONFIG.siteUrl,
        logo: `${SITE_CONFIG.siteUrl}/logo.png`,
        sameAs: [
          "https://github.com/NivoraFi/nivorafi",
          "https://x.com/NivoraFi",
        ],
      },
      {
        "@type": "WebApplication",
        name: SITE_CONFIG.name,
        url: SITE_CONFIG.siteUrl,
        description: SITE_CONFIG.defaultDescription,
        applicationCategory: "FinanceApplication",
        operatingSystem: "Web",
        sameAs: [
          "https://github.com/NivoraFi/nivorafi",
          "https://x.com/NivoraFi",
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "What is NivoraFi?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "NivoraFi is a non-custodial fixed-yield and yield tokenization AMM protocol built natively in Soroban Rust on Stellar. It splits yield-bearing assets such as Blend bUSDC and XLM into Principal Tokens (PT) and Yield Tokens (YT).",
            },
          },
          {
            "@type": "Question",
            name: "How do Principal Tokens (PT) and Yield Tokens (YT) work on Stellar?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Depositing a yield-bearing asset mints 1 PT and 1 YT per Standardized Yield (SY) unit. PT trades at a discount before maturity and redeems 1:1 for SY at maturity to lock in a fixed APY, while YT captures all variable lending yield until maturity.",
            },
          },
          {
            "@type": "Question",
            name: "How does NivoraFi trade YT without splitting pool liquidity?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "NivoraFi routes all PT and YT trades through one unified PT/SY time-decaying log-normal AMM pool using 2-step Picard iteration flash swaps, preserving deep liquidity.",
            },
          },
          {
            "@type": "Question",
            name: "What happens when a NivoraFi market reaches maturity?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "At maturity, PT is redeemable 1:1 for underlying SY, YT stops accruing new yield while accrued rewards remain claimable, and users can execute a 1-click atomic rollover into a new maturity pool.",
            },
          },
        ],
      },
    ],
  };

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${spaceGrotesk.variable} ${jetBrainsMono.variable} overflow-x-clip`}
    >
      <body
        suppressHydrationWarning
        className="min-h-screen bg-canvas font-sans text-ink antialiased overflow-x-clip"
      >
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        <WalletProvider>
          <MarketProvider>
            <ToastProvider>
              {children}
              <Toaster />
            </ToastProvider>
          </MarketProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
