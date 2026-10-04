import type { Metadata } from 'next';
import { ChatPage } from '@/components/assistant-ui/ChatPage';

export const metadata: Metadata = { title: 'Chat · Do It Once' };

export default function Page() {
  return <ChatPage />;
}
