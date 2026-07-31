#!/usr/bin/env python3
"""Local COC OCR API backed by an Ollama vision model.

The server binds to 127.0.0.1 only, serves the integrated HTML at `/`, and
accepts OCR requests at `/api/coc-ocr`. Pillow is used to enlarge the COC
table in ten-row bands before recognition.
"""

from __future__ import annotations

import base64
import binascii
from collections import Counter
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HOST = os.environ.get("COC_OCR_HOST", "127.0.0.1")
PORT = int(os.environ.get("COC_OCR_PORT", "8765"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
REQUEST_TOKEN = os.environ.get("COC_OCR_TOKEN", "")
PREFERRED_MODEL = os.environ.get("COC_OCR_MODEL", "")
MAX_REQUEST_BYTES = int(os.environ.get("COC_OCR_MAX_REQUEST_BYTES", str(30 * 1024 * 1024)))
MAX_IMAGE_BYTES = int(os.environ.get("COC_OCR_MAX_IMAGE_BYTES", str(20 * 1024 * 1024)))
OLLAMA_TIMEOUT = int(os.environ.get("COC_OCR_TIMEOUT", "300"))
APP_HTML = Path(__file__).with_name("integrated_field_forms.html")
ALLOWED_ORIGINS = {
    item.strip()
    for item in os.environ.get(
        "COC_OCR_ALLOWED_ORIGINS",
        f"null,http://127.0.0.1:{PORT},http://localhost:{PORT}",
    ).split(",")
    if item.strip()
}
MODEL = ""

ANALYSIS_ITEMS = [
    "TPH",
    "BTEX",
    "TCE",
    "PCE",
    "1,2-DCA",
    "Cu",
    "As",
    "Zn",
    "Ni",
    "Cd",
    "Pb",
    "Cr6+",
    "Hg",
    "F",
    "CN",
    "Phenol",
    "유기인",
    "PCB",
    "벤조(a)피렌",
    "pH",
    "EC",
    "염농도",
    "유효인산",
    "유기물함량",
    "치환성양이온",
    "전질소(T-N)",
    "CEC",
    "토성",
    "공극률",
    "유효수분량",
    "토양경도",
]

OCR_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "projectName": {"type": "string"},
        "area": {"type": "string"},
        "laboratory": {"type": "string"},
        "manager": {"type": "string"},
        "samples": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "no": {"type": "string"},
                    "sampleId": {"type": "string"},
                    "depth": {"type": "string"},
                    "sampleDate": {"type": "string"},
                    "matrix": {"type": "string"},
                    "container": {"type": "string"},
                    "vial": {"type": "string"},
                    "analyses": {
                        "type": "array",
                        "items": {"type": "string", "enum": ANALYSIS_ITEMS},
                    },
                    "comment": {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
                "required": [
                    "no",
                    "sampleId",
                    "depth",
                    "sampleDate",
                    "matrix",
                    "container",
                    "vial",
                    "analyses",
                    "comment",
                    "confidence",
                ],
            },
        },
    },
    "required": ["projectName", "area", "laboratory", "manager", "samples"],
}

BATCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "projectName": {"type": "string"},
        "area": {"type": "string"},
        "laboratory": {"type": "string"},
        "manager": {"type": "string"},
        "samples": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "no": {"type": "string"},
                    "sampleIdRaw": {"type": "string"},
                    "depth": {"type": "string"},
                    "sampleDate": {"type": "string"},
                    "matrix": {"type": "string"},
                    "container": {"type": "string"},
                    "vial": {"type": "string"},
                    "analyses": {
                        "type": "array",
                        "items": {"type": "string", "enum": ANALYSIS_ITEMS},
                    },
                    "comment": {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
                "required": [
                    "no",
                    "sampleIdRaw",
                    "depth",
                    "sampleDate",
                    "matrix",
                    "container",
                    "vial",
                    "analyses",
                    "comment",
                    "confidence",
                ],
            },
        },
    },
    "required": ["projectName", "area", "laboratory", "manager", "samples"],
}

