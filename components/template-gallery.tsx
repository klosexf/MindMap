'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import type { MindMapTree } from '@/lib/types/mindmap';
import { MINDMAP_TEMPLATES, buildTemplateTree } from '@/lib/templates';

export function TemplateGallery() {
  const router = useRouter();
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createFromTemplate(templateId: string) {
    if (creating) return;

    const tree = buildTemplateTree(templateId);
    if (!tree) {
      setError('模板不存在');
      return;
    }

    setCreating(templateId);
    setError(null);
    try {
      const saveRes = await fetch(`/api/mindmaps/${tree.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tree }),
      });
      if (!saveRes.ok) {
        const saveBody = await saveRes.json().catch(() => ({}));
        throw new Error(saveBody.error || '模板导图创建失败，请重试');
      }
      router.push(`/g/${tree.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '模板导图创建失败');
      setCreating(null);
    }
  }

  return (
    <section className="home-templates" aria-label="导图模板">
      <p className="examples-label">或从模板开始：</p>
      <div className="templates-grid">
        {MINDMAP_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            className="template-card"
            disabled={creating !== null}
            onClick={() => {
              void createFromTemplate(template.id);
            }}
          >
            <span className="template-card-name">{template.name}</span>
            <span className="template-card-desc">{template.description}</span>
            <span className="template-card-action" aria-hidden="true">
              {creating === template.id ? '创建中...' : '直接编辑 →'}
            </span>
          </button>
        ))}
      </div>
      {error ? <p className="template-error">{error}</p> : null}
    </section>
  );
}
