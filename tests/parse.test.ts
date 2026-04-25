import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseInput } from '../lib/parsers';

const tesseractMocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  recognize: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock('tesseract.js', () => ({
  createWorker: tesseractMocks.createWorker,
}));

function createSimplePdfBase64(content = 'Hello PDF Parser '.repeat(20)): string {
  const stream = content ? `BT\n/F1 12 Tf\n72 720 Td\n(${content}) Tj\nET` : '';

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];

  objects.forEach((obj, idx) => {
    offsets.push(pdf.length);
    pdf += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'utf8').toString('base64');
}

afterEach(() => {
  delete process.env.ENABLE_PDF_OCR;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parseInput', () => {
  it('parses text input to normalized document', async () => {
    const doc = await parseInput({ type: 'text', content: 'Alpha\n\nBeta\n\nGamma' });
    expect(doc.sourceMeta.type).toBe('text');
    expect(doc.chunks.length).toBeGreaterThan(0);
    expect(doc.markdown).toContain('Alpha');
  });

  it('parses url input with readability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '<html><head><title>Demo</title></head><body><article><h1>News</h1><p>Important content</p></article></body></html>',
      }),
    );

    const doc = await parseInput({ type: 'url', content: 'https://example.com/news' });
    expect(doc.sourceMeta.type).toBe('url');
    expect(doc.markdown).toContain('Important content');
  });

  it('parses pdf input to normalized document', async () => {
    const base64 = createSimplePdfBase64();
    const doc = await parseInput({ type: 'pdf', content: base64, fileName: 'demo.pdf' });
    expect(doc.sourceMeta.type).toBe('pdf');
    expect(doc.markdown).toContain('Hello PDF Parser');
    expect(doc.chunks.length).toBeGreaterThan(0);
  });

  it('runs OCR by default for low-text pdf files', async () => {
    tesseractMocks.createWorker.mockResolvedValue({
      recognize: tesseractMocks.recognize,
      terminate: tesseractMocks.terminate,
    });
    tesseractMocks.recognize.mockResolvedValue({
      data: { text: 'Scanned renewal terms and customer obligations extracted by OCR.' },
    });
    tesseractMocks.terminate.mockResolvedValue(undefined);

    const doc = await parseInput({ type: 'pdf', content: createSimplePdfBase64(''), fileName: 'scan.pdf' });

    expect(tesseractMocks.recognize).toHaveBeenCalledTimes(1);
    expect(doc.sourceMeta.ocrUsed).toBe(true);
    expect(doc.markdown).toContain('Scanned renewal terms');
  });

  it('renders low-text pdf pages to PNG before sending them to OCR', async () => {
    tesseractMocks.createWorker.mockResolvedValue({
      recognize: tesseractMocks.recognize,
      terminate: tesseractMocks.terminate,
    });
    tesseractMocks.recognize.mockResolvedValue({
      data: { text: 'Scanned renewal terms and customer obligations extracted by OCR.' },
    });
    tesseractMocks.terminate.mockResolvedValue(undefined);

    const doc = await parseInput({ type: 'pdf', content: createSimplePdfBase64(''), fileName: 'scan.pdf' });
    const ocrInput = tesseractMocks.recognize.mock.calls[0]?.[0];
    const ocrBytes = Buffer.from(ocrInput as Uint8Array);

    expect(Array.from(ocrBytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(doc.sourceMeta.ocrUsed).toBe(true);
    expect(doc.markdown).toContain('Scanned renewal terms');
  });
});