OCR_PROMPT = f"""
You are reading a photographed handwritten CHAIN-OF-CUSTODY AND ANALYSIS
REQUEST form. Extract the table accurately and return only JSON matching the
provided schema.

Rules:
1. Read every populated sample row in top-to-bottom order, including rows on
   the far side of a wide landscape form. Do not stop after the first section.
2. The form can contain up to 30 or more rows.
3. For Sample ID shorthand consisting only of a hyphen and a sequence number,
   inherit only the visible prefix from the most recent full Sample ID in the
   same block. A later full ID starts a new block.
4. Preserve visible Sample ID letters, digits and hyphens exactly. Never emit
   placeholders such as "SITE", "SAMPLE", "UNKNOWN", or example values unless
   those exact letters are visibly handwritten in the form.
5. Normalize depth to "start-end" without units, for example "0-0.5" or
   "1-2". Preserve decimal points.
6. Normalize a readable date to YYYY-MM-DD. Check every year, month and day
   digit against the image. If a row omits a date but one clearly visible date
   applies to all rows, repeat only that visible date.
7. A handwritten circle, O, check, or filled mark inside an analysis column
   means that analysis is selected. Only use these analysis names:
   {", ".join(ANALYSIS_ITEMS)}.
8. Read every digit in Number of vial as written; keep it as a string. Do not
   shorten a multi-digit number to its last digit.
9. Empty or unreadable fields must be empty strings, not guesses.
10. confidence is an overall 0..1 confidence for that row. A row may exceed
    0.8 only when Sample ID, depth, vial and all analysis marks are clearly
    visible. Use 0.5 or lower if any of those values are guessed or ambiguous.
11. Do not include blank rows.
""".strip()

_DATA_URL_RE = re.compile(
    r"^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$", re.IGNORECASE
)


def ollama_json(path: str, payload: dict[str, Any] | None = None, timeout: int = 20) -> dict[str, Any]:
    url = f"{OLLAMA_URL}{path}"
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="GET" if payload is None else "POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"Ollama HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Ollama에 연결할 수 없습니다: {error.reason}") from error


def select_vision_model() -> str:
    tags = ollama_json("/api/tags")
    names = [str(item.get("name", "")) for item in tags.get("models", []) if item.get("name")]
    if PREFERRED_MODEL:
        if PREFERRED_MODEL not in names:
            raise RuntimeError(
                f"지정한 모델 '{PREFERRED_MODEL}'이 설치되어 있지 않습니다. 설치 모델: {', '.join(names) or '없음'}"
            )
        candidates = [PREFERRED_MODEL]
    else:
        candidates = sorted(
            names,
            key=lambda name: (
                0 if name.startswith("gemma4:") else
                1 if "qwen" in name.lower() and "vl" in name.lower() else
                2 if name.startswith("gemma3:") else
                3 if "llava" in name.lower() else
                9,
                name,
            ),
        )
    for name in candidates:
        details = ollama_json("/api/show", {"model": name})
        if "vision" in details.get("capabilities", []):
            return name
    raise RuntimeError(
        "이미지 인식이 가능한 Ollama 모델이 없습니다. vision 기능을 가진 모델을 먼저 설치해 주세요."
    )


def parse_model_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start < 0 or end <= start:
            raise RuntimeError("모델 응답에서 JSON을 찾지 못했습니다.")
        result = json.loads(cleaned[start : end + 1])
    if not isinstance(result, dict) or not isinstance(result.get("samples"), list):
        raise RuntimeError("모델 응답에 samples 배열이 없습니다.")
    return result


