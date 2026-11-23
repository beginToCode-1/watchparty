import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'WatchParty — watch together, in sync',
  description: 'Create a room, share the code, and watch videos, streams and YouTube together with chat and calls.',
};

export const viewport: Viewport = { themeColor: '#07070a', colorScheme: 'dark' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the request headers makes every page render per request, which the CSP nonce requires.
  await headers();
  return (
    <html lang="en">
      <body>
        <header className="material sticky top-0 z-40 border-x-0 border-t-0">
          <div className="mx-auto flex h-14 max-w-[1600px] items-center px-4 sm:px-6">
            <Link href="/" className="pressable flex items-center gap-2 rounded-lg text-[17px] font-semibold tracking-title">
              <span aria-hidden className="grid h-7 w-7 place-items-center rounded-lg bg-screen text-sm text-ink-950">
                ▶
              </span>
              WatchParty
            </Link>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
