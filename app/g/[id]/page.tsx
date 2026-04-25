import { EditorPage } from '@/components/editor-page';

interface PageProps {
  params: { id: string };
}

export default function MindMapPage({ params }: PageProps) {
  return <EditorPage id={params.id} />;
}
