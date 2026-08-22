FROM python:3.11-slim
ENV OMP_NUM_THREADS=6 MKL_NUM_THREADS=6 nnUNet_def_n_proc=6 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends dcm2niix
RUN pip install --no-cache-dir torch==2.4.1 torchvision==0.19.1 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir TotalSegmentator flask nibabel pillow
COPY service.py /app/service.py
WORKDIR /app
EXPOSE 8090
CMD ["python","service.py"]
