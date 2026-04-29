#!/usr/bin/env python3
"""
Minimal PaddleOCR runner.

Input:
  python paddle_ocr.py /absolute/path/to/image.png

Output JSON:
  {
    "text": "...",
    "lines": [{"text": "...", "score": 0.98}],
    "avg_score": 0.98
  }
"""

import json
import os
import sys


def _fail(message: str, code: int = 1) -> None:
    sys.stderr.write(message + "\n")
    sys.exit(code)


def _to_bool(value: str) -> bool:
    return value.strip().lower() not in {"0", "false", "no", "off"}


def main() -> int:
    if len(sys.argv) < 2:
        _fail("usage: paddle_ocr.py <image_path>", 2)

    image_path = sys.argv[1]
    if not os.path.exists(image_path):
        _fail(f"image_not_found:{image_path}", 2)

    lang = os.getenv("PADDLE_OCR_LANG", "ch")
    use_angle_cls = _to_bool(os.getenv("PADDLE_OCR_USE_ANGLE_CLS", "false"))
    use_doc_orientation = _to_bool(os.getenv("PADDLE_OCR_USE_DOC_ORIENTATION", "false"))
    use_doc_unwarping = _to_bool(os.getenv("PADDLE_OCR_USE_DOC_UNWARPING", "false"))

    # PaddleX/PaddleOCR writes model and temp cache under ~/.paddlex by default.
    # In sandboxed environments this path may be non-writable, so allow override.
    paddlex_home = os.getenv("PADDLE_PDX_CACHE_HOME")
    if not paddlex_home:
        paddlex_home = os.path.abspath(os.path.join(os.getcwd(), ".cache", "paddlex"))
        os.environ["PADDLE_PDX_CACHE_HOME"] = paddlex_home
    os.makedirs(paddlex_home, exist_ok=True)

    try:
        from paddleocr import PaddleOCR  # type: ignore
    except Exception as exc:  # pragma: no cover
        _fail(f"import_paddleocr_failed:{exc}", 3)

    try:
        try:
            ocr = PaddleOCR(
                lang=lang,
                use_textline_orientation=use_angle_cls,
                use_doc_orientation_classify=use_doc_orientation,
                use_doc_unwarping=use_doc_unwarping,
            )
        except TypeError:
            ocr = PaddleOCR(lang=lang, use_angle_cls=use_angle_cls)

        if hasattr(ocr, "predict"):
            raw_result = ocr.predict(image_path)
            lines = []
            for page_result in raw_result or []:
                text_lines = []
                if hasattr(page_result, "res"):
                    text_lines = (page_result.res or {}).get("rec_texts", [])
                    scores = (page_result.res or {}).get("rec_scores", [])
                    for idx, text in enumerate(text_lines):
                        text = str(text).strip()
                        if not text:
                            continue
                        score = scores[idx] if idx < len(scores) else None
                        lines.append({"text": text, "score": score})
                elif isinstance(page_result, dict):
                    text_lines = (page_result.get("rec_texts") or []) if isinstance(page_result, dict) else []
                    scores = (page_result.get("rec_scores") or []) if isinstance(page_result, dict) else []
                    for idx, text in enumerate(text_lines):
                        text = str(text).strip()
                        if not text:
                            continue
                        score = scores[idx] if idx < len(scores) else None
                        lines.append({"text": text, "score": score})
            result_lines = lines
        else:
            result = ocr.ocr(image_path, cls=use_angle_cls)
            result_lines = []
            for page in result or []:
                if not page:
                    continue
                for item in page:
                    if not item or len(item) < 2:
                        continue
                    rec = item[1]
                    if not rec or len(rec) < 1:
                        continue
                    text = (rec[0] or "").strip() if isinstance(rec, (list, tuple)) else ""
                    score = rec[1] if isinstance(rec, (list, tuple)) and len(rec) > 1 else None
                    if text:
                        result_lines.append({"text": text, "score": score})
    except Exception as exc:  # pragma: no cover
        _fail(f"paddle_ocr_runtime_failed:{exc}", 4)

    text = "\n".join(line["text"] for line in result_lines).strip()
    valid_scores = [line["score"] for line in result_lines if isinstance(line.get("score"), (int, float))]
    avg_score = (sum(valid_scores) / len(valid_scores)) if valid_scores else None

    payload = {
        "text": text,
        "lines": result_lines,
        "avg_score": avg_score,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