def image_as_base64(image: Any) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=94, optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def straighten_document(image: Any) -> Any:
    """Conservatively deskew a photographed paper sheet when its outline is clear."""
    try:
        import cv2
        import numpy as np
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(
            "사진 원근 보정에 OpenCV가 필요합니다. requirements.txt를 다시 설치해 주세요."
        ) from error

    source = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
    height, width = source.shape[:2]
    scale = min(1.0, 1400.0 / max(width, height))
    preview = cv2.resize(source, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(preview, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 45, 135)
    edges = cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    preview_area = preview.shape[0] * preview.shape[1]
    document = None
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:12]:
        if cv2.contourArea(contour) < preview_area * 0.35:
            continue
        perimeter = cv2.arcLength(contour, True)
        polygon = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
        if len(polygon) == 4:
            document = polygon.reshape(4, 2).astype("float32") / scale
            break
    if document is None:
        return image

    points = document
    ordered = np.zeros((4, 2), dtype="float32")
    sums = points.sum(axis=1)
    differences = np.diff(points, axis=1).reshape(-1)
    ordered[0] = points[np.argmin(sums)]
    ordered[2] = points[np.argmax(sums)]
    ordered[1] = points[np.argmin(differences)]
    ordered[3] = points[np.argmax(differences)]
    top_left, top_right, bottom_right, bottom_left = ordered
    target_width = int(
        max(np.linalg.norm(bottom_right - bottom_left), np.linalg.norm(top_right - top_left))
    )
    target_height = int(
        max(np.linalg.norm(top_right - bottom_right), np.linalg.norm(top_left - bottom_left))
    )
    if target_width < width * 0.45 or target_height < height * 0.45:
        return image
    target = np.array(
        [[0, 0], [target_width - 1, 0], [target_width - 1, target_height - 1], [0, target_height - 1]],
        dtype="float32",
    )
    matrix = cv2.getPerspectiveTransform(ordered, target)
    warped = cv2.warpPerspective(source, matrix, (target_width, target_height))
    return Image.fromarray(cv2.cvtColor(warped, cv2.COLOR_BGR2RGB))


def prepare_batch_images(image_base64: str) -> list[tuple[int, int, list[str]]]:
    try:
        from PIL import Image, ImageEnhance, ImageOps
    except ImportError as error:
        raise RuntimeError("분할 OCR에 Pillow가 필요합니다. requirements.txt를 설치해 주세요.") from error

    try:
        image = ImageOps.exif_transpose(
            Image.open(io.BytesIO(base64.b64decode(image_base64)))
        ).convert("RGB")
    except Exception as error:
        raise RuntimeError(f"이미지 전처리 실패: {error}") from error
    image = straighten_document(image)
    if image.height > image.width:
        image = image.rotate(90, expand=True)
    gray = ImageOps.autocontrast(ImageOps.grayscale(image), cutoff=1)
    image = ImageEnhance.Contrast(gray).enhance(1.08).convert("RGB")
    width, height = image.size

    table_top, data_top, rows_bottom = 0.172, 0.205, 0.708
    left_x = (0.010, 0.407)
    analysis_x = (0.382, 0.985)

    def crop(box: tuple[float, float, float, float]) -> Any:
        return image.crop(
            (
                max(0, int(width * box[0])),
                max(0, int(height * box[1])),
                min(width, int(width * box[2])),
                min(height, int(height * box[3])),
            )
        )

    def table_band(x_range: tuple[float, float], band_index: int) -> Any:
        header = crop((x_range[0], table_top, x_range[1], data_top))
        band_height = (rows_bottom - data_top) / 3
        band_top = data_top + band_height * band_index
        band_bottom = data_top + band_height * (band_index + 1)
        rows = crop((x_range[0], band_top, x_range[1], band_bottom))
        combined = Image.new("RGB", (max(header.width, rows.width), header.height + rows.height), "white")
        combined.paste(header, (0, 0))
        combined.paste(rows, (0, header.height))
        return combined

    metadata = crop((0.010, 0.035, 0.520, table_top))
    batches: list[tuple[int, int, list[str]]] = []
    for band_index in range(3):
        images = [
            image_as_base64(table_band(left_x, band_index)),
            image_as_base64(table_band(analysis_x, band_index)),
        ]
        if band_index == 0:
            images.insert(0, image_as_base64(metadata))
        start_row = band_index * 10 + 1
        batches.append((start_row, start_row + 9, images))
    return batches


