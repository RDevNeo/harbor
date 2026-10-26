//! Images and videos an agent shows in a reply: `![caption](path-or-url)` in its text, or the
//! `show_media` tool. This finds them in a reply, resolves where they are (an absolute path, a
//! path relative to the chat's folder, `file://`, `~/`, or an https URL downloaded into a cache)
//! and decides what may be shown: only real image and video files (by extension AND by their
//! first bytes), within a size cap, never inside key folders like `~/.ssh`. The desktop
//! (chat.rs, images.rs) and the phone API (api.rs `/v1/image`, `/v1/media`) both go through it.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const IMAGE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
pub const VIDEO_EXTS: [&str; 3] = ["mp4", "webm", "mov"];
/// Largest image and video Harbor shows or serves.
pub const MAX_IMAGE: u64 = 40 << 20;
pub const MAX_VIDEO: u64 = 200 << 20;
/// At most this many media per reply.
const MAX_PER_TEXT: usize = 8;
/// Folders whose files are never shown, whatever their name says.
const PRIVATE: [&str; 7] = [".ssh", ".gnupg", ".password-store", ".aws", ".kube", ".docker", ".netrc"];

/// One image or video a card shows.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Media {
    /// A local absolute path (for an https URL: where its download is cached).
    pub path: String,
    pub caption: String,
    pub video: bool,
    /// Shown on purpose (markdown image or `show_media`): drawn large. Otherwise a file the
    /// text only names, drawn as a small thumbnail like before.
    pub shown: bool,
    /// The https URL it came from.
    pub url: Option<String>,
}

impl Media {
    /// What to call it: the caption, else the file's (or URL's) name.
    pub fn name(&self) -> String {
        let src = self.url.as_deref().unwrap_or(&self.path);
        let src = src.split(['?', '#']).next().unwrap_or(src);
        src.rsplit('/').find(|s| !s.is_empty()).unwrap_or(src).to_string()
    }
}

