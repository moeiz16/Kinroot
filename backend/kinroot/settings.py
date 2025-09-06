"""Kinroot settings. Everything environment-specific comes from env vars (see `.env.example`)."""

from __future__ import annotations

from pathlib import Path

from kinroot.core.env import database_from_url, env_bool, env_int, env_list, env_str, load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent
load_dotenv(REPO_DIR / ".env")

ENV = env_str("DJANGO_ENV", "dev")  # dev | test | prod
IS_PROD = ENV == "prod"
DEBUG = env_bool("DJANGO_DEBUG", default=not IS_PROD)

SECRET_KEY = env_str("SECRET_KEY")
if not SECRET_KEY:
    if IS_PROD:
        raise RuntimeError("SECRET_KEY must be set when DJANGO_ENV=prod")
    SECRET_KEY = "dev-only-insecure-key-change-me-0123456789abcdef"

ALLOWED_HOSTS = env_list("ALLOWED_HOSTS", "localhost,127.0.0.1,[::1],testserver")
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS", "http://localhost:3020,http://127.0.0.1:3020")
WEB_ORIGIN = env_str("WEB_ORIGIN", "http://localhost:3020")

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "rest_framework",
    # platform (builder A)
    "accounts",
    "audit",
    "clients",
    "cases",
    "jobs",
    # domain core (builder B)
    "graph",
    "resolution",
    "screening",
    "risk",
    "monitoring",
    "assistant",
]

MIDDLEWARE = [
    "kinroot.core.middleware.RequestContextMiddleware",
    "kinroot.core.middleware.SecurityHeadersMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "kinroot.urls"
ASGI_APPLICATION = "kinroot.asgi.application"
WSGI_APPLICATION = "kinroot.wsgi.application"
APPEND_SLASH = False

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BACKEND_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": ["django.template.context_processors.request"]},
    }
]

DATA_DIR = Path(env_str("DATA_DIR", str(REPO_DIR / "data")))
DATABASES = {"default": database_from_url(env_str("DATABASE_URL", "sqlite:///data/kinroot.db"), REPO_DIR)}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

AUTH_USER_MODEL = "accounts.User"
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 12}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
]

# ── Sessions and CSRF (cookie auth for the same-origin web app; see docs/API_CONTRACT.md §Auth) ──
SESSION_ENGINE = "django.contrib.sessions.backends.db"
SESSION_COOKIE_NAME = "kr_session"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = IS_PROD
SESSION_IDLE_MINUTES = env_int("SESSION_IDLE_MINUTES", 30)  # short-lived: idle expiry, extended by /auth/refresh
SESSION_ABSOLUTE_HOURS = env_int("SESSION_ABSOLUTE_HOURS", 12)  # hard cap regardless of activity
SESSION_COOKIE_AGE = SESSION_IDLE_MINUTES * 60
SESSION_SAVE_EVERY_REQUEST = False
CSRF_COOKIE_NAME = "kr_csrf"
CSRF_COOKIE_HTTPONLY = False  # the web app reads it and echoes it in X-CSRFToken
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SECURE = IS_PROD
CSRF_HEADER_NAME = "HTTP_X_CSRFTOKEN"
CSRF_FAILURE_VIEW = "kinroot.core.errors.csrf_failure"

SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"
SECURE_SSL_REDIRECT = env_bool("SECURE_SSL_REDIRECT", default=False)
SECURE_HSTS_SECONDS = 31_536_000 if IS_PROD else 0
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https") if env_bool("BEHIND_PROXY") else None

DATA_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
MEDIA_ROOT = DATA_DIR / "uploads"  # identity documents (synthetic in the demo); never served publicly
MAX_UPLOAD_MB = env_int("MAX_UPLOAD_MB", 10)

LANGUAGE_CODE = "en-au"
TIME_ZONE = "Australia/Sydney"
USE_I18N = False
USE_TZ = True

CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "kinroot"}}

# ── Django REST framework ──
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["api.auth.KinrootSessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["kinroot.core.camel.CamelCaseJSONRenderer"],
    "DEFAULT_PARSER_CLASSES": [
        "kinroot.core.camel.CamelCaseJSONParser",
        "rest_framework.parsers.MultiPartParser",
        "rest_framework.parsers.FormParser",
    ],
    "DEFAULT_PAGINATION_CLASS": "kinroot.core.pagination.PagePagination",
    "PAGE_SIZE": 25,
    "EXCEPTION_HANDLER": "kinroot.core.errors.problem_exception_handler",
    "DEFAULT_THROTTLE_CLASSES": [
        "kinroot.core.throttling.UserOrIpRateThrottle",
        "rest_framework.throttling.ScopedRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "api": env_str("RATE_LIMIT_API", "300/min"),
        "auth": env_str("RATE_LIMIT_AUTH", "10/min"),
        "assistant": env_str("RATE_LIMIT_ASSISTANT", "20/min"),
        "upload": env_str("RATE_LIMIT_UPLOAD", "30/min"),
        "invitation": env_str("RATE_LIMIT_INVITATION", "20/min"),
    },
    "UNAUTHENTICATED_USER": None,
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
}