def recognize_batch(start_row: int, end_row: int, images: list[str]) -> dict[str, Any]:
    metadata_note = (
        "Image 1 is the form metadata, image 2 is the enlarged left table, and image 3 is the enlarged analysis table."
        if len(images) == 3
        else "Image 1 is the enlarged left table and image 2 is the enlarged analysis table."
    )
    prompt = f"""
Read printed COC row numbers {start_row} through {end_row} only. {metadata_note}
Both table images repeat the column header above the same ten-row band.

Return every populated row in this range once, keyed by its printed No.
sampleIdRaw must be the exact visible handwriting from that cell, including a
leading hyphen when only a suffix is written. Do not expand or complete it.
Read every depth decimal and every vial digit independently. Do not output
placeholder words or replace multi-digit values with "1". analyses must contain
only columns with a clearly visible handwritten circle, O, check, or filled
mark in that exact row. A row confidence may exceed 0.8 only when its
Sample ID, depth, vial, and analysis marks are all clear.

Return JSON only. Empty metadata fields are allowed.
""".strip()
    response = ollama_json(
        "/api/chat",
        {
            "model": MODEL,
            "stream": False,
            "think": False,
            "format": BATCH_SCHEMA,
            "messages": [{"role": "user", "content": prompt, "images": images}],
            "options": {"temperature": 0, "seed": start_row, "num_ctx": 8192, "num_predict": 4096},
            "keep_alive": "15m",
        },
        timeout=OLLAMA_TIMEOUT,
    )
    content = response.get("message", {}).get("content", "")
    if not content:
        raise RuntimeError(f"{start_row}-{end_row}행에서 Ollama가 빈 응답을 반환했습니다.")
    return parse_model_json(content)


def expand_sample_ids(rows: list[dict[str, Any]]) -> None:
    raw_values = [
        re.sub(r"[–—~～]+", "-", re.sub(r"\s+", "", str(row.get("sampleIdRaw", "")).strip()))
        for row in rows
    ]
    counts = Counter(raw_values)
    site_parts: list[str] = []
    point_width = 0
    for raw in raw_values:
        parts = [part for part in raw.split("-") if part]
        if len(parts) >= 3:
            site_parts = parts[:-2]
            point_match = re.fullmatch(r"([A-Za-z]+)(\d+)", parts[-2])
            point_width = len(point_match.group(2)) if point_match else 0
            break
    if not site_parts:
        repeated_base = next(
            (
                raw
                for raw in raw_values
                if counts[raw] > 1 and not raw.startswith("-") and len([part for part in raw.split("-") if part]) >= 2
            ),
            "",
        )
        if repeated_base:
            parts = [part for part in repeated_base.split("-") if part]
            site_parts = parts[:-1]
            point_match = re.fullmatch(r"([A-Za-z]+)(\d+)", parts[-1])
            point_width = len(point_match.group(2)) if point_match else 0
    occurrences: Counter[str] = Counter()
    current_point = ""
    current_sequence = 0
    for row in rows:
        raw = re.sub(r"\s+", "", str(row.pop("sampleIdRaw", row.get("sampleId", ""))).strip())
        raw = re.sub(r"[–—~～]+", "-", raw)
        if not raw:
            row["sampleId"] = ""
            continue
        if raw.endswith("-") and not raw.startswith("-") and current_point:
            current_sequence += 1
            full = f"{current_point}-{current_sequence}"
            row["confidence"] = min(float(row.get("confidence", 0) or 0), 0.35)
        elif raw.startswith("-"):
            suffix_match = re.search(r"\d+$", raw)
            if current_point and suffix_match:
                current_sequence = int(suffix_match.group())
                full = f"{current_point}-{current_sequence}"
            elif current_point:
                current_sequence += 1
                full = f"{current_point}-{current_sequence}"
                row["confidence"] = min(float(row.get("confidence", 0) or 0), 0.35)
            else:
                full = raw.lstrip("-")
                row["confidence"] = min(float(row.get("confidence", 0) or 0), 0.25)
        else:
            parts = [part for part in raw.split("-") if part]
            begins_with_site = bool(site_parts and parts[: len(site_parts)] == site_parts)
            point_only = begins_with_site and len(parts) == len(site_parts) + 1
            if not begins_with_site and site_parts and len(parts) == 2:
                point_match = re.fullmatch(r"([A-Za-z]+)(\d+)", parts[0])
                if point_match and point_width:
                    parts[0] = f"{point_match.group(1)}{point_match.group(2).zfill(point_width)}"
                parts = [*site_parts, *parts]
            base = "-".join(parts)
            if point_only or counts[raw] > 1:
                occurrences[base] += 1
                current_point = base
                current_sequence = occurrences[base]
                full = f"{base}-{current_sequence}"
                if counts[raw] > 1:
                    row["confidence"] = min(float(row.get("confidence", 0) or 0), 0.55)
            else:
                full = base
                full_parts = [part for part in full.split("-") if part]
                if len(full_parts) >= 2:
                    current_point = "-".join(full_parts[:-1])
                    sequence_match = re.fullmatch(r"\d+", full_parts[-1])
                    current_sequence = int(sequence_match.group()) if sequence_match else 0
        row["sampleId"] = full


