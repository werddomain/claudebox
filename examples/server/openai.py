import json
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(message)s")

# --- Structured output test ---

response = requests.post(
    "http://localhost:3000/v1/chat/completions",
    headers={
        "Authorization": f"Bearer <OPENROUTER_API_KEY>",
        "Content-Type": "application/json",
    },
    json={
        "model": "haiku",
        "messages": [
            {"role": "user", "content": "What is the weather like in London?"},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "weather",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "location": {
                            "type": "string",
                            "description": "City or location name",
                        },
                        "temperature": {
                            "type": "number",
                            "description": "Temperature in Celsius",
                        },
                        "conditions": {
                            "type": "string",
                            "description": "Weather conditions description",
                        },
                    },
                    "required": ["location", "temperature", "conditions"],
                    "additionalProperties": False,
                },
            },
        },
    },
)

data = response.json()
content = json.loads(data["choices"][0]["message"]["content"])
logging.info("=== Structured Output Test ===")
logging.info(json.dumps(content, indent=2))

# --- Image understanding test ---
# Generate a 200x200 solid red PNG in memory (API rejects very small images)
import base64
import io
import struct
import zlib


def make_red_png(width: int = 200, height: int = 200) -> str:
    """Create a solid red PNG and return its base64 encoding."""

    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        c = chunk_type + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw_rows = b""
    for _ in range(height):
        raw_rows += b"\x00" + (b"\xff\x00\x00" * width)  # filter=None, RGB red

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(raw_rows))
    png += chunk(b"IEND", b"")

    return base64.b64encode(png).decode()


IMG_BASE64 = make_red_png()

response = requests.post(
    "http://localhost:3000/v1/chat/completions",
    headers={
        "Content-Type": "application/json",
    },
    json={
        "model": "haiku",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Describe this image in one sentence. What color is it?",
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{IMG_BASE64}",
                        },
                    },
                ],
            },
        ],
    },
)

data = response.json()
logging.info("\n=== Image Understanding Test ===")
logging.info("Status: %s", response.status_code)
logging.info("Response: %s", data["choices"][0]["message"]["content"])
