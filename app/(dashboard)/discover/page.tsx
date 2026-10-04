import { notFound } from 'next/navigation';
import { flag } from '@/lib/addons/flags';
import { DiscoverView } from '@/components/discover/DiscoverView';

export const metadata = { title: 'Discover · Do It Once' };
export const dynamic = 'force-dynamic';

export default function DiscoverPage() {
  if (!flag('ADDON_DISCOVER')) notFound();
  const base = (process.env.DEMO_SITE_URL ?? '').replace(/\/+$/, '');
  return <DiscoverView defaultStartUrl={base ? `${base}/store/orders` : ''} />;
}
