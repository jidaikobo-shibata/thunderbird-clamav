#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <string.h>
#include <unistd.h>

/* Linux-only bootstrap: no shell, downloads, registration or elevated rights. */
int main(void) {
    char path[8192];
    ssize_t size = readlink("/proc/self/exe", path, sizeof(path) - 16);
    if (size < 0) { perror("ClamAV Mail Check setup"); return 1; }
    path[size] = '\0';
    char *end = strrchr(path, '/');
    if (!end) return 1;
    strcpy(end + 1, "setup.py");
    execl("/usr/bin/python3", "python3", "-B", "-I", path, (char *)NULL);
    perror("Python 3 could not be started");
    return 1;
}
