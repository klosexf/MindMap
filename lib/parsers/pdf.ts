import path from 'node:path';

import { chunkMarkdown } from '@/lib/utils/chunk';
import { createSourceRefFallback } from '@/lib/utils/tree';
import type { NormalizedDocument } from '@/lib/types/mindmap';

const PDF_TEXT_MIN_LENGTH = 200;
const PDF_OCR_MIN_LENGTH = 30;
const PDF_RENDER_SCALE = 2;

interface PdfCanvasAndContext {
  canvas: {
    toBuffer?: (mimeType: string) => Buffer;
    encode?: (format: string) => Promise<Buffer | Uint8Array>;
  };
  context: unknown;
}

interface PdfCanvasFactory {
  create(width: number, height: number): PdfCanvasAndContext;
  destroy(canvasAndContext: PdfCanvasAndContext): void;
}

function pdfjsAssetDir(name: string): string {
  return `${path.join(process.cwd(), 'node_modules', 'pdfjs-dist', name)}${path.sep}`;
}

async function loadPdfDocument(buffer: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs.getDocument({
    data: buffer,
    cMapUrl: pdfjsAssetDir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfjsAssetDir('standard_fonts'),
    wasmUrl: pdfjsAssetDir('wasm'),
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;
}

async function extractPdfText(buffer: Uint8Array): Promise<{
  text: string;
  pages: number;
  pageTexts: Array<{ page: number; text: string }>;
}> {
  const pdf = await loadPdfDocument(buffer);
  const pageTexts: Array<{ page: number; text: string }> = [];

  try {
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => ('str' in item ? item.str ?? '' : ''))
        .join(' ')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (text) {
        pageTexts.push({ page: i, text });
      }
    }

    return {
      text: pageTexts.map(({ page, text }) => `## Page ${page}\n\n${text}`).join('\n\n'),
      pages: pdf.numPages,
      pageTexts,
    };
  } finally {
    await pdf.destroy();
  }
}

async function renderPdfPageToPng(buffer: Uint8Array, pageNumber = 1): Promise<Buffer> {
  const pdf = await loadPdfDocument(buffer);

  try {
    const safePageNumber = Math.max(1, Math.min(pageNumber, pdf.numPages));
    const page = await pdf.getPage(safePageNumber);
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
    const canvasFactory = pdf.canvasFactory as PdfCanvasFactory;
    const canvasAndContext = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));

    try {
      await page.render({
        canvas: canvasAndContext.canvas,
        canvasContext: canvasAndContext.context,
        viewport,
      } as Parameters<typeof page.render>[0]).promise;

      const canvas = canvasAndContext.canvas;

      if (typeof canvas.toBuffer === 'function') {
        return canvas.toBuffer('image/png');
      }

      if (typeof canvas.encode === 'function') {
        return Buffer.from(await canvas.encode('png'));
      }

      throw new Error('PDF canvas cannot be encoded as PNG');
    } finally {
      canvasFactory.destroy(canvasAndContext);
    }
  } finally {
    await pdf.destroy();
  }
}

async function ocrPdfFirstPage(buffer: Uint8Array): Promise<string> {
  try {
    const pageImage = await renderPdfPageToPng(buffer);
    const Tesseract = await import('tesseract.js');
    const worker = await Tesseract.createWorker('eng+chi_sim');

    try {
      const result = await worker.recognize(pageImage);
      return result.data.text?.replace(/\s+/g, ' ').trim() ?? '';
    } finally {
      await worker.terminate();
    }
  } catch {
    return '';
  }
}

export async function parsePdfInput(base64Data: string, fileName = 'document.pdf'): Promise<NormalizedDocument> {
  const raw = Buffer.from(base64Data, 'base64');
  let extracted = '';
  let pageTexts: Array<{ page: number; text: string; heading?: string }> = [];

  try {
    const { text, pageTexts: extractedPageTexts } = await extractPdfText(new Uint8Array(raw));
    extracted = text;
    pageTexts = extractedPageTexts;
  } catch {
    extracted = '';
  }

  let mergedText = extracted;
  let ocrUsed = false;
  const allowOCR = process.env.ENABLE_PDF_OCR !== 'false';

  if (allowOCR && mergedText.length < PDF_TEXT_MIN_LENGTH) {
    const ocrText = await ocrPdfFirstPage(new Uint8Array(raw));
    if (ocrText.length > PDF_OCR_MIN_LENGTH) {
      ocrUsed = true;
      mergedText = `## OCR Extracted\n\n${ocrText}`;
      pageTexts = [{ page: 1, heading: 'OCR Extracted', text: ocrText }];
    }
  }

  if (!mergedText) {
    mergedText = '该 PDF 未能提取到可读文本，已生成占位内容。建议上传可复制文本的 PDF 以获得更好结果。';
    pageTexts = [{ page: 1, heading: 'PDF Notice', text: mergedText }];
  }

  const markdown = `# ${fileName}\n\n${mergedText}`;
  const sourceRef = createSourceRefFallback({
    type: 'pdf',
    page: 1,
    location: 'page:1',
    text: mergedText.slice(0, 240),
  });
  const chunks = pageTexts.flatMap(({ page, heading, text }) => {
    const pageSourceRef = createSourceRefFallback({
      type: 'pdf',
      page,
      location: `page:${page}`,
      text: text.slice(0, 240),
    });
    return chunkMarkdown(`# ${fileName}\n\n## ${heading || `Page ${page}`}\n\n${text}`, pageSourceRef);
  });

  return {
    markdown,
    chunks: chunks.length > 0 ? chunks : chunkMarkdown(markdown, sourceRef),
    sourceMeta: {
      type: 'pdf',
      title: fileName.replace(/\.pdf$/i, ''),
      sourceFileName: fileName,
      ocrUsed,
    },
  };
}

export function encodeFileToBase64(fileBuffer: ArrayBuffer): string {
  return Buffer.from(fileBuffer).toString('base64');
}

export function getPdfStats(doc: NormalizedDocument): { pagesHint: number } {
  const matches = doc.markdown.match(/## Page /g);
  return { pagesHint: matches?.length ?? 1 };
}
