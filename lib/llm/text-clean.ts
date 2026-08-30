/**
 * LLM 输入文本清洗链（从 generate.ts 抽出，纯函数、无外部依赖）。
 *
 * 职责：在注入 prompt 前移除 OCR 噪声行、乱码 token、页码标签、
 * 文件名残留等，同时保留可读内容与文档结构（标题等）。
 *
 * 设计要点：不做整行丢弃（会丢失混在噪声里的有效 CJK 文本），
 * 而是尽量抽取行内可读子片段（extractReadableSegmentsFromLine）。
 */

export const PAGE_LABEL_RE = /^(Page\s+\d+|OCR\s+Page\s+\d+|OCR\s+第\d+页|page:\d+|ocr-page:\d+|第\d+页)$/i;

export function cleanMarkdownText(text: string): string {
  return text
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean markdown for LLM input: remove garbled/OCR-noise lines while
 * preserving readable content and document structure (headings, etc).
 *
 * Key design: instead of discarding entire noisy lines (which loses valid
 * CJK text mixed with OCR noise), we try to extract readable sub-segments.
 */
export function cleanMarkdownForLLM(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];
  let totalContentLines = 0;
  let totalKeptLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Keep empty lines (paragraph separators)
    if (!trimmed) {
      result.push('');
      continue;
    }

    // Keep markdown headings
    if (/^#{1,6}\s+/.test(trimmed)) {
      const headingText = trimmed.replace(/^#{1,6}\s+/, '').trim();
      if (PAGE_LABEL_RE.test(headingText)) {
        continue;
      }
      if (/\.(pdf|doc|docx|txt|md|ppt|pptx|xlsx|xls|html)$/i.test(headingText)) {
        continue;
      }
      result.push(trimmed);
      continue;
    }

    if (/^---$/.test(trimmed) || /^\[(?:page|ocr-page):\d+\]$/.test(trimmed)) {
      continue;
    }

    if (/\.(pdf|doc|docx|txt|md|ppt|pptx|xlsx|xls|html)$/i.test(trimmed) || /[^\n]{8,60}\.(pdf|doc|docx)\b/i.test(trimmed)) {
      continue;
    }

    totalContentLines++;

    // Strip common punctuation for analysis
    const analysisText = trimmed
      .replace(/[,;:|.!?，。！？、：；|｜\-—–()（）\[\]【】{}\/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // If the line has enough CJK content (>=20%), it's likely readable — keep as-is
    const cjkChars = (analysisText.match(/[\u3400-\u9fff]/g) || []).length;
    const totalNonSpace = analysisText.replace(/\s/g, '').length;
    if (totalNonSpace > 0 && cjkChars / totalNonSpace >= 0.2) {
      const compacted = sanitizeSentence(trimmed);
      const candidate = compacted || trimmed;
      const candidateTokens = candidate.split(/\s+/).filter(Boolean);
      const noiseTokenCount = candidateTokens.filter((token) => isLikelyNoiseToken(token, true)).length;
      const hasHeavyNoise = candidateTokens.length >= 4 && noiseTokenCount / candidateTokens.length > 0.45;

      result.push(hasHeavyNoise ? compacted || trimmed : candidate);
      totalKeptLines++;
      continue;
    }

    // If the line is short and mostly numbers/dates/phones, keep it
    const digitAndPunct = (analysisText.match(/[\d\s\-/:.]/g) || []).length;
    if (totalNonSpace > 0 && digitAndPunct / analysisText.length >= 0.7 && analysisText.length < 80) {
      result.push(trimmed);
      totalKeptLines++;
      continue;
    }

    // Check if the line contains ANY meaningful CJK content mixed with noise.
    // If so, try to extract readable segments instead of discarding the whole line.
    if (cjkChars >= 3) {
      const extracted = extractReadableSegmentsFromLine(trimmed);
      if (extracted) {
        result.push(extracted);
        totalKeptLines++;
        continue;
      }
    }

    // Check for garbled text using existing detector
    if (isGarbledText(analysisText)) {
      continue; // Skip this line
    }

    // Filter out lines that are dominated by long numeric IDs / phone numbers
    // These are common in OCR noise from forms and PDF headers
    const tokens = analysisText.split(/\s+/).filter(Boolean);
    if (tokens.length >= 3) {
      const hasCjkContext = tokens.some((t) => CJK_CHAR_RE.test(t));
      const noiseTokens = tokens.filter((t) => isLikelyNoiseToken(t, hasCjkContext)).length;
      // Also count standalone long-number tokens as noise
      const longNumericTokens = tokens.filter((t) => /^\d{7,}$/.test(t)).length;
      const totalNoise = noiseTokens + longNumericTokens;
      // If more than 50% of tokens are noise (including long numbers), skip
      if (totalNoise / tokens.length > 0.5) {
        continue;
      }
    }

    result.push(trimmed);
    totalKeptLines++;
  }

  const cleaned = result.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // Safety net: if we filtered out too aggressively (>70% of content lines dropped),
  // fall back to a lighter cleaning that only removes clearly-garbled tokens
  if (totalContentLines > 2 && totalKeptLines / totalContentLines < 0.3) {
    return lightCleanMarkdown(markdown);
  }

  return cleaned;
}

/**
 * Attempt to extract readable sub-segments from a noisy OCR line that contains
 * both real CJK text and garbage. Splits on boundaries and keeps segments that
 * pass readability checks.
 */
function extractReadableSegmentsFromLine(line: string): string | null {
  // Split the line into segments on common delimiters that separate logical units
  // OCR often outputs: [garble] [real content] [garble] | [more content] [garble]
  const segments = line.split(/(\s*[|｜]\s*|\s{2,}|\s+(?=[\u3400-\u9fff])|(?<=[\u3400-\u9fff])\s+)/);

  const keptSegments: string[] = [];

  for (const seg of segments) {
    const trimmedSeg = seg.trim();
    if (!trimmedSeg || trimmedSeg.length < 2) continue;

    // Analyze segment quality
    const segAnalysis = trimmedSeg
      .replace(/[,;:|.!?，。！？、：；\-—–()（）\[\]【】{}\/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const segCJK = (segAnalysis.match(/[\u3400-\u9fff]/g) || []).length;
    const segTotal = segAnalysis.replace(/\s/g, '').length;

    // Keep segments with good CJK ratio or short clean segments
    if (segTotal > 0 && segCJK / segTotal >= 0.25) {
      keptSegments.push(trimmedSeg);
      continue;
    }

    // Short numeric/date-like segments
    if (trimmedSeg.length < 30 && /^[\d\s\-/:.+@]+$/.test(trimmedSeg.replace(/[()（）]/g, ''))) {
      keptSegments.push(trimmedSeg);
      continue;
    }

    // Extract numeric sub-segments from mixed segments (e.g. "REE 1993.07.04" → "1993.07.04")
    const numericParts = segAnalysis.split(/\s+/).filter((p) => isNumericToken(p));
    if (numericParts.length > 0) {
      keptSegments.push(...numericParts);
      // If segment has no CJK at all, numeric parts are all we can salvage
      if (segCJK === 0) continue;
    }

    // Segment with any CJK and not detected as garbled
    if (segCJK >= 1 && !isGarbledText(segAnalysis)) {
      keptSegments.push(trimmedSeg);
      continue;
    }

    // Pure ASCII segment: drop if every token looks like noise
    if (segCJK === 0) {
      const segTokens = segAnalysis.split(/\s+/).filter(Boolean);
      if (segTokens.length === 0) continue;
      const noiseCount = segTokens.filter((t) => isLikelyNoiseToken(t, false)).length;
      if (noiseCount === segTokens.length) {
        continue; // All tokens are noise — drop the segment
      }
      // Partially clean: keep conservatively
      keptSegments.push(trimmedSeg);
    }
  }

  if (keptSegments.length === 0) return null;
  if (keptSegments.length === 1) return keptSegments[0].length >= 4 ? keptSegments[0] : null;

  // Join kept segments with spaces
  const joined = keptSegments.join(' ');
  return joined.length >= 4 ? joined : null;
}

/**
 * Lighter cleaning pass used as fallback when aggressive filtering removed too much.
 * Only removes obviously garbled tokens/sentences, preserves most content.
 */
function lightCleanMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      result.push('');
      continue;
    }

    // Always keep headings (except page-label headings)
    if (/^#{1,6}\s+/.test(trimmed)) {
      const headingText = trimmed.replace(/^#{1,6}\s+/, '').trim();
      if (PAGE_LABEL_RE.test(headingText)) {
        continue;
      }
      result.push(trimmed);
      continue;
    }

    if (/^---$/.test(trimmed) || /^\[(?:page|ocr-page):\d+\]$/.test(trimmed)) {
      continue;
    }

    // Apply sanitizeSentence which does per-token cleaning
    const sanitized = sanitizeSentence(trimmed);
    if (sanitized && sanitized.length >= 2 && !isGarbledText(sanitized)) {
      result.push(sanitized);
    } else if (trimmed.length >= 2) {
      // Even if garbled, try keeping original for LLM to make sense of
      const hasAnyCJK = /[\u3400-\u9fff]/.test(trimmed);
      if (hasAnyCJK) {
        result.push(trimmed);
      }
    }
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const CJK_CHAR_RE = /[\u3400-\u9fff]/;
const ASCII_TOKEN_ALLOWLIST = new Set(['AI', 'AIGC', 'API', 'APP', 'B2B', 'B2C', 'KPI', 'OKR', 'PDF', 'SQL', 'UI', 'UX']);

function normalizeToken(token: string): string {
  return token.replace(/^[^\p{L}\p{N}\u3400-\u9fff]+|[^\p{L}\p{N}\u3400-\u9fff]+$/gu, '');
}

function isNumericToken(token: string): boolean {
  return /^[\d]+([./:\-][\d]+)*$/.test(token);
}

function collapseCjkSpacing(text: string): string {
  let output = text;
  let prev = '';
  while (output !== prev) {
    prev = output;
    output = output.replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2');
  }
  return output;
}

function isLikelyNoiseToken(token: string, hasCjkContext: boolean): boolean {
  if (!token) return true;
  if (token.length > 18) return true;
  if (/[A-Za-z]/.test(token) && /\d/.test(token) && token.length >= 8) return true;
  if (/[_@]/.test(token) && token.length >= 6) return true;
  if (/([A-Za-z])\1{4,}/.test(token)) return true;

  // Long numeric sequences (phone numbers, IDs, form codes) are noise
  // unless they look like plausible dates or short counts
  if (/^\d+$/.test(token) && token.length >= 7) {
    // Allow common date-like patterns: YYYY, YYYYMM, YYYYMMDD, MMDD
    if (/^(19|20)\d{2}([01]\d)?([0-3]\d)?$/.test(token)) return false;
    if (/^[0-3]?\d[0-3]?\d$/.test(token) && token.length <= 4) return false;
    // Everything else 7+ digits is likely an ID/phone/form code → noise
    return true;
  }

  const upper = token.toUpperCase();
  const allUpperAscii = /^[A-Z]{3,}$/.test(token);
  if (allUpperAscii && !ASCII_TOKEN_ALLOWLIST.has(upper)) return true;

  if (/^[A-Za-z]{2,}$/.test(token)) {
    const vowelCount = (token.match(/[aeiou]/gi) || []).length;
    const vowelRatio = vowelCount / token.length;
    // Extremely low vowel ratio → garbled regardless of CJK context
    if (vowelRatio < 0.15 && token.length >= 4) {
      return true;
    }
    // 4+ consecutive consonants → garbled regardless of CJK context
    const consonantClusters = token.match(/[bcdfghjklmnpqrstvwxyz]{4,}/gi) || [];
    if (consonantClusters.length > 0) {
      return true;
    }
    // Only apply strict upper-case check when there IS a CJK context
    if (hasCjkContext) {
      const upperChars = (token.match(/[A-Z]/g) || []).length;
      const upperRatio = upperChars / token.length;
      if (upperRatio >= 0.6 && !ASCII_TOKEN_ALLOWLIST.has(upper)) {
        return true;
      }
    }
  }

  if (/[A-Za-z]/.test(token) && /\d/.test(token) && token.length >= 5) {
    const letterCount = (token.match(/[A-Za-z]/g) || []).length;
    const digitCount = (token.match(/\d/g) || []).length;
    if (letterCount >= 3 && digitCount >= 2 && !/^[A-Za-z]+\d+$/.test(token) && !/^\d+[A-Za-z]+$/.test(token)) {
      return true;
    }
  }

  return false;
}

function shouldKeepAsciiTokenInCjkContext(token: string): boolean {
  const upper = token.toUpperCase();
  if (ASCII_TOKEN_ALLOWLIST.has(upper)) return true;
  if (isNumericToken(token)) return true;

  if (token.length < 5) return false;
  if (!/^[a-z]+$/.test(token)) return false;
  if (!/[aeiou]/.test(token)) return false;
  if (isLikelyNoiseToken(token, true)) return false;
  return true;
}

export function isGarbledText(text: string): boolean {
  if (!text || text.length < 5) return false;

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  let garbledCount = 0;
  for (const token of tokens) {
    if (/^[A-Za-z]+$/.test(token)) {
      const vowelCount = (token.match(/[aeiou]/gi) || []).length;
      const vowelRatio = vowelCount / token.length;
      if (vowelRatio < 0.15 && token.length >= 4) {
        garbledCount++;
        continue;
      }
      const consonantClusters = token.match(/[bcdfghjklmnpqrstvwxyz]{4,}/gi) || [];
      if (consonantClusters.length > 0) {
        garbledCount++;
        continue;
      }
    }
    if (/[A-Z]{3,}/.test(token) && /[a-z]/.test(token)) {
      const upperRatio = (token.match(/[A-Z]/g) || []).length / token.length;
      if (upperRatio > 0.5) {
        garbledCount++;
      }
    }
  }

  return garbledCount / tokens.length >= 0.4;
}

export function sanitizeSentence(sentence: string): string {
  const normalizedTokens = sentence
    .split(/\s+/)
    .map((token) => normalizeToken(token))
    .filter(Boolean);

  const hasCjkContext = normalizedTokens.some((token) => CJK_CHAR_RE.test(token));
  const keptTokens = normalizedTokens.filter((token) => {
    // Preserve ALL CJK tokens in general sanitization — they're almost always
    // legitimate content. Garbled CJK detection should only happen at the
    // final tree-node level where we have more context.
    if (CJK_CHAR_RE.test(token)) return true;
    if (isLikelyNoiseToken(token, hasCjkContext)) return false;
    if (!hasCjkContext) {
      // Without CJK context, still filter: keep numbers, allowlist, and
      // normal-looking English words (have lowercase + vowels)
      if (isNumericToken(token)) return true;
      if (ASCII_TOKEN_ALLOWLIST.has(token.toUpperCase())) return true;
      const hasLowercase = /[a-z]/.test(token);
      const hasVowel = /[aeiou]/i.test(token);
      return hasLowercase && hasVowel;
    }
    return shouldKeepAsciiTokenInCjkContext(token);
  });

  const merged = collapseCjkSpacing(keptTokens.join(' '))
    .replace(/\s+([,.;:!?，。！？、：；）\]】])/g, '$1')
    .replace(/([（(\[【])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return merged;
}

export function isReadableSentence(sentence: string): boolean {
  if (!sentence) return false;

  if (isGarbledText(sentence)) return false;

  const cjkChars = sentence.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const totalChars = sentence.replace(/\s/g, '').length;
  if (cjkChars >= 2) {
    const cjkRatio = cjkChars / totalChars;
    if (cjkRatio >= 0.3) return true;
  }

  const tokens = sentence
    .split(/\s+/)
    .map((token) => normalizeToken(token))
    .filter(Boolean);

  const asciiAlphaTokens = tokens.filter((token) => /[A-Za-z]/.test(token));
  if (asciiAlphaTokens.length < 3) return false;

  const lowercaseChars = sentence.match(/[a-z]/g)?.length ?? 0;
  const uppercaseTokens = asciiAlphaTokens.filter((token) => /^[A-Z]{2,}$/.test(token)).length;
  const uppercaseRatio = uppercaseTokens / asciiAlphaTokens.length;
  const noVowelLongTokenRatio =
    asciiAlphaTokens.filter((token) => token.length >= 6 && !/[aeiou]/i.test(token)).length / asciiAlphaTokens.length;

  if (lowercaseChars < 3 && uppercaseRatio >= 0.5) return false;
  if (uppercaseRatio >= 0.75) return false;
  if (noVowelLongTokenRatio >= 0.4) return false;

  const asciiWords = sentence
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /^[A-Za-z][A-Za-z-]*$/.test(token));
  return asciiWords.length >= 3;
}

export function isLikelyNoisyMixedText(text: string): boolean {
  if (!text) return false;

  const tokens = text
    .split(/\s+/)
    .map((token) => normalizeToken(token))
    .filter(Boolean);
  if (tokens.length === 0) return false;

  const cjkTokenCount = tokens.filter((token) => CJK_CHAR_RE.test(token)).length;
  if (cjkTokenCount === 0) return false;

  const asciiTokens = tokens.filter((token) => /^[A-Za-z]+$/.test(token));
  if (asciiTokens.length < 4) return false;

  const suspiciousAscii = asciiTokens.filter((token) => {
    const upper = token.toUpperCase();
    if (ASCII_TOKEN_ALLOWLIST.has(upper)) return false;
    if (token.length <= 2) return true;
    if (isLikelyNoiseToken(token, true)) return true;
    if (token.length <= 4 && !/[aeiou]/i.test(token)) return true;
    return false;
  }).length;

  return suspiciousAscii / asciiTokens.length >= 0.5;
}
