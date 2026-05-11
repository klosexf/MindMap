import { NextResponse } from 'next/server';
import { PNG } from 'pngjs';
import { z } from 'zod';

export const runtime = 'nodejs';

const bodySchema = z.object({
  dataUrl: z.string().optional(),
  title: z.string().optional(),
});

function sanitizeAsciiFilename(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');

  return normalized || 'mindmap';
}

function encodeContentDispositionFilename(title?: string): string {
  const baseName = (title || 'mindmap').trim() || 'mindmap';
  const asciiFilename = `${sanitizeAsciiFilename(baseName)}.png`;
  const utf8Filename = encodeURIComponent(`${baseName}.png`)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`;
}

function createPlaceholderPng(title = 'MindMap Export'): Buffer {
  const width = 1200;
  const height = 630;
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      const isBorder = x < 4 || y < 4 || x > width - 5 || y > height - 5;
      const isStripe = (x + y) % 17 === 0;

      png.data[idx] = isBorder ? 26 : isStripe ? 245 : 255;
      png.data[idx + 1] = isBorder ? 26 : isStripe ? 247 : 255;
      png.data[idx + 2] = isBorder ? 26 : isStripe ? 250 : 255;
      png.data[idx + 3] = 255;
    }
  }

  const titleBytes = Buffer.from(title.slice(0, 48), 'utf8');
  titleBytes.forEach((byte, index) => {
    const x = 40 + (index % 40) * 4;
    const y = 60 + Math.floor(index / 40) * 6;
    const idx = (width * y + x) << 2;
    if (idx + 3 < png.data.length) {
      png.data[idx] = byte;
      png.data[idx + 1] = byte;
      png.data[idx + 2] = byte;
      png.data[idx + 3] = 255;
    }
  });

  return PNG.sync.write(png);
}

export async function POST(req: Request) {
  try {
    const { dataUrl, title } = bodySchema.parse(await req.json());

    let buffer: Buffer;
    if (dataUrl?.startsWith('data:image/png;base64,')) {
      buffer = Buffer.from(dataUrl.replace('data:image/png;base64,', ''), 'base64');
    } else {
      buffer = createPlaceholderPng(title);
    }

    return new Response(buffer, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': encodeContentDispositionFilename(title),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'PNG export failed' },
      { status: 400 },
    );
  }
}
