# ── Stage 1: build dependencies ──────────────────────────────────────────────
# Отдельный stage для компиляции wheels — финальный образ не тащит gcc, libpq-dev
# и кэш pip. Если зависимости не менялись, Docker переиспользует этот слой целиком.
FROM python:3.12-slim AS builder

WORKDIR /build

RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
# Минимальный образ: только runtime-зависимости, непривилегированный пользователь,
# код скопирован поверх уже установленных пакетов из builder.
FROM python:3.12-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 curl && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r wake && \
    useradd -r -g wake -d /app -s /sbin/nologin wake

WORKDIR /app

COPY --from=builder /install /usr/local
COPY backend/*.py ./
COPY backend/api/ ./api/

RUN mkdir -p /app/data && chown -R wake:wake /app

USER wake

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