fn ext(path: &str) -> String {
    let p = path.split(['?', '#']).next().unwrap_or(path);
    Path::new(p).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// Some(false) for an image name, Some(true) for a video, None otherwise.
pub fn kind(path: &str) -> Option<bool> {
    let e = ext(path);
    if IMAGE_EXTS.contains(&e.as_str()) {
        Some(false)
    } else if VIDEO_EXTS.contains(&e.as_str()) {
        Some(true)
    } else {
        None
    }
}

pub fn is_video(path: &str) -> bool {
    kind(path) == Some(true)
}

pub fn is_svg(path: &str) -> bool {
    ext(path) == "svg"
}

pub fn mime(path: &str) -> &'static str {
    match ext(path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------- finding

/// `![caption](target)` images in markdown (not in code), as (caption, target).
pub fn refs(md: &str) -> Vec<(String, String)> {
    use pulldown_cmark::{Event as E, Options, Parser, Tag, TagEnd};
    if !md.contains("![") {
        return vec![];
    }
    let mut out = vec![];
    let mut cur: Option<(String, String)> = None;
    for ev in Parser::new_ext(md, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH) {
        match ev {
            E::Start(Tag::Image { dest_url, .. }) => cur = Some((String::new(), dest_url.to_string())),
            E::Text(t) | E::Code(t) => {
                if let Some((cap, _)) = &mut cur {
                    cap.push_str(&t);
                }
            }
            E::End(TagEnd::Image) => out.extend(cur.take().map(|(c, d)| (c.trim().to_string(), d))),
            _ => {}
        }
    }
    out
}

/// The text without its `![…](…)` images (they're drawn as media, not as text).
pub fn strip_refs(md: &str) -> std::borrow::Cow<'_, str> {
    use pulldown_cmark::{Event as E, Options, Parser, Tag};
    if !md.contains("![") {
        return md.into();
    }
    let mut cut: Vec<std::ops::Range<usize>> = vec![];
    for (ev, r) in Parser::new_ext(md, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH).into_offset_iter() {
        if let E::Start(Tag::Image { dest_url, .. }) = &ev {
            // Only what Harbor shows instead; other images stay as written.
            if kind(dest_url).is_some() {
                cut.push(r);
            }
        }
    }
    if cut.is_empty() {
        return md.into();
    }
    let mut out = String::with_capacity(md.len());
    let mut at = 0;
    for r in cut {
        if r.start >= at {
            out.push_str(&md[at..r.start]);
            at = r.end;
        }
    }
    out.push_str(&md[at..]);
    out.into()
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `p` without `.` and `..` (and no file system access).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// Where a markdown target is on this PC: None for what can't be shown (http, data:, a
/// relative path without a folder or one that leaves it, a name that isn't media).
pub fn resolve(target: &str, cwd: Option<&Path>) -> Option<(String, Option<String>)> {
    let t = target.trim().trim_start_matches('<').trim_end_matches('>').trim();
    kind(t)?;
    if t.starts_with("https://") {
        return Some((cache_path(t).to_string_lossy().into_owned(), Some(t.to_string())));
    }
    if t.contains("://") && !t.starts_with("file://") {
        return None;
    }
    let path = if let Some(rest) = t.strip_prefix("file://") {
        // file:///abs or file://localhost/abs
        let rest = rest.strip_prefix("localhost").unwrap_or(rest);
        PathBuf::from(pct_decode(rest))
    } else if let Some(rest) = t.strip_prefix("~/") {
        crate::store::home().join(rest)
    } else if t.starts_with('/') {
        PathBuf::from(t)
    } else {
        // Relative to the chat's folder, and inside it.
        let cwd = cwd?;
        let joined = normalize(&cwd.join(pct_decode(t)));
        let inside = match (joined.canonicalize(), cwd.canonicalize()) {
            (Ok(j), Ok(c)) => j.starts_with(&c),
            _ => joined.starts_with(normalize(cwd)),
        };
        if !inside {
            return None;
        }
        joined
    };
    if !path.is_absolute() {
        return None;
    }
    let path = normalize(&path);
    allowed(&path).then(|| (path.to_string_lossy().into_owned(), None))
}

/// Not in a folder of keys (by the path as written and as it really is).
pub fn allowed(p: &Path) -> bool {
    let private = |p: &Path| p.components().any(|c| matches!(c, Component::Normal(n) if PRIVATE.iter().any(|x| n == *x))) || ["/proc", "/sys", "/dev"].iter().any(|d| p.starts_with(d));
    kind(&p.to_string_lossy()).is_some() && !private(p) && !p.canonicalize().is_ok_and(|c| private(&c) || kind(&c.to_string_lossy()).is_none())
}

/// The media a text shows (markdown images, resolved against `cwd`) and the local media files
/// it names (absolute or `~/` paths that exist), shown ones first.
pub fn find(text: &str, cwd: Option<&Path>) -> Vec<Media> {
    let mut out: Vec<Media> = vec![];
    for (caption, target) in refs(text) {
        if let Some((path, url)) = resolve(&target, cwd) {
            if let Some(u) = &url {
                fetch(u);
            }
            if !out.iter().any(|m| m.path == path) {
                out.push(Media { video: is_video(&path), path, caption, shown: true, url });
            }
        }
        if out.len() == MAX_PER_TEXT {
            return out;
        }
    }
    let lower = text.to_ascii_lowercase();
    if !IMAGE_EXTS.iter().chain(VIDEO_EXTS.iter()).any(|e| lower.contains(&format!(".{e}"))) {
        return out;
    }
    let mut named = 0;
    // Split on what can't be part of a path here: quotes, brackets, JSON escapes, markdown.
    let tokens = text.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '(' | ')' | '<' | '>' | '[' | ']' | ',' | '=' | '\\' | '|' | '*'));
    for tok in tokens {
        let tok = tok.trim_end_matches(['.', ':', ';', '!', '?']);
        let tok = tok.strip_prefix("file://").unwrap_or(tok);
        if kind(tok).is_none() {
            continue;
        }
        let path = match tok.strip_prefix("~/") {
            Some(rest) => crate::store::home().join(rest),
            None if tok.starts_with('/') => PathBuf::from(tok),
            None => continue,
        };
        let p = path.to_string_lossy().into_owned();
        if !out.iter().any(|m| m.path == p) && path.is_file() && allowed(&path) {
            out.push(Media { video: is_video(&p), path: p, caption: String::new(), shown: false, url: None });
            named += 1;
            if named == 4 || out.len() == MAX_PER_TEXT {
                break;
            }
        }
    }
    out
}

/// A `show_media` call's input as the markdown image it stands for (so it resolves the same way).
pub fn tool_markdown(input: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(input).unwrap_or_default();
    let path = v["path"].as_str().unwrap_or("");
    let caption = v["caption"].as_str().unwrap_or("").replace(['[', ']', '\n'], " ");
    format!("![{caption}](<{}>)", path.replace(['<', '>', '\n'], ""))
}

// ---------------------------------------------------------------- checking

