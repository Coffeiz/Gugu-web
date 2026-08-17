FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY loopscope ./loopscope
RUN pip install --no-cache-dir .
ENV LOOPSCOPE_HOST=0.0.0.0 \
    LOOPSCOPE_PORT=4320 \
    LOOPSCOPE_DB_PATH=/data/loopscope.db
VOLUME ["/data"]
EXPOSE 4320
CMD ["loopscope"]
