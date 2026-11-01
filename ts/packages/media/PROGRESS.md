# @harbor/media

## images, media, clipboard, picker, favicon

| Rust module | State | Rust tests ported |
| --- | --- | --- |
| media.rs | done: markdown refs/strip/parts (mdast offsets), resolve, find, sniff, check, kept copies, https downloads (curl), posters (ffmpeg), SVG (sharp/librsvg) | 6 of 6 |
| images.rs | done except egui drawing (thumbnail, strip, attachment, lightbox, inline, video card, cant_load): `Images` holds the cache, decode workers, viewer state, gallery, `widen`, remote sources; the `ui` package draws `Slot`s | 4 of 4 |
| favicon.rs | done: local candidates, HTML/manifest/desktop icons, website lookup, pinned curl fetch, 32 px square decode | 5 of 5 (`real_projects` is `#[ignore]` in Rust: a manual print of the owner's projects, not ported) |
| clipboard.rs | done except the egui plugin and `raw_input_hook`: wl-clipboard/xclip backends, copy/read/paste, notices, `shortcut()` key mapping | 2 of 2 |
| picker.rs | done except the egui toast drawing: `toast()` gives the message and time left | 1 of 1 |

Decisions
- Decoding uses `sharp` 0.35.5 (prebuilt libvips for glibc x86_64 and arm64 as optional packages, nothing compiled): PNG, JPEG, WebP, GIF first frame, EXIF rotation, SVG through librsvg, so `rsvg-convert` and ImageMagick are not needed. ICO is decoded by `ico.ts` (embedded PNG or 1/4/8/24/32-bit bitmaps) because libvips has none.
- Images come out as `Decoded`: RGBA, 8 bits, not premultiplied, for the `ui` package to turn into a Slint image.
- Markdown: `mdast-util-from-markdown` with GFM table and strikethrough (pulldown-cmark equivalents); a paragraph's offsets are extended over one trailing line end to match pulldown's ranges.
- Cache file names (kept copies, https downloads, posters, favicons) use the Rust hashes, so both apps share one cache folder.
- Downloads still go through `curl` with the Rust arguments.