/// Whether a file's first bytes are an image (Some(false)) or a video (Some(true)).
pub fn sniff(head: &[u8]) -> Option<bool> {
    let h = head;
    if h.starts_with(b"\x89PNG") || h.starts_with(b"\xFF\xD8\xFF") || h.starts_with(b"GIF87a") || h.starts_with(b"GIF89a") || (h.len() >= 12 && &h[..4] == b"RIFF" && &h[8..12] == b"WEBP") {
        return Some(false);
    }
    if h.starts_with(b"\x1A\x45\xDF\xA3") || (h.len() >= 8 && matches!(&h[4..8], b"ftyp" | b"moov" | b"mdat" | b"wide" | b"free" | b"skip" | b"pnot")) {
        return Some(true);
    }
    // SVG: text that opens an <svg> element.
    let text = String::from_utf8_lossy(h);
    let lower = text.trim_start_matches('\u{feff}').trim_start().to_ascii_lowercase();
    (lower.starts_with('<') && lower.contains("<svg") && !h.contains(&0)).then_some(false)
}

/// A file Harbor may show or serve: its kind (true for video), or why not.
pub fn check(path: &Path) -> Result<bool, String> {
    let s = path.to_string_lossy();
    let video = kind(&s).ok_or("not an image or video")?;
    if !path.is_absolute() || !allowed(path) {
        return Err("not a file Harbor shows".into());
    }
    let meta = std::fs::metadata(path).map_err(|_| "no such file".to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    let cap = if video { MAX_VIDEO } else { MAX_IMAGE };
    if meta.len() > cap {
        return Err(format!("too large ({} MB, at most {} MB)", meta.len() >> 20, cap >> 20));
    }
    let mut head = vec![0u8; 1024];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)).map_err(|e| e.to_string())?;
    match sniff(&head[..n]) {
        Some(v) if v == video => Ok(video),
        _ => Err(format!("its contents aren't a{}", if video { " video" } else { "n image" })),
    }
}

// ---------------------------------------------------------------- https downloads

fn cache_dir() -> PathBuf {
    crate::store::data_dir().join("media")
}

fn short_hash(s: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, s.as_bytes());
    d.as_ref()[..10].iter().map(|b| format!("{b:02x}")).collect()
}

/// Where an https image or video is kept once downloaded.
pub fn cache_path(url: &str) -> PathBuf {
    cache_dir().join(format!("{}.{}", short_hash(url), ext(url)))
}

#[derive(Clone, PartialEq)]
enum Dl {
    Running,
    Failed(String),
}

fn downloads() -> &'static Mutex<HashMap<String, Dl>> {
    static D: OnceLock<Mutex<HashMap<String, Dl>>> = OnceLock::new();
    D.get_or_init(Default::default)
}

/// Bumped when a download ends, so cached answers of `find` are looked at again.
pub static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Starts downloading `url` into its cache path unless it's there, running or failed.
pub fn fetch(url: &str) {
    let to = cache_path(url);
    if to.is_file() {
        return;
    }
    let mut d = downloads().lock().unwrap_or_else(|e| e.into_inner());
    if d.contains_key(url) {
        return;
    }
    d.insert(url.to_string(), Dl::Running);
    drop(d);
    let url = url.to_string();
    std::thread::spawn(move || {
        let r = download(&url, &to);
        let mut d = downloads().lock().unwrap_or_else(|e| e.into_inner());
        match r {
            Ok(()) => d.remove(&url),
            Err(e) => d.insert(url, Dl::Failed(e)),
        };
        GENERATION.fetch_add(1, Ordering::SeqCst);
    });
}

/// Forgets a failed download, so the next look tries again.
pub fn retry(url: &str) {
    let mut d = downloads().lock().unwrap_or_else(|e| e.into_inner());
    if matches!(d.get(url), Some(Dl::Failed(_))) {
        d.remove(url);
    }
}

/// None: the file is here (or never asked); Some(None): downloading; Some(Some(e)): failed.
pub fn download_state(url: &str) -> Option<Option<String>> {
    match downloads().lock().unwrap_or_else(|e| e.into_inner()).get(url) {
        Some(Dl::Running) => Some(None),
        Some(Dl::Failed(e)) => Some(Some(e.clone())),
        None => None,
    }
}

