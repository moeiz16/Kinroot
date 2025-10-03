"""Test environment, set before Django settings load: in-memory SQLite, inline graph writer, offline LLM."""

import os

os.environ.setdefault("DJANGO_ENV", "test")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("GRAPH_WRITER", "inline")
os.environ.setdefault("LLM_FAKE", "true")
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")

# The embedded graph for the test session lives in a throwaway directory, never the dev file under data/.
import tempfile

os.environ.setdefault("GRAPH_PATH", os.path.join(tempfile.mkdtemp(prefix="kinroot-test-graph-"), "graph.lbug"))
os.environ.setdefault(
    "MLFLOW_TRACKING_URI", "sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="kinroot-test-mlflow-"), "mlflow.db")
)

# pytest-django may import the settings before this file runs, in which case the defaults above came too late:
# apply the test values to the loaded settings so tests never use the worker-mode graph or the dev graph file.
from django.conf import settings as _settings

_settings.KINROOT.update(
    {
        "GRAPH_WRITER": os.environ["GRAPH_WRITER"],
        "GRAPH_PATH": os.environ["GRAPH_PATH"],
        "LLM_FAKE": os.environ["LLM_FAKE"].lower() == "true",
        "MLFLOW_TRACKING_URI": os.environ["MLFLOW_TRACKING_URI"],
    }
)
