FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

ARG APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn
ARG BUBBLEWRAP_VERSION=0.12.0-1~deb13u1

RUN sed -i \
        -e "s|https\?://deb.debian.org/debian|${APT_MIRROR}/debian|g" \
        -e "s|https\?://security.debian.org/debian-security|${APT_MIRROR}/debian-security|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        "bubblewrap=${BUBBLEWRAP_VERSION}" coreutils passwd libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(stat -c '%a' /usr/bin/bwrap)" = 755 \
    && test -z "$(getcap /usr/bin/bwrap)" \
    && useradd --uid 10001 --create-home --shell /bin/sh phase0 \
    && mkdir -p /phase0-source \
    && printf 'bubblewrap-bind-ok\n' > /phase0-source/sentinel.txt \
    && chown -R 10001:10001 /phase0-source

COPY smoke.sh /usr/local/bin/bubblewrap-phase0-smoke
RUN chmod 0755 /usr/local/bin/bubblewrap-phase0-smoke

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/bubblewrap-phase0-smoke"]
