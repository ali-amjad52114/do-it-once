import { SkillDetailView } from '@/components/SkillDetailView';

export default async function SkillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SkillDetailView id={id} />;
}