/// Waits (at most `wait`) for a cached download that's running to land at `path`.
pub fn wait_for(path: &Path, wait: Duration) {
    if path.is_file() || !path.starts_with(cache_dir()) {
        return;
    }
    let until = Instant::now() + wait;
    while !path.is_file() && Instant::now() < until {
        let running = downloads().lock().unwrap_or_else(|e| e.into_inner()).iter().any(|(u, s)| *s == Dl::Running && cache_path(u) == path);
        if !running {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn download(url: &str, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(cache_dir()).map_err(|e| e.to_string())?;
    let part = to.with_extension("part");
    let cap = if is_video(url) { MAX_VIDEO } else { MAX_IMAGE };
    let mut cmd = Command::new("curl");
    cmd.args(["-sSfL", "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "3", "--max-time", "120"])
        .arg("--max-filesize")
        .arg(cap.to_string())
        .arg("-o")
        .arg(&part)
        .arg("--")
        .arg(url);
    let (status, err) = run(cmd, Duration::from_secs(130))?;
    if !status {
        let _ = std::fs::remove_file(&part);
        return Err(if err.is_empty() { "download failed".into() } else { err });
    }
    let mut head = vec![0u8; 1024];
    let n = std::fs::File::open(&part).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    if sniff(&head[..n]) != Some(is_video(url)) {
        let _ = std::fs::remove_file(&part);
        return Err("not an image or video".into());
    }
    std::fs::rename(&part, to).map_err(|e| e.to_string())
}

/// Runs a command with a deadline: (succeeded, the end of its stderr).
fn run(mut cmd: Command, limit: Duration) -> Result<(bool, String), String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let t = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(s)) => {
                let mut e = String::new();
                if let Some(mut er) = child.stderr.take() {
                    let _ = er.read_to_string(&mut e);
                }
                let e = e.trim().lines().last().unwrap_or("").to_string();
                return Ok((s.success(), e));
            }
            Ok(None) if t.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("took too long".into());
            }
        }
    }
}

// ---------------------------------------------------------------- posters and SVG

/// A JPEG of a video's first moments (ffmpeg), cached; None without ffmpeg or for a bad file.
pub fn poster(video: &Path) -> Option<PathBuf> {
    check(video).ok().filter(|v| *v)?;
    let meta = std::fs::metadata(video).ok()?;
    let stamp = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let out = cache_dir().join("posters").join(format!("{}.jpg", short_hash(&format!("{}|{}|{stamp}", video.display(), meta.len()))));
    if out.is_file() {
        return Some(out);
    }
    std::fs::create_dir_all(out.parent()?).ok()?;
    let part = out.with_extension("part.jpg");
    for at in ["0.5", "0"] {
        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-v", "error", "-nostdin", "-y", "-ss", at, "-i"]).arg(video).args(["-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "4"]).arg(&part);
        if matches!(run(cmd, Duration::from_secs(20)), Ok((true, _))) && part.metadata().is_ok_and(|m| m.len() > 0) {
            std::fs::rename(&part, &out).ok()?;
            return Some(out);
        }
    }
    let _ = std::fs::remove_file(&part);
    None
}

