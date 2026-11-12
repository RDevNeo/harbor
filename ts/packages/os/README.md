# @harbor/os

What Harbor asks of the operating system, one code path for every feature above it. Linux reads /proc and
libc; macOS has `darwin.ts` (libproc, sysctl); Windows has `win32/` (kernel32, ntdll, user32 through
bun:ffi), loaded only there through `win32/load.ts`.

| Module | What it answers |
|---|---|
| `proc` | processes: list, stat (state, parent, group, start, resident pages), alive by pid and start time, command line, owner, tree kill, open files, cgroup text |
| `sys` | memory, boot id, the kernel's network tables (Linux `/proc/net` format for now) |
| `libc` | flock, setenv in the C environment, dup/dup2/close, glibc's allocator controls |
| `lock` | an exclusive file lock by path (flock; Windows: LockFileEx on a handle of its own, as Bun's fds aren't the C runtime's) |
| `env` | what child programs need: a locale (macOS), tool folders (Homebrew; Git Bash, Claude Code's and npm's on Windows), PATHEXT |
| `desktop` | open a file or URL, the Downloads folder, raise Harbor's window |
| `paths` | home, data/state/cache/config/runtime folders (XDG; Windows: %APPDATA%, %LOCALAPPDATA%, %LOCALAPPDATA%\Cache), a RAM folder |
| `platform` | which OS (`HARBOR_TEST_PLATFORM` stands in for another in tests) |
| `stall` | the Worker that samples a stuck main thread (state, wchan, syscall and its file), PSI, own RSS/fds/threads |

Every function answers "nothing" (undefined, null, false, an empty list) where it has no
implementation yet, so callers fall back instead of failing.

`test/boundary.test.ts` keeps the rest of `ts/` from reaching the OS directly. Calls not moved here yet
are counted per file and rule in `boundary.json`, and the counts may only go down:
`bun packages/os/test/boundary.ts` prints the current counts, `--write` saves them when none went up.
