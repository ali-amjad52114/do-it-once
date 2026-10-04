import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Do It Once',
  description: 'Do it once. Your agent does it forever.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
