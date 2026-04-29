'use client';

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';

import type { MindMapTree, NormalizedDocument } from '@/lib/types/mindmap';
import { buildTimingLines, type GenerationTimingMarks } from '@/lib/utils/generation-timing';

type InputMode = 'text' | 'url' | 'pdf';
const MODE_TABS: Array<{ mode: InputMode; label: string }> = [
  { mode: 'text', label: '文本' },
  { mode: 'url', label: 'URL' },
  { mode: 'pdf', label: 'PDF' },
];

interface StreamEvent {
  type: string;
  data: any;
}

interface MarkdownDebugPayload {
  title: string;
  markdown: string;
  proof?: {
    source?: string;
    provider?: string;
    model?: string;
  };
}

interface MindMapJsonDebugPayload {
  json: unknown;
  parsedJson?: string;
  rawText?: string;
  proof?: {
    source?: string;
    provider?: string;
    model?: string;
  };
}

interface OcrPreviewPayload {
  ocrUsed: boolean;
  parseWarning?: string;
  ocrDebug?: NonNullable<NormalizedDocument['sourceMeta']['ocrDebug']>;
  acceptedText: string;
  rejectedSummary: string;
}

type DebugMode = 'none' | 'markdown' | 'mindmapJson' | 'ocrPreview';

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
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugMode, setDebugMode] = useState<DebugMode>('none');
  const [markdownDebugResult, setMarkdownDebugResult] = useState<MarkdownDebugPayload | null>(null);
  const [mindMapJsonDebugResult, setMindMapJsonDebugResult] = useState<MindMapJsonDebugPayload | null>(null);
  const [ocrPreviewResult, setOcrPreviewResult] = useState<OcrPreviewPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [timingMarks, setTimingMarks] = useState<GenerationTimingMarks>({});
  const [timingNow, setTimingNow] = useState(Date.now());

  function switchMode(nextMode: InputMode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setWarning(null);
    setError(null);
    if (!loading) {
      setStatus('等待输入...');
    }
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
      return;
    }
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (index + delta + MODE_TABS.length) % MODE_TABS.length;
    switchMode(MODE_TABS[nextIndex].mode);
  }

  const urlValidation = useMemo(() => {
    if (mode !== 'url') return { valid: true, hint: null as string | null };
    const trimmed = urlInput.trim();
    if (!trimmed) return { valid: false, hint: null };
    if (!/^https?:\/\//.test(trimmed)) {
      return { valid: false, hint: '链接必须以 http:// 或 https:// 开头' };
    }
    try {
      const urlObj = new URL(trimmed);
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        return { valid: false, hint: '仅支持 HTTP/HTTPS 链接' };
      }
      if (!urlObj.hostname.includes('.')) {
        return { valid: false, hint: '请输入有效的域名' };
      }
      // 对已知反爬/拦截平台给出前置提示
      const hostname = urlObj.hostname;
      if (hostname.includes('mp.weixin.qq.com')) {
        return { valid: true, hint: '提示：微信公众号文章可能无法直接抓取，如遇失败请复制文章内容到「文本」模式' };
      }
      if (hostname.includes('zhihu.com')) {
        return { valid: true, hint: '提示：知乎文章可能无法直接抓取，如遇失败请复制文章内容到「文本」模式' };
      }
      if (hostname.includes('jianshu.com')) {
        return { valid: true, hint: '提示：简书文章可能无法直接抓取，如遇失败请复制文章内容到「文本」模式' };
      }
      return { valid: true, hint: null };
    } catch {
      return { valid: false, hint: '链接格式不正确' };
    }
  }, [mode, urlInput]);

  const canSubmit = useMemo(() => {
    if (loading) return false;
    if (debugMode === 'ocrPreview' && mode !== 'pdf') return false;
    if (mode === 'text') return textInput.trim().length > 0;
    if (mode === 'url') return urlValidation.valid && /^https?:\/\//.test(urlInput.trim());
    return Boolean(pdfFile);
  }, [debugMode, loading, mode, pdfFile, textInput, urlInput, urlValidation.valid]);

  const timingLines = useMemo(() => {
    if (!timingMarks.startedAt) return [];
    const now = loading ? timingNow : timingMarks.completedAt ?? timingNow;
    return buildTimingLines(timingMarks, now);
  }, [loading, timingMarks, timingNow]);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => setTimingNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [loading]);

  async function submitGenerate() {
    const startedAt = Date.now();
    setTimingNow(startedAt);
    setTimingMarks({ startedAt, parseStartedAt: startedAt });
    setWarning(null);
    setError(null);
    setMarkdownDebugResult(null);
    setMindMapJsonDebugResult(null);
    setOcrPreviewResult(null);
    setLoading(true);
    setStatus('正在解析输入内容...');

    try {
      let parsePayload: {
        type: InputMode | 'prompt';
        content: string;
        fileName?: string;
        pdfOptions?: {
          forceOcr?: boolean;
          forceOcrMaxPages?: number;
        };
      };

      if (mode === 'text') {
        parsePayload = { type: 'text', content: textInput.trim() };
      } else if (mode === 'url') {
        parsePayload = { type: 'url', content: urlInput.trim() };
      } else {
        if (!pdfFile) throw new Error('请先选择 PDF 文件');
        if (pdfFile.size > 20 * 1024 * 1024) {
          throw new Error('文件过大，最大 20MB');
        }
        setStatus('正在读取 PDF 文件...');
        const base64 = await readFileAsBase64(pdfFile);
        setStatus('正在解析输入内容...');
        parsePayload = {
          type: 'pdf',
          content: base64,
          fileName: pdfFile.name,
          pdfOptions: debugMode === 'ocrPreview' ? { forceOcr: true } : undefined,
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
      if (parseJson.normalizedDocument.sourceMeta.parseWarning) {
        setWarning(parseJson.normalizedDocument.sourceMeta.parseWarning);
      }

      if (debugMode === 'ocrPreview') {
        if (parseJson.normalizedDocument.sourceMeta.type !== 'pdf') {
          throw new Error('OCR 文本预览仅支持 PDF 输入');
        }
        const ocrDebug = parseJson.normalizedDocument.sourceMeta.ocrDebug;
        const acceptedPages = (ocrDebug?.pages || []).filter((item) => item.accepted && item.cleanedText.trim().length > 0);
        const rejectedPages = (ocrDebug?.pages || []).filter((item) => !item.accepted);
        const acceptedText = acceptedPages.length > 0
          ? acceptedPages
              .map((item) => `## OCR Page ${item.page}\n\n${item.cleanedText}`)
              .join('\n\n')
          : '未采集到可用 OCR 文本（可能为空、过短，或已被判定为乱码）。';
        const rejectedSummary = rejectedPages.length > 0
          ? rejectedPages
              .map((item) => `page_${item.page}: ${item.reason || 'unknown_reason'}`)
              .join('\n')
          : '';

        setOcrPreviewResult({
          ocrUsed: parseJson.normalizedDocument.sourceMeta.ocrUsed ?? false,
          parseWarning: parseJson.normalizedDocument.sourceMeta.parseWarning,
          ocrDebug,
          acceptedText,
          rejectedSummary,
        });
        setTimingMarks((prev) => ({ ...prev, completedAt: Date.now() }));
        setStatus('PDF OCR 预览完成（测试模式）');
        return;
      }

      const streamStartedAt = Date.now();
      setTimingMarks((prev) => ({
        ...prev,
        parseFinishedAt: streamStartedAt,
        streamStartedAt,
      }));
      setTimingNow(streamStartedAt);

      if (debugMode === 'markdown') {
        setStatus('正在请求 AI 生成 Markdown 解析...');
        const markdownRes = await fetch('/api/generate/markdown', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ normalizedDocument: parseJson.normalizedDocument }),
        });

        const markdownJson = (await markdownRes.json().catch(() => ({}))) as MarkdownDebugPayload & { error?: string };
        if (!markdownRes.ok) {
          throw new Error(markdownJson.error || 'Markdown 解析生成失败');
        }

        setMarkdownDebugResult(markdownJson);
        setTimingMarks((prev) => ({ ...prev, completedAt: Date.now() }));
        setStatus('Markdown 解析完成（测试模式）');
        return;
      }

      if (debugMode === 'mindmapJson') {
        setStatus('正在请求 AI 生成导图 JSON...');
        const jsonRes = await fetch('/api/generate/mindmap-json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ normalizedDocument: parseJson.normalizedDocument }),
        });

        const jsonPayload = (await jsonRes.json().catch(() => ({}))) as MindMapJsonDebugPayload & { error?: string };
        if (!jsonRes.ok) {
          throw new Error(jsonPayload.error || '导图 JSON 生成失败');
        }

        setMindMapJsonDebugResult(jsonPayload);
        setTimingMarks((prev) => ({ ...prev, completedAt: Date.now() }));
        setStatus('导图 JSON 生成完成（测试模式）');
        return;
      }

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
      let firstEventSeen = false;

      for await (const event of consumeSSEStream(generateRes)) {
        const now = Date.now();
        setTimingNow(now);

        if (!firstEventSeen) {
          firstEventSeen = true;
          setTimingMarks((prev) => ({ ...prev, firstEventAt: prev.firstEventAt ?? now }));
        }

        if (event.type === 'warning') {
          setWarning(event.data?.message || '生成首包等待较久，系统仍在处理中，请稍候。');
        }

        if (event.type === 'skeleton') {
          setTimingMarks((prev) => ({ ...prev, skeletonAt: prev.skeletonAt ?? now }));
          setWarning(null);
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
          setTimingMarks((prev) => ({ ...prev, completedAt: now }));
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
      setTimingMarks((prev) => ({ ...prev, completedAt: prev.completedAt ?? Date.now() }));
    } finally {
      setLoading(false);
      setTimingNow(Date.now());
    }
  }

  return (
    <section className="generate-card">
      <h2 className="panel-title">输入内容并生成导图</h2>
      <div className="input-tabs" role="tablist" aria-label="输入类型">
        {MODE_TABS.map((tab, index) => (
          <button
            key={tab.mode}
            id={`tab-${tab.mode}`}
            role="tab"
            aria-selected={mode === tab.mode}
            aria-controls={`panel-${tab.mode}`}
            type="button"
            className={mode === tab.mode ? 'active' : ''}
            onClick={() => switchMode(tab.mode)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="input-shell" id={`panel-${mode}`} role="tabpanel" aria-labelledby={`tab-${mode}`}>
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
          <div className="url-input-wrap">
            <input
              className="url-input"
              placeholder="https://example.com/article"
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              aria-invalid={urlValidation.hint?.startsWith('链接') || urlValidation.hint?.startsWith('仅支持') || urlValidation.hint?.startsWith('请输入')}
              aria-describedby="url-hint"
            />
            {urlValidation.hint && (
              <p id="url-hint" className={urlValidation.hint.startsWith('提示') ? 'url-hint-info' : 'url-hint-error'}>
                {urlValidation.hint}
              </p>
            )}
          </div>
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
          <div className="input-action-left">
            <span className="input-hint">
              {mode === 'pdf' ? '支持扫描件，必要时自动 OCR' : '建议输入关键段落，生成更稳定'}
            </span>
            <label className="debug-toggle">
              <input
                type="checkbox"
                checked={debugMode === 'markdown'}
                onChange={() => setDebugMode((prev) => (prev === 'markdown' ? 'none' : 'markdown'))}
              />
              <span>测试模式：仅生成 Markdown 解析（不跳转导图）</span>
            </label>
            <label className="debug-toggle">
              <input
                type="checkbox"
                checked={debugMode === 'mindmapJson'}
                onChange={() => setDebugMode((prev) => (prev === 'mindmapJson' ? 'none' : 'mindmapJson'))}
              />
              <span>测试模式：仅生成思维导图 JSON（不跳转导图）</span>
            </label>
            <label className="debug-toggle">
              <input
                type="checkbox"
                checked={debugMode === 'ocrPreview'}
                onChange={() => setDebugMode((prev) => (prev === 'ocrPreview' ? 'none' : 'ocrPreview'))}
              />
              <span>测试模式：仅查看 PDF OCR 导出文本（不跳转导图）</span>
            </label>
          </div>
          <button type="button" className="primary-button" onClick={submitGenerate} disabled={!canSubmit}>
            {loading ? '生成中...' : '开始生成'}
          </button>
        </div>
      </div>

      <p className="status-line">{status}</p>
      {timingLines.length > 0 && (
        <ul className="timing-lines">
          {timingLines.map((line) => (
            <li key={line} className="timing-line-item">
              {line}
            </li>
          ))}
        </ul>
      )}
      {markdownDebugResult && (
        <div className="markdown-debug-box">
          <p className="markdown-debug-meta">
            结果来源：{markdownDebugResult.proof?.source || 'unknown'} /{' '}
            {markdownDebugResult.proof?.provider || 'unknown'} / {markdownDebugResult.proof?.model || 'unknown'}
          </p>
          <pre className="markdown-debug-content">{markdownDebugResult.markdown}</pre>
        </div>
      )}
      {mindMapJsonDebugResult && (
        <div className="markdown-debug-box">
          <p className="markdown-debug-meta">
            结果来源：{mindMapJsonDebugResult.proof?.source || 'unknown'} /{' '}
            {mindMapJsonDebugResult.proof?.provider || 'unknown'} / {mindMapJsonDebugResult.proof?.model || 'unknown'}
          </p>
          <pre className="markdown-debug-content">
            {JSON.stringify(mindMapJsonDebugResult.json ?? {}, null, 2)}
          </pre>
        </div>
      )}
      {ocrPreviewResult && (
        <div className="markdown-debug-box">
          <p className="markdown-debug-meta">
            OCR 启用：{ocrPreviewResult.ocrDebug?.enabled ? '是' : '否'} / OCR 实际执行：
            {ocrPreviewResult.ocrDebug?.attempted ? '是' : '否'} / 采集有效页数：
            {ocrPreviewResult.ocrDebug?.acceptedPages ?? 0} / 尝试页数：
            {ocrPreviewResult.ocrDebug?.attemptedPages ?? 0} / 最终采用 OCR：
            {ocrPreviewResult.ocrUsed ? '是' : '否'} / 引擎：
            {ocrPreviewResult.ocrDebug?.provider || 'unknown'} / 模型：
            {ocrPreviewResult.ocrDebug?.model || 'unknown'}
          </p>
          {ocrPreviewResult.rejectedSummary && (
            <pre className="markdown-debug-content">{ocrPreviewResult.rejectedSummary}</pre>
          )}
          <pre className="markdown-debug-content">{ocrPreviewResult.acceptedText}</pre>
          {ocrPreviewResult.parseWarning && (
            <p className="markdown-debug-meta">解析警告：{ocrPreviewResult.parseWarning}</p>
          )}
        </div>
      )}
      {warning && <p className="warning-line">{warning}</p>}
      {error && <p className="error-line">{error}</p>}
    </section>
  );
}
