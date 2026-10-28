FROM python:3.11-slim

# System dependencies for OpenCV headless and SQLite
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p uploads

ENV PORT=5001
EXPOSE 5001

CMD ["sh", "-c", "gunicorn app:app --workers 2 --bind 0.0.0.0:${PORT:-5001}"]
