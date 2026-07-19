import type { ReactNode } from 'react';

export const metadata = {
  title: 'Poslatr',
  description: 'Self-hosted social media manager',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
