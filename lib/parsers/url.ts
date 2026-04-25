import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { chunkMarkdown } from '@/lib/utils/chunk';
import { createSourceRefFallback } from '@/lib/utils/tree';
import type { NormalizedDocument } from '@/lib/types/mindmap';

function htmlToMarkdownFallback(title: string, content: string): string {
  return `# ${title}\n\n${content}`.replace(/\n{3,}/g, '\n\n').trim();
}

export async function parseUrlInput(url: string): Promise<NormalizedDocument> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'MindMap-MVP/0.1 (+local)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`URL fetch failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const title = article?.title?.trim() || dom.window.document.title || new URL(url).hostname;
  const plainText = (article?.textContent || dom.window.document.body?.textContent || '').replace(/\s+/g, ' ').trim();

  if (!plainText) {
    throw new Error('No readable content extracted from URL');
  }

  const markdown = htmlToMarkdownFallback(title, plainText);
  const sourceRef = createSourceRefFallback({
    type: 'url',
    url,
    location: 'body',
    text: plainText.slice(0, 240),
  });

  return {
    markdown,
    chunks: chunkMarkdown(markdown, sourceRef),
    sourceMeta: {
      type: 'url',
      title,
      sourceUrl: url,
    },
  };
}