# ── Logging (structlog JSON in prod, console in dev) ──
LOG_LEVEL = env_str("LOG_LEVEL", "INFO")
LOG_JSON = env_bool("LOG_JSON", default=IS_PROD)
LOGGING_CONFIG = None
from kinroot.core.logging import configure_logging  # noqa: E402

configure_logging(LOG_LEVEL, json_logs=LOG_JSON)

# ── Kinroot domain settings ──
KINROOT = {
    # graph (ADR 0001, 0002)
    "GRAPH_BACKEND": env_str("GRAPH_BACKEND", "ladybug"),  # ladybug | neo4j
    "GRAPH_PATH": env_str("GRAPH_PATH", str(DATA_DIR / "graph" / "kinroot.lbug")),
    "GRAPH_WRITER": env_str("GRAPH_WRITER", "worker"),  # worker | inline (tests, seed, single-process demo)
    "GRAPH_MAX_DEPTH": env_int("GRAPH_MAX_DEPTH", 10),
    "NEO4J_URI": env_str("NEO4J_URI"),
    "NEO4J_USER": env_str("NEO4J_USER", "neo4j"),
    "NEO4J_PASSWORD": env_str("NEO4J_PASSWORD"),
    "UBO_THRESHOLD_PCT": float(env_str("UBO_THRESHOLD_PCT", "25")),
    # data sources (docs/DATA.md)
    "SANCTIONS_SOURCE": env_str("SANCTIONS_SOURCE", "bundled"),  # bundled | opensanctions
    "COMPANIES_HOUSE_SOURCE": env_str("COMPANIES_HOUSE_SOURCE", "bundled"),  # bundled | bulk | api
    "COMPANIES_HOUSE_API_KEY": env_str("COMPANIES_HOUSE_API_KEY"),
    "ABN_SOURCE": env_str("ABN_SOURCE", "mock"),  # mock | live
    "ABN_LOOKUP_GUID": env_str("ABN_LOOKUP_GUID"),
    # ML (ADR 0003, 0004)
    "MODEL_DIR": env_str("MODEL_DIR", str(BACKEND_DIR / "artifacts" / "models")),
    # Local MLflow: SQLite metadata + file artifacts under the git-ignored mlruns/ (the plain file store is in
    # maintenance mode upstream; SQLite keeps the registry and aliases working with no server).
    "MLFLOW_TRACKING_URI": env_str("MLFLOW_TRACKING_URI", f"sqlite:///{REPO_DIR / 'mlruns' / 'mlflow.db'}"),
    "MLFLOW_ARTIFACT_ROOT": env_str("MLFLOW_ARTIFACT_ROOT", str(REPO_DIR / "mlruns" / "artifacts")),
    # investigation assistant
    "LLM_FAKE": env_bool("LLM_FAKE", default=True),
    "LLM_MODEL": env_str("LLM_MODEL", "groq/llama-3.3-70b-versatile"),
    "LLM_FALLBACK_MODELS": env_list("LLM_FALLBACK_MODELS", "gemini/gemini-2.0-flash"),
    "LLM_TIMEOUT_SECONDS": env_int("LLM_TIMEOUT_SECONDS", 30),
    # jobs, events, retention
    "JOBS_POLL_SECONDS": float(env_str("JOBS_POLL_SECONDS", "1.0")),
    "JOBS_LEASE_SECONDS": env_int("JOBS_LEASE_SECONDS", 300),
    "SSE_POLL_SECONDS": float(env_str("SSE_POLL_SECONDS", "1.0")),
    "SSE_HEARTBEAT_SECONDS": env_int("SSE_HEARTBEAT_SECONDS", 15),
    "SSE_MAX_SECONDS": env_int("SSE_MAX_SECONDS", 300),  # the browser reconnects with Last-Event-ID
    "RETENTION_YEARS_DEFAULT": env_int("RETENTION_YEARS_DEFAULT", 7),
    "DATA_RESIDENCY": env_str("DATA_RESIDENCY", "AU"),
}
