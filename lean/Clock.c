/* Independent raw elapsed clock for calibrating Lean's monotonic trace timestamps.
 * No Lean runtime symbol or installed toolchain is replaced. */
#include <lean/lean.h>
#if defined(__linux__) && __SIZEOF_LONG__ == 8
/* leanc's bundled Linux sysroot supplies lean.h but not POSIX headers. Linux's
 * 64-bit clock_gettime ABI and clock IDs are shared by x86_64 and aarch64. */
struct lsp_timespec { long tv_sec; long tv_nsec; };
extern int clock_gettime(int clock, struct lsp_timespec *now);

LEAN_EXPORT lean_obj_res lsp_raw_nanos_now(lean_obj_arg world) {
    (void)world;
    struct lsp_timespec now;
    if (clock_gettime(4 /* CLOCK_MONOTONIC_RAW */, &now) != 0)
        lean_internal_panic("CLOCK_MONOTONIC_RAW is unavailable");
    uint64_t nanos = (uint64_t)now.tv_sec * UINT64_C(1000000000) + (uint64_t)now.tv_nsec;
    /* BaseIO's impossible error alternative is erased; its extern returns Nat directly. */
    return lean_uint64_to_nat(nanos);
}
#else
/* The native driver still links on other hosts; it advertises Lean's clock there. */
extern lean_obj_res lean_io_mono_nanos_now(lean_obj_arg world);
LEAN_EXPORT lean_obj_res lsp_raw_nanos_now(lean_obj_arg world) {
    return lean_io_mono_nanos_now(world);
}
#endif
