"""Test environment, set before Django settings load: in-memory SQLite, inline graph writer, offline LLM."""

import os

os.environ.setdefault("DJANGO_ENV", "test")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("GRAPH_WRITER", "inline")
os.environ.setdefault("LLM_FAKE", "true")
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")