def normalize_result(result: dict[str, Any]) -> dict[str, Any]:
    normalized_samples: list[dict[str, Any]] = []
    allowed = set(ANALYSIS_ITEMS)
    for index, raw in enumerate(result.get("samples", []), start=1):
        if not isinstance(raw, dict):
            continue
        sample_id = str(raw.get("sampleId", "")).strip()
        if not sample_id:
            continue
        analyses = raw.get("analyses", [])
        if not isinstance(analyses, list):
            analyses = []
        try:
            confidence = float(raw.get("confidence", 0))
        except (TypeError, ValueError):
            confidence = 0
        depth = str(raw.get("depth", "")).strip()
        vial = str(raw.get("vial", "")).strip()
        if vial and not re.fullmatch(r"\d+(?:\s*[,/+-]\s*\d+)*", vial):
            vial = ""
            confidence = min(confidence, 0.35)
        if not re.fullmatch(r"[A-Za-z0-9가-힣/_.()+-]{4,}", sample_id) or sample_id.endswith("-"):
            confidence = min(confidence, 0.4)
        if depth and not re.fullmatch(r"\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?", depth):
            confidence = min(confidence, 0.4)
        if vial and not analyses:
            confidence = min(confidence, 0.45)
        normalized_samples.append(
            {
                "no": str(raw.get("no", index)),
                "sampleId": re.sub(r"\s*-\s*", "-", sample_id),
                "depth": depth,
                "sampleDate": str(raw.get("sampleDate", "")).strip(),
                "matrix": str(raw.get("matrix", "")).strip(),
                "container": str(raw.get("container", "")).strip(),
                "vial": vial,
                "analyses": list(dict.fromkeys(str(item).strip() for item in analyses if str(item).strip() in allowed)),
                "comment": str(raw.get("comment", "")).strip(),
                "confidence": max(0.0, min(1.0, confidence)),
            }
        )
    return {
        "projectName": str(result.get("projectName", "")).strip(),
        "area": str(result.get("area", "")).strip(),
        "laboratory": str(result.get("laboratory", "")).strip(),
        "manager": str(result.get("manager", "")).strip(),
        "samples": normalized_samples,
        "_meta": {"provider": "ollama", "model": MODEL},
    }


