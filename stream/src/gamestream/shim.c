// moonlight-common-c logs through a printf-style callback; Rust can't define
// variadic functions, so format here and hand Rust the finished line.
#include <stdarg.h>
#include <stdio.h>

void harbor_gs_log_line(const char* line);

void harbor_gs_log(const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    harbor_gs_log_line(buf);
}
