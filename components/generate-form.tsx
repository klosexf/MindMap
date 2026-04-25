'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { MindMapTree, NormalizedDocument } from '@/lib/types/mindmap';

type InputMode = 'text' | 'url' | 'pdf';

interface StreamEvent {
  type: string;
  data: any;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read file'));
        return;
      }

      const base64 = result.split(',')[1];
      if (!base64) {
        reject(new Error('Failed to encode file'));
        return;
      }

      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

async function* consumeSSEStream(response: Response): AsyncGenerator<StreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const messages = buffer.split('\n\n');
    buffer = messages.pop() || '';

    for (const message of messages) {
      const lines = message.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue;

      const type = eventLine.replace('event: ', '').trim();
      const raw = dataLine.replace('data: ', '').trim();
      try {
        yield { type, data: JSON.parse(raw) };
      } catch {
        // noop
      }
    }
  }
}

export function GenerateForm() {
  const router = useRouter();
  const [mode, setMode] = useState<InputMode>('text');
  const [textInput, setTextInput] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [status, setStatus] = useState('等待输入...');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit = useMemo(() => {
    if (loading) return false;
    if (mode === 'text') return textInput.trim().length > 0;
    if (mode === 'url') return /^https?:\/\//.test(urlInput.trim());
    return Boolean(pdfFile);
  }, [loading, mode, pdfFile, textInput, urlInput]);

  async function submitGenerate() {
    setError(null);
    setLoading(true);
    setStatus('正在解析输入内容...');

    try {
      let parsePayload: { type: InputMode | 'prompt'; content: string; fileName?: string };

      if (mode === 'text') {
        parsePayload = { type: 'text', content: textInput.trim() };
      } else if (mode === 'url') {
        parsePayload = { type: 'url', content: urlInput.trim() };
      } else {
        if (!pdfFile) throw new Error('请先选择 PDF 文件');
        if (pdfFile.size > 20 * 1024 * 1024) {
          throw new Error('文件过大，最大 20MB');
        }
        const base64 = await readFileAsBase64(pdfFile);
        parsePayload = {
          type: 'pdf',
          content: base64,
          fileName: pdfFile.name,
        };
      }

      const parseRes = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsePayload),
      });

      if (!parseRes.ok) {
        const body = await parseRes.json().catch(() => ({}));
        throw new Error(body.error || '输入解析失败');
      }

      const parseJson = (await parseRes.json()) as { normalizedDocument: NormalizedDocument };

      setStatus('开始流式生成导图骨架...');

      const generateRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ normalizedDocument: parseJson.normalizedDocument }),
      });

      if (!generateRes.ok) {
        const body = await generateRes.json().catch(() => ({}));
        throw new Error(body.error || '生成接口调用失败');
      }

      let finalTree: MindMapTree | null = null;

      for await (const event of consumeSSEStream(generateRes)) {
        if (event.type === 'skeleton') {
          setStatus('骨架已生成，正在补全节点...');
        }

        if (event.type === 'node') {
          setStatus('正在追加节点...');
        }

        if (event.type === 'error') {
          setError(event.data?.message || '生成阶段出现错误，已尝试降级');
        }

        if (event.type === 'complete') {
          finalTree = event.data?.tree as MindMapTree;
          setStatus('生成完成，正在跳转编辑器...');
        }
      }

      if (!finalTree) {
        throw new Error('未收到完整导图数据');
      }

      await fetch(`/api/mindmaps/${finalTree.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tree: finalTree }),
      });

      router.push(`/g/${finalTree.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
      setStatus('生成失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="generate-card">
      <h2 className="panel-title">输入内容并生成导图</h2>
      <div className="input-tabs" role="tablist" aria-label="输入类型">
        <button type="button" className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>
          文本
        </button>
        <button type="button" className={mode === 'url' ? 'active' : ''} onClick={() => setMode('url')}>
          URL
        </button>
        <button type="button" className={mode === 'pdf' ? 'active' : ''} onClick={() => setMode('pdf')}>
          PDF
        </button>
      </div>

      <div className="input-shell">
        {mode === 'text' && (
          <textarea
            className="text-input"
            placeholder="粘贴文章、会议记录或课程笔记，让 AI 自动生成导图..."
            value={textInput}
            onChange={(event) => setTextInput(event.target.value)}
            rows={7}
          />
        )}

        {mode === 'url' && (
          <input
            className="url-input"
            placeholder="https://example.com/article"
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
          />
        )}

        {mode === 'pdf' && (
          <label className="file-input-wrap">
            <input
              type="file"
              accept="application/pdf"
              onChange={(event) => setPdfFile(event.target.files?.[0] ?? null)}
            />
            <span>{pdfFile ? `已选择: ${pdfFile.name}` : '选择 PDF 文件（<=20MB）'}</span>
          </label>
        )}

        <div className="input-actions">
          <span className="input-hint">
            {mode === 'pdf' ? '支持扫描件，必要时自动 OCR' : '建议输入关键段落，生成更稳定'}
          </span>
          <button type="button" className="primary-button" onClick={submitGenerate} disabled={!canSubmit}>
            {loading ? '生成中...' : '开始生成'}
          </button>
        </div>
      </div>

      <p className="status-line">{status}</p>
      {error && <p className="error-line">{error}</p>}
    </section>
  );
}
