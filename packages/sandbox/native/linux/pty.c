#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>

enum { control_fd = 3, buffer_size = 4096 };

static int dimension(const char *value, long lower, long upper) {
    char *end;
    errno = 0;
    long size = strtol(value, &end, 10);
    return errno || end == value || *end || size < lower || size > upper ? 0 : (int)size;
}

static int relay(int master) {
    unsigned char input[buffer_size], output[buffer_size], resize[4];
    size_t input_size = 0, input_at = 0, output_size = 0, output_at = 0, resize_size = 0;
    int master_done = 0;
    for (;;) {
        struct pollfd fds[] = {
            { STDIN_FILENO, input_size == 0 && !master_done ? POLLIN : 0, 0 },
            { STDOUT_FILENO, output_size ? POLLOUT : 0, 0 },
            { control_fd, POLLIN, 0 },
            { master_done || (output_size && !input_size) ? -1 : master,
                       (short)((!master_done && !output_size ? POLLIN : 0) |
                                (!master_done && input_size ? POLLOUT : 0)), 0 },
        };
        if (master_done && !output_size) return 0;
        if (poll(fds, 4, -1) < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (fds[2].revents & (POLLERR | POLLHUP | POLLNVAL)) return -1;
        if (fds[2].revents & POLLIN) {
            ssize_t n = read(control_fd, resize + resize_size, sizeof(resize) - resize_size);
            if (n <= 0) return -1;
            resize_size += (size_t)n;
            if (resize_size == sizeof(resize)) {
                struct winsize size = { .ws_row = (uint16_t)(resize[0] * 256 + resize[1]),
                                       .ws_col = (uint16_t)(resize[2] * 256 + resize[3]) };
                if (size.ws_row < 5 || size.ws_row > 200 || size.ws_col < 20 || size.ws_col > 500 ||
                    ioctl(master, TIOCSWINSZ, &size) < 0) return -1;
                resize_size = 0;
            }
        }
        if (fds[0].revents & (POLLERR | POLLHUP | POLLNVAL)) return -1;
        if (fds[1].revents & (POLLERR | POLLHUP | POLLNVAL)) return -1;
        if (fds[0].revents & POLLIN) {
            ssize_t n = read(STDIN_FILENO, input, sizeof(input));
            if (n <= 0) return -1;
            input_size = (size_t)n;
            input_at = 0;
        }
        // 缓冲区有界，避免终端输出或输入阻塞关闭与窗口尺寸更新。
        if ((fds[3].revents & POLLOUT) && input_size) {
            ssize_t n = write(master, input + input_at, input_size - input_at);
            if (n < 0 && errno != EAGAIN && errno != EINTR) return -1;
            if (n > 0 && (input_at += (size_t)n) == input_size) input_size = 0;
        }
        if (!output_size && (fds[3].revents & (POLLIN | POLLHUP | POLLERR))) {
            ssize_t n = read(master, output, sizeof(output));
            if (n <= 0 && (n == 0 || (errno != EAGAIN && errno != EINTR))) master_done = 1;
            if (n > 0) {
                output_size = (size_t)n;
                output_at = 0;
            }
        }
        if ((fds[1].revents & POLLOUT) && output_size) {
            ssize_t n = write(STDOUT_FILENO, output + output_at, output_size - output_at);
            if (n < 0 && errno != EAGAIN && errno != EINTR) return -1;
            if (n > 0 && (output_at += (size_t)n) == output_size) output_size = 0;
        }
    }
}

static int nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags == -1 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

int main(int argc, char **argv) {
    if (argc < 4 || getuid() == 0 || geteuid() != getuid()) return 125;
    int rows = dimension(argv[1], 5, 200), cols = dimension(argv[2], 20, 500);
    if (!rows || !cols) return 125;
    struct winsize size = { .ws_row = (uint16_t)rows, .ws_col = (uint16_t)cols };
    int master;
    pid_t parent = getpid();
    pid_t child = forkpty(&master, NULL, NULL, &size);
    if (child < 0) return 125;
    if (child == 0) {
        close(control_fd);
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != parent) _exit(125);
        argv[2] = "/usr/bin/bwrap";
        execv(argv[2], argv + 2);
        _exit(125);
    }
    signal(SIGPIPE, SIG_IGN);
    int result = nonblock(master) || nonblock(STDOUT_FILENO) ? -1 : relay(master);
    close(master);
    if (result < 0) kill(child, SIGKILL);
    int status;
    while (waitpid(child, &status, 0) == -1) {
        if (errno != EINTR) return 125;
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 125;
}
