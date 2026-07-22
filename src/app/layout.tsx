import type { Metadata } from "next";
import { Inter, Saira_Condensed } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const sairaCondensed = Saira_Condensed({
  subsets: ["latin"],
  weight: ["700"],
  variable: "--font-saira",
});

import { getLocalNode } from "@/lib/node/local-node";
import { buildNodeLinkMetadata, DEFAULT_NODE_DESCRIPTION } from "@/lib/node/metadata";

export async function generateMetadata(): Promise<Metadata> {
  let node = null;

  try {
    node = await getLocalNode();
  } catch (e) {
    console.error("Failed to fetch node info for metadata", e);
  }

  return {
    ...buildNodeLinkMetadata(
      node,
      process.env.NEXT_PUBLIC_NODE_NAME || "Synapsis",
      process.env.NEXT_PUBLIC_NODE_DESCRIPTION || DEFAULT_NODE_DESCRIPTION
    ),
    manifest: "/manifest.json",
    icons: {
      icon: "/api/favicon",
    },
    themeColor: "#0a0a0a",
    viewport: {
      width: "device-width",
      initialScale: 1,
      maximumScale: 5,
      userScalable: true,
      viewportFit: "cover",
    },
  };
}

// Force all routes to be dynamic (no static generation at build time)
// This is appropriate for a social network where all content is user-generated
export const dynamic = 'force-dynamic';

// This is appropriate for a social network where all content is user-generated

import { AuthProvider } from '@/lib/contexts/AuthContext';
import { ToastProvider } from '@/lib/contexts/ToastContext';
import { DialogProvider } from '@/lib/contexts/DialogContext';
import { AccentColorProvider } from '@/lib/contexts/AccentColorContext';
import { ConfigProvider } from '@/lib/contexts/ConfigContext';
import { ProfilePresentationProvider } from '@/lib/contexts/ProfilePresentationContext';
import { LayoutWrapper } from '@/components/LayoutWrapper';
import { isIPhoneUserAgent } from '@/lib/platform/ios-web-funnel';

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requestHeaders = await headers();
  const isIPhone = isIPhoneUserAgent(requestHeaders.get('user-agent'));

  return (
    <html lang="en" className={`${inter.variable} ${sairaCondensed.variable}`}>
      <body>
        <ConfigProvider>
          <AuthProvider>
            <ProfilePresentationProvider>
              <AccentColorProvider>
                <DialogProvider>
                  <ToastProvider>
                    <LayoutWrapper isIPhone={isIPhone}>
                      {children}
                    </LayoutWrapper>
                  </ToastProvider>
                </DialogProvider>
              </AccentColorProvider>
            </ProfilePresentationProvider>
          </AuthProvider>
        </ConfigProvider>
      </body>
    </html>
  );
}
