# @harbor/os

What Harbor asks of the operating system. Linux is the only implementation today; the plan is to give
Windows and macOS their own behind the same functions, so every feature above stays one code path.

| Module | What it answers |
|---|---|
| `proc` | processes: list, stat (state, parent, group, start, resident pages), alive by pid and start time, command line, owner, tree kill, open files, cgroup text |
| `sys` | memory, boot id, the kernel's network tables (Linux `/proc/net` format for now) |
| `libc` | flock, setenv in the C environment, dup/dup2/close, glibc's allocator controls |
| `desktop` | open a file or URL, the Downloads folder, raise Harbor's window |
| `paths` | home, XDG data/state/cache/config/runtime folders, a RAM folder |
| `platform` | which OS (`HARBOR_TEST_PLATFORM` stands in for another in tests) |

Every function answers "nothing" (undefined, null, false, an empty list) where it has no
implementation yet, so callers fall back instead of failing.

`test/boundary.test.ts` keeps the rest of `ts/` from reaching the OS directly. Calls not moved here yet
are counted per file and rule in `boundary.json`, and the counts may only go down:
`bun packages/os/test/boundary.ts` prints the current counts, `--write` saves them when none went up.
