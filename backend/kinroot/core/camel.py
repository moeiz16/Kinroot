"""camelCase on the wire, snake_case in Python.

Keys are converted recursively in both directions. Values are never touched, and keys under a dict whose key
is listed in `OPAQUE_KEYS` are left as-is (free-form maps such as feature vectors or graphology attributes
already use the wire spelling).
"""

from __future__ import annotations

import re
from typing import Any

from rest_framework.parsers import JSONParser
from rest_framework.renderers import JSONRenderer

_CAMEL_RE = re.compile(r"_([a-z0-9])")
_SNAKE_RE = re.compile(r"(?<=[a-z0-9])([A-Z])")
OPAQUE_KEYS = frozenset({"features", "attributes", "metadata", "settings_raw"})


def to_camel(name: str) -> str:
    if "_" not in name or name.startswith("_"):
        return name
    return _CAMEL_RE.sub(lambda m: m.group(1).upper(), name)


def to_snake(name: str) -> str:
    return _SNAKE_RE.sub(lambda m: "_" + m.group(1).lower(), name)


def camelize(data: Any) -> Any:
    if isinstance(data, dict):
        return {to_camel(str(k)): (v if str(k) in OPAQUE_KEYS else camelize(v)) for k, v in data.items()}
    if isinstance(data, list | tuple):
        return [camelize(v) for v in data]
    return data


def snakeize(data: Any) -> Any:
    if isinstance(data, dict):
        return {to_snake(str(k)): (v if to_snake(str(k)) in OPAQUE_KEYS else snakeize(v)) for k, v in data.items()}
    if isinstance(data, list | tuple):
        return [snakeize(v) for v in data]
    return data


class CamelCaseJSONRenderer(JSONRenderer):
    charset = "utf-8"

    def render(self, data: Any, accepted_media_type: str | None = None, renderer_context: Any = None) -> bytes:
        return super().render(camelize(data), accepted_media_type, renderer_context)


class CamelCaseJSONParser(JSONParser):
    def parse(self, stream: Any, media_type: str | None = None, parser_context: Any = None) -> Any:
        return snakeize(super().parse(stream, media_type, parser_context))
