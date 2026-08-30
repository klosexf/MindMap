import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';

import { parseInput } from '../lib/parsers';

// Manual debug test: only runs when REAL_PDF_PATH is provided, so regular
// `npm run test` never spawns real OCR python processes or depends on
// machine-local files.
const realPdfPath = process.env.REAL_PDF_PATH;
const itReal = realPdfPath ? it : it.skip;

describe('real pdf debug', () => {
  itReal('prints parse debug for provided resume pdf', async () => {
    const pdfPath = realPdfPath as string;
    const buf = readFileSync(pdfPath);
    const base64 = buf.toString('base64');

    const doc = await parseInput({
      type: 'pdf',
      content: base64,
      fileName: 'resume.pdf',
      pdfOptions: { forceOcr: true },
    });

    const pages = doc.sourceMeta.ocrDebug?.pages || [];
    const accepted = pages.filter((p) => p.accepted).length;
    const rejected = pages.length - accepted;

    const payload = {
      markdownLength: doc.markdown.length,
      markdownPreview: doc.markdown.slice(0, 1200),
      pageHeadingCount: (doc.markdown.match(/\[page:\d+\]/g) || []).length,
      ocrPageHeadingCount: (doc.markdown.match(/\[ocr-page:\d+\]/g) || []).length,
      chunkCount: doc.chunks.length,
      chunkMeta: doc.chunks.map((c) => ({
        id: c.id,
        textLen: c.text.length,
        page: c.sourceRef.page || null,
        location: c.sourceRef.location || null,
        preview: c.text.slice(0, 160),
      })),
      ocrUsed: doc.sourceMeta.ocrUsed,
      parseWarning: doc.sourceMeta.parseWarning,
      provider: doc.sourceMeta.ocrDebug?.provider,
      model: doc.sourceMeta.ocrDebug?.model,
      attemptedPages: doc.sourceMeta.ocrDebug?.attemptedPages,
      acceptedPages: doc.sourceMeta.ocrDebug?.acceptedPages,
      accepted,
      rejected,
      pageReasons: pages.map((p) => ({
        page: p.page,
        accepted: p.accepted,
        reason: p.reason || null,
        cleanedLen: p.cleanedText.length,
        cleanedPreview: p.cleanedText.slice(0, 120),
      })),
    };
    writeFileSync('./tmp-real-pdf-debug.json', JSON.stringify(payload, null, 2), 'utf8');

    expect(doc.markdown.length).toBeGreaterThan(0);
  }, 240000);
});