def run_ocr(image_base64: str) -> dict[str, Any]:
    global MODEL
    if not MODEL:
        MODEL = select_vision_model()
    merged: dict[str, Any] = {
        "projectName": "",
        "area": "",
        "laboratory": "",
        "manager": "",
        "samples": [],
    }
    rows_by_number: dict[int, dict[str, Any]] = {}
    for start_row, end_row, images in prepare_batch_images(image_base64):
        batch = recognize_batch(start_row, end_row, images)
        for key in ("projectName", "area", "laboratory", "manager"):
            if not merged[key] and str(batch.get(key, "")).strip():
                merged[key] = str(batch[key]).strip()
        for fallback_no, row in enumerate(batch.get("samples", []), start=start_row):
            if not isinstance(row, dict):
                continue
            number_match = re.search(r"\d+", str(row.get("no", "")))
            number = int(number_match.group()) if number_match else fallback_no
            if start_row <= number <= end_row:
                row["no"] = str(number)
                rows_by_number[number] = row
    rows = [rows_by_number[number] for number in sorted(rows_by_number)]
    expand_sample_ids(rows)
    merged["samples"] = rows
    return normalize_result(merged)


class CocOcrHandler(BaseHTTPRequestHandler):
    server_version = "LocalCocOcr/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        sys.stdout.write(f"[COC OCR] {self.address_string()} - {format_string % args}\n")
        sys.stdout.flush()

    def end_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "허용되지 않은 요청 출처입니다."})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            try:
                ollama_json("/api/tags", timeout=5)
                self.send_json(
                    HTTPStatus.OK,
                    {"ok": True, "service": "local-coc-ocr", "model": MODEL, "ollama": OLLAMA_URL},
                )
            except Exception as error:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": str(error)})
            return
        if path in {"/", "/integrated_field_forms.html"}:
            if not APP_HTML.exists():
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "integrated_field_forms.html 파일이 없습니다."})
                return
            body = APP_HTML.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/api/coc-ocr":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "허용되지 않은 요청 출처입니다."})
            return
        if REQUEST_TOKEN:
            expected = f"Bearer {REQUEST_TOKEN}"
            if self.headers.get("Authorization", "") != expected:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "유효한 접속 토큰이 필요합니다."})
                return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "요청 크기가 허용 범위를 벗어났습니다."})
            return
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "올바른 JSON 요청이 아닙니다."})
            return
        image = payload.get("image", "") if isinstance(payload, dict) else ""
        match = _DATA_URL_RE.match(str(image))
        if not match:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "JPG, PNG 또는 WEBP data URL 이미지가 필요합니다."})
            return
        try:
            image_bytes = base64.b64decode(match.group(2), validate=True)
        except (ValueError, binascii.Error):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "이미지 base64 데이터가 올바르지 않습니다."})
            return
        if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "이미지가 비어 있거나 너무 큽니다."})
            return
        try:
            result = run_ocr(match.group(2))
            self.send_json(HTTPStatus.OK, result)
        except json.JSONDecodeError as error:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": f"모델 JSON 해석 실패: {error}"})
        except Exception as error:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": str(error)})


def main() -> None:
    global MODEL
    print(f"[COC OCR] Ollama 확인 중: {OLLAMA_URL}", flush=True)
    MODEL = select_vision_model()
    print(f"[COC OCR] vision 모델: {MODEL}", flush=True)
    try:
        server = ThreadingHTTPServer((HOST, PORT), CocOcrHandler)
    except OSError as error:
        print(
            f"[COC OCR] 서버 포트 {PORT}를 열 수 없습니다: {error}\n"
            "이미 서버가 실행 중이면 기존 창을 사용하고, 그렇지 않으면 포트 사용 프로그램을 확인해 주세요.",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(1) from error
    print(f"[COC OCR] 서버 실행: http://{HOST}:{PORT}", flush=True)
    print(f"[COC OCR] OCR API: http://{HOST}:{PORT}/api/coc-ocr", flush=True)
    print("[COC OCR] 종료하려면 Ctrl+C를 누르세요.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("\n[COC OCR] 서버를 종료했습니다.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as startup_error:
        print(f"[COC OCR] 시작 실패: {startup_error}", file=sys.stderr, flush=True)
        raise SystemExit(1) from startup_error
