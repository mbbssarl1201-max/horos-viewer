# TotalSegmentator CPU — image volontairement sans CUDA (le VPS72 n'a pas de
# GPU) : torch CPU-only d'abord, sinon pip tirerait la variante CUDA (~6 Go).
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

# Cache des poids nnU-Net (volume conseillé pour survivre aux recreates).
ENV TOTALSEG_HOME_DIR=/models
VOLUME /models

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