/// An SVG drawn as a PNG at twice its own size, at most `px` on its longer side (rsvg-convert,
/// else ImageMagick); None without either.
pub fn svg_png(svg: &Path, px: u32) -> Option<Vec<u8>> {
    check(svg).ok().filter(|v| !*v)?;
    let tmp = cache_dir().join("svg").join(format!("{}-{px}.png", short_hash(&svg.to_string_lossy())));
    std::fs::create_dir_all(tmp.parent()?).ok()?;
    let mut a = Command::new("rsvg-convert");
    a.args(["-z", "2", "-o"]).arg(&tmp).arg(svg);
    let mut b = Command::new("magick");
    b.args(["-background", "none", "-density", "192"]).arg(svg).arg(format!("png:{}", tmp.display()));
    for cmd in [a, b] {
        if matches!(run(cmd, Duration::from_secs(15)), Ok((true, _))) {
            if let Ok(bytes) = std::fs::read(&tmp) {
                let _ = std::fs::remove_file(&tmp);
                // A huge drawing: down to `px`.
                return match image::load_from_memory(&bytes) {
                    Ok(img) if img.width().max(img.height()) > px => {
                        let mut out = std::io::Cursor::new(vec![]);
                        img.thumbnail(px, px).write_to(&mut out, image::ImageFormat::Png).ok()?;
                        Some(out.into_inner())
                    }
                    _ => Some(bytes),
                };
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("harbor-media-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const MP4: &[u8] = b"\0\0\0\x18ftypmp42\0\0\0\0";

    #[test]
    fn finds_markdown_images_outside_code() {
        let md = "Here ![The chart](out/chart.png) and `![no](x.png)`\n\n```\n![no](y.png)\n```\n![](<a b.mp4> \"t\")";
        assert_eq!(refs(md), [("The chart".to_string(), "out/chart.png".to_string()), (String::new(), "a b.mp4".to_string())]);
        assert_eq!(strip_refs("a ![c](x.png) b ![l](logo)"), "a  b ![l](logo)");
        assert_eq!(strip_refs("no images"), "no images");
    }

    #[test]
    fn resolves_paths_and_urls() {
        let d = tmp("resolve");
        std::fs::create_dir_all(d.join("out")).unwrap();
        std::fs::write(d.join("out/a.png"), PNG).unwrap();
        let abs = d.join("out/a.png").to_string_lossy().into_owned();
        assert_eq!(resolve("out/a.png", Some(&d)).unwrap().0, abs);
        assert_eq!(resolve("./out/../out/a.png", Some(&d)).unwrap().0, abs);
        assert_eq!(resolve(&format!("file://{}", abs.replace(' ', "%20")), None).unwrap().0, abs);
        assert_eq!(resolve(&abs, None).unwrap().0, abs);
        // Out of the chat's folder, or no folder to be relative to.
        assert!(resolve("../../etc/x.png", Some(&d)).is_none());
        assert!(resolve("out/a.png", None).is_none());
        // Only https, only media names, never key folders.
        let (p, url) = resolve("https://example.com/a/b.webp?x=1", None).unwrap();
        assert!(p.ends_with(".webp") && url.as_deref() == Some("https://example.com/a/b.webp?x=1"));
        assert!(resolve("http://example.com/b.png", None).is_none());
        assert!(resolve("data:image/png;base64,AAAA", None).is_none());
        assert!(resolve("/home/x/.ssh/id.png", None).is_none());
        assert!(resolve(&d.join("notes.txt").to_string_lossy(), None).is_none());
        // A link out of the folder doesn't count as inside it.
        std::os::unix::fs::symlink("/etc", d.join("etc")).unwrap();
        assert!(resolve("etc/x.png", Some(&d)).is_none() || !d.join("etc/x.png").exists());
    }

    #[test]
    fn checks_type_contents_and_size() {
        let d = tmp("check");
        std::fs::write(d.join("a.png"), PNG).unwrap();
        std::fs::write(d.join("v.mp4"), MP4).unwrap();
        std::fs::write(d.join("fake.png"), b"-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
        std::fs::write(d.join("pic.svg"), "<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>").unwrap();
        std::fs::write(d.join("v.webm"), PNG).unwrap();
        assert_eq!(check(&d.join("a.png")), Ok(false));
        assert_eq!(check(&d.join("v.mp4")), Ok(true));
        assert_eq!(check(&d.join("pic.svg")), Ok(false));
        assert!(check(&d.join("fake.png")).is_err());
        assert!(check(&d.join("v.webm")).is_err(), "an image named .webm isn't a video");
        assert!(check(&d.join("missing.png")).is_err());
        assert!(check(&d).is_err());
        // Over the cap: a sparse file of 41 MB.
        let big = std::fs::File::create(d.join("big.png")).unwrap();
        big.set_len(MAX_IMAGE + 1).unwrap();
        assert!(check(&d.join("big.png")).unwrap_err().contains("too large"));
    }

    #[test]
    fn find_lists_shown_media_then_named_files() {
        let d = tmp("find");
        std::fs::write(d.join("a.png"), PNG).unwrap();
        std::fs::write(d.join("v.mp4"), MP4).unwrap();
        let named = d.join("a.png").to_string_lossy().into_owned();
        let text = format!("Saved {named}.\n\n![Demo run](v.mp4)\n![gone](missing.png)");
        let m = find(&text, Some(&d));
        assert_eq!(m.len(), 3);
        assert_eq!((m[0].caption.as_str(), m[0].video, m[0].shown), ("Demo run", true, true));
        // A missing file that was shown on purpose stays (it draws as "can't load").
        assert!(m[1].path.ends_with("missing.png") && m[1].shown);
        assert_eq!((m[2].path.as_str(), m[2].shown), (named.as_str(), false));
        assert_eq!(m[0].name(), "v.mp4");
    }

    #[test]
    fn a_tool_call_reads_as_markdown() {
        assert_eq!(tool_markdown(r#"{"path":"out/a b.png","caption":"A [b]"}"#), "![A  b ](<out/a b.png>)");
        assert_eq!(refs(&tool_markdown(r#"{"path":"/x/(1).mp4"}"#)), [(String::new(), "/x/(1).mp4".to_string())]);
    }
}
