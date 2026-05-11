import { describe, expect, it } from 'vitest';

import { POST } from '../app/api/export/png/route';

describe('POST /api/export/png', () => {
  it('returns png bytes even without dataUrl', async () => {
    const req = new Request('http://localhost/api/export/png', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'demo' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(100);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
  });

  it('supports non-ascii titles in the download filename', async () => {
    const req = new Request('http://localhost/api/export/png', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '中文导图' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Disposition')).toContain("filename*=UTF-8''");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(100);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
  });
});
