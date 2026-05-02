import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { parsePdfInput } from '@/lib/parsers/pdf';
import { generateMindMapStream } from '@/lib/llm/generate';
import type { NormalizedDocument } from '@/lib/types/mindmap';
import { describe, it, expect } from 'vitest';

const PDF_PATH = '/Users/chenxiaofeng/Downloads/【产品经理_深圳 15-20K】谭艳丽 9年.pdf';

describe('Full pipeline benchmark', () => {
  it('measures each stage of PDF-to-mindmap', async () => {
    const pdfBuffer = readFileSync(PDF_PATH);
    const base64 = pdfBuffer.toString('base64');
    const fileName = path.basename(PDF_PATH);

    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║  Full Pipeline: PDF → MindMap            ║`);
    console.log(`╠══════════════════════════════════════════╣`);
    console.log(`║  File: ${fileName}`);
    console.log(`║  Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);
    console.log(`╚══════════════════════════════════════════╝\n`);

    const totalStart = performance.now();

    // ── Phase 1: Parse PDF ──
    console.log('── Phase 1: PDF → Markdown ──');
    const p1Start = performance.now();
    const doc: NormalizedDocument = await parsePdfInput(base64, fileName);
    const p1Time = (performance.now() - p1Start) / 1000;

    console.log(`  Text chars : ${doc.markdown.length}`);
    console.log(`  Chunks     : ${doc.chunks.length}`);
    console.log(`  OCR used   : ${doc.sourceMeta.ocrUsed}`);
    console.log(`  OCR engine : ${doc.sourceMeta.ocrDebug?.provider || 'none'}`);
    console.log(`  OCR pages  : ${doc.sourceMeta.ocrDebug?.attemptedPages ?? 0} attempted / ${doc.sourceMeta.ocrDebug?.acceptedPages ?? 0} accepted`);
    if (doc.sourceMeta.parseWarning) console.log(`  Warning    : ${doc.sourceMeta.parseWarning}`);
    if (doc.sourceMeta.ocrDebug?.errorMessages?.length) {
      console.log(`  OCR errors : ${doc.sourceMeta.ocrDebug.errorMessages.slice(0, 3).join(', ')}`);
    }
    console.log(`  ⏱️  Parse   : ${p1Time.toFixed(2)}s`);

    // ── Phase 2: LLM Generation ──
    console.log('\n── Phase 2: Markdown → MindMap ──');
    const p2Start = performance.now();

    let firstEventAt = 0;
    let skeletonAt = 0;
    let nodeCount = 0;
    let lastNodeAt = 0;
    let completeAt = 0;
    let finalNodeCount = 0;
    let errorMsg = '';
    let pathLabel = '';

    try {
      for await (const event of generateMindMapStream(doc)) {
        const t = (performance.now() - p2Start) / 1000;

        switch (event.type) {
          case 'skeleton': {
            if (!firstEventAt) firstEventAt = t;
            skeletonAt = t;
            const nodeCount = countNodes(event.data.tree.root);
            pathLabel = 'heuristic (no LLM)';
            console.log(`  [${t.toFixed(2)}s] Skeleton (${nodeCount} nodes in heuristic tree)`);
            break;
          }
          case 'node': {
            if (!firstEventAt) firstEventAt = t;
            nodeCount++;
            lastNodeAt = t;
            break;
          }
          case 'complete': {
            completeAt = t;
            finalNodeCount = countNodes(event.data.tree.root);
            console.log(`  [${t.toFixed(2)}s] Complete — final tree: ${finalNodeCount} nodes`);
            break;
          }
          case 'error': {
            errorMsg = event.data.message;
            console.log(`  [${t.toFixed(2)}s] ❌ Error: ${event.data.message}`);
            break;
          }
        }
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      console.log(`  ❌ Exception: ${errorMsg}`);
    }

    const p2Time = (performance.now() - p2Start) / 1000;
    const totalTime = (performance.now() - totalStart) / 1000;

    // Breakdown
    console.log(`\n  Generation path  : ${pathLabel || 'LLM'}`);
    console.log(`  First event at   : ${firstEventAt.toFixed(2)}s`);
    console.log(`  Skeleton at      : ${skeletonAt.toFixed(2)}s`);
    console.log(`  Nodes streamed   : ${nodeCount}`);
    console.log(`  Last node at     : ${lastNodeAt.toFixed(2)}s`);
    console.log(`  Complete at      : ${completeAt.toFixed(2)}s`);
    console.log(`  ⏱️  Generate : ${p2Time.toFixed(2)}s`);

    // ── Summary ──
    const bar = '──────────────────────────────────────────';
    console.log(`\n┌${bar}┐`);
    console.log(`│  Pipeline Summary                         │`);
    console.log(`├${bar}┤`);
    console.log(`│  Phase 1 (PDF→Markdown)    ${String(p1Time.toFixed(2) + 's').padStart(8)}               │`);
    console.log(`│  Phase 2 (Markdown→MindMap) ${String(p2Time.toFixed(2) + 's').padStart(8)}               │`);
    console.log(`│  ${bar}  │`);
    console.log(`│  🏁 TOTAL                  ${String(totalTime.toFixed(2) + 's').padStart(8)}               │`);
    console.log(`└${bar}┘\n`);

    if (errorMsg) console.log(`  ⚠️  Note: ${errorMsg}\n`);

    expect(doc.chunks.length).toBeGreaterThan(0);
    expect(p1Time).toBeGreaterThan(0);
  }, 180_000);
});

function countNodes(root: { children?: any[] }): number {
  let n = 1;
  if (root.children) {
    for (const c of root.children) n += countNodes(c);
  }
  return n;
}
