import { describe, expect, it } from 'vitest';

import { extractCompletedArrayStrings } from '../lib/llm/generate';

describe('extractCompletedArrayStrings', () => {
  it('returns empty when no array has started', () => {
    expect(extractCompletedArrayStrings('')).toEqual([]);
    expect(extractCompletedArrayStrings('思考中...')).toEqual([]);
  });

  it('returns only fully closed string elements', () => {
    expect(extractCompletedArrayStrings('["用户调研"]')).toEqual(['用户调研']);
    expect(extractCompletedArrayStrings('["用户调研", "竞')).toEqual(['用户调研']);
  });

  it('stops scanning after the array closes (ignores trailing prose quotes)', () => {
    expect(extractCompletedArrayStrings('["a", "b"] 注意"别误收"')).toEqual(['a', 'b']);
  });

  it('handles escaped quotes and backslashes inside strings', () => {
    expect(extractCompletedArrayStrings('["说\\"引号\\""]')).toEqual(['说"引号"']);
    expect(extractCompletedArrayStrings('["路径 C:\\\\tmp"]')).toEqual(['路径 C:\\tmp']);
  });

  it('skips malformed JSON strings without breaking the scan', () => {
    // 非法转义 \"x 后元素被跳过，后续合法元素继续提取
    expect(extractCompletedArrayStrings('["a\\q", "b"]')).toEqual(['b']);
  });

  it('extracts content from {content} object elements when closed', () => {
    expect(extractCompletedArrayStrings('[{"content": "子题一"}, {"content": "子')).toEqual(['子题一']);
  });

  it('ignores nested unclosed objects', () => {
    expect(extractCompletedArrayStrings('[{"content": "子题一"')).toEqual([]);
    expect(extractCompletedArrayStrings('[{"content": {"deep')).toEqual([]);
  });

  it('works incrementally: repeated calls return the cumulative completed list', () => {
    let buffer = '';
    const seen: string[] = [];
    for (const delta of ['["子题一"', ', "子题', '二"', ']']) {
      buffer += delta;
      for (const item of extractCompletedArrayStrings(buffer).slice(seen.length)) {
        seen.push(item);
      }
    }
    expect(seen).toEqual(['子题一', '子题二']);
  });
});
