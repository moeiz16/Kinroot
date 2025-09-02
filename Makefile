# Kinroot developer tasks. Everything runs offline: no Docker, no accounts, no keys.
# Ports: web 3020 · API 8020. Run heavy targets one at a time on small machines.
PY      := backend/.venv/bin/python
MANAGE  := cd backend && .venv/bin/python manage.py
NPM     := npm --prefix frontend
export MLFLOW_DISABLE_AGENT_HINT := 1

.PHONY: help setup setup-backend setup-frontend check-omp lock dev api web web-dev worker seed reset migrate \
        makemigrations test test-backend test-frontend lint typecheck eval train data graph-smoke clean

help:            ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

setup: setup-backend setup-frontend  ## Install API + web app, create .env, migrate and seed
	@test -f .env || cp .env.example .env
	$(MAKE) migrate seed

setup-backend: check-omp  ## Create the Python 3.13 venv and install pinned dependencies
	test -d backend/.venv || python3.13 -m venv backend/.venv
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -r backend/requirements.lock
	$(PY) -m pip install -q --no-deps -e "backend[dev]"

setup-frontend:  ## Install the web app (exact versions; package-lock.json once it exists)
	@if [ -f frontend/package-lock.json ]; then $(NPM) ci; else $(NPM) install; fi

check-omp:       ## LightGBM needs the OpenMP runtime on macOS
	@if [ "$$(uname -s)" = "Darwin" ] && [ ! -f /opt/homebrew/opt/libomp/lib/libomp.dylib ] && [ ! -f /usr/local/opt/libomp/lib/libomp.dylib ]; then \
	  echo "LightGBM needs libomp on macOS: run 'brew install libomp' and re-run make setup."; exit 1; fi

lock:            ## Re-resolve and freeze backend dependencies into backend/requirements.lock
	$(PY) -m pip install -q -e "backend[dev]"
	{ echo "# Resolved backend dependency set (Python 3.13, macOS arm64 / Linux). Regenerate with: make lock"; \
	  $(PY) -m pip freeze --exclude-editable; } > backend/requirements.lock

api:             ## Run the API on :8020 (ASGI; needed for the SSE stream)
	cd backend && .venv/bin/python -m uvicorn kinroot.asgi:application --port 8020 --no-access-log

worker:          ## Run the job worker (single graph writer; see ADR 0002)
	$(MANAGE) runworker

web-dev:         ## Vite dev server on :3020 (proxies /api to :8020)
	$(NPM) run dev

web:             ## Production build of the web app, served on :3020
	$(NPM) run build && $(NPM) run preview

dev:             ## API + worker + web together (Ctrl-C stops all)
	@$(MAKE) -j3 api worker web-dev

migrate:         ## Apply database migrations
	$(MANAGE) migrate --noinput

makemigrations:  ## Create migrations for changed models
	$(MANAGE) makemigrations

seed:            ## Seed the demo firms (Harbourline Legal, Northgate Accountants); idempotent
	$(MANAGE) seed_demo

reset:           ## Drop local data (SQLite + graph), migrate and seed again
	$(MANAGE) reset_demo --yes
	$(MAKE) migrate seed

test: test-backend test-frontend  ## Run all tests

test-backend:    ## API, platform, graph and domain tests
	cd backend && .venv/bin/python -m pytest

test-frontend:   ## Web app typecheck + unit tests + production build
	cd frontend && npx tsc --noEmit && npm run test --if-present && npm run build

lint:            ## Lint and format checks (ruff, eslint)
	$(PY) -m ruff check backend scripts eval
	$(PY) -m ruff format --check backend scripts eval
	$(NPM) run lint --if-present

typecheck:       ## Static types (mypy with Django/DRF plugins, tsc)
	cd backend && .venv/bin/python -m mypy .
	cd frontend && npx tsc --noEmit

eval:            ## Evaluation gates: entity resolution, risk challenger, UBO, screening, stability -> eval/RESULTS.md
	cd backend && .venv/bin/python ../eval/run.py

train:           ## Train the entity-resolution matcher and the risk challenger (CPU, tracked in mlruns/)
	$(MANAGE) train er
	$(MANAGE) train risk

data:            ## Download the optional public data subsets into data/ (~120 MB transferred, ~50 MB kept)
	$(PY) scripts/fetch_opensanctions.py
	$(PY) scripts/fetch_companies_house.py

graph-smoke:     ## Re-verify the embedded graph engine (ADR 0001)
	$(PY) scripts/graph_smoke.py ladybug

clean:           ## Remove caches and build output (keeps data/ and the venv)
	$(PY) scripts/clean.py
