#!/bin/sh
set -eu

printf 'bubblewrap='; bwrap --version
printf 'outer_uid='; id -u
outer_netns=$(readlink /proc/self/ns/net)

bwrap \
    --unshare-user \
    --unshare-pid \
    --unshare-ipc \
    --unshare-uts \
    --unshare-net \
    --die-with-parent \
    --ro-bind / / \
    --bind /phase0-source /workspace \
    --proc /proc \
    --dev /dev \
    --tmpfs /tmp \
    --chdir /workspace \
    --setenv BWRAP_PHASE0_EXPECTED_NETNS "$outer_netns" \
    -- /bin/sh -eu -c '
        test "$(id -u)" = 0
        test "$$" = 1
        test "$(cat /workspace/sentinel.txt)" = bubblewrap-bind-ok
        test ! -w /etc
        test "$(readlink /proc/self/ns/net)" != "$BWRAP_PHASE0_EXPECTED_NETNS"
        printf "inside_uid=%s pid=%s netns=%s\n" "$(id -u)" "$$" "$(readlink /proc/self/ns/net)"
        printf "bubblewrap phase0 smoke: PASS\n"
    '
