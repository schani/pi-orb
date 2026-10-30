# Native adapter/E2E fixtures match Cloud SQL PostgreSQL and pg_textsearch.
FROM postgres:17.11-bookworm@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5 AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc make libc6-dev postgresql-server-dev-17=17.11-1.pgdg12+2 \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:5d49f047c7e926a99f863d8af9d7800b9989ebb84c42f827ad81dac746a0b9e8 https://github.com/timescale/pg_textsearch/releases/download/v1.3.1/pg_textsearch-1.3.1.tar.gz /tmp/source.tar.gz
RUN mkdir /tmp/source \
    && tar -xzf /tmp/source.tar.gz -C /tmp/source --strip-components=1 \
    && make -C /tmp/source -j2 PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config with_llvm=no \
    && make -C /tmp/source install PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config with_llvm=no DESTDIR=/tmp/install

FROM postgres:17.11-bookworm@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5
COPY --from=builder /tmp/install/usr/lib/postgresql/17/lib/pg_textsearch.so /usr/lib/postgresql/17/lib/pg_textsearch.so
COPY --from=builder /tmp/install/usr/share/postgresql/17/extension/ /usr/share/postgresql/17/extension/
CMD ["postgres", "-c", "shared_preload_libraries=pg_textsearch"]
