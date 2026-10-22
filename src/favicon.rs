//! Project icons: the project's own website icon (the favicon in the browser
//! tab). Resolved from the repo first (Next.js app/icon.*, public/ and static/
//! favicons, <link rel=icon> in HTML, web manifests, Tauri/Electron/Android
//! and Rust app icons, monorepo subfolders), then fetched from the project's
//! own website (package.json "homepage", CNAME, netlify/vercel domains, the
//! README's first URL) and cached under Harbor's data dir. A custom icon
//! file can override both. Runs off the UI thread; the sidebar falls back to
//! a monogram when nothing is found.

use eframe::egui;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, SystemTime};

/// Pixels per side of the decoded icon (shown at 16 points; sharp up to 2x).
const SIZE: u32 = 32;

/// The file an icon came from and its mtime, to reload it when it changes.
struct Watch {
    src: PathBuf,
    mtime: Option<SystemTime>,
    checked: Instant,
}

static WATCH: Mutex<Option<HashMap<i64, Watch>>> = Mutex::new(None);

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// True once when the icon's source file changed on disk (checked every few seconds).
pub fn changed(repo: i64) -> bool {
    let mut g = WATCH.lock().unwrap();
    let Some(w) = g.as_mut().and_then(|m| m.get_mut(&repo)) else { return false };
    if w.checked.elapsed().as_secs() < 3 {
        return false;
    }
    w.checked = Instant::now();
    let now = mtime(&w.src);
    if now == w.mtime {
        return false;
    }
    w.mtime = now;
    true
}

fn watch(repo: i64, src: Option<PathBuf>) {
    let mut g = WATCH.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    match src {
        Some(src) => {
            let mtime = mtime(&src);
            m.insert(repo, Watch { src, mtime, checked: Instant::now() });
        }
        None => {
            m.remove(&repo);
        }
    }
}

fn cache_dir() -> PathBuf {
    crate::store::data_dir().join("favicons")
}

/// The user's custom icon for a project (a copy of the file they picked).
pub fn custom_path(repo: i64) -> PathBuf {
    cache_dir().join("custom").join(repo.to_string())
}

/// Copies `file` as the project's custom icon.
pub fn set_custom(repo: i64, file: &Path) -> bool {
    let dst = custom_path(repo);
    let _ = std::fs::create_dir_all(dst.parent().unwrap());
    std::fs::copy(file, &dst).is_ok()
}

pub fn clear_custom(repo: i64) {
    let _ = std::fs::remove_file(custom_path(repo));
}

/// Resolves the project's icon (blocking: run it on a thread). `refresh`
/// re-fetches the website icon instead of using the cached one.
pub fn resolve(repo: i64, root: &Path, name: &str, refresh: bool) -> Option<egui::ColorImage> {
    let custom = custom_path(repo);
    if let Some(img) = custom.is_file().then(|| decode(&custom)).flatten() {
        watch(repo, Some(custom));
        return Some(img);
    }
    for src in local_candidates(root, name) {
        if let Some(img) = decode(&src) {
            watch(repo, Some(src));
            return Some(img);
        }
    }
    watch(repo, None);
    let domain = website(root)?;
    let file = fetch_site_icon(&domain, refresh)?;
    decode(&file)
}

/// Which icon file a project resolves to, for tests.
#[cfg(test)]
pub fn describe(root: &Path, name: &str) -> String {
    for src in local_candidates(root, name) {
        if decode(&src).is_some() {
            return src.display().to_string();
        }
    }
    match website(root) {
        Some(d) => match fetch_site_icon(&d, false).filter(|f| decode(f).is_some()) {
            Some(f) => format!("https://{d} (cached at {})", f.display()),
            None => format!("monogram (no icon at https://{d})"),
        },
        None => "monogram".into(),
    }
}

// ------------------------------------------------------------ local files

/// Folders a web or app frontend lives in, the repo root first.
fn roots(root: &Path) -> Vec<PathBuf> {
    let mut v = vec![root.to_path_buf()];
    for d in ["web", "frontend", "site", "www", "client", "app", "packages/web", "packages/app", "packages/site"] {
        let p = root.join(d);
        if p.join("package.json").is_file() || p.join("public").is_dir() || p.join("index.html").is_file() {
            v.push(p);
        }
    }
    for parent in ["apps", "packages"] {
        let Ok(rd) = std::fs::read_dir(root.join(parent)) else { continue };
        let mut subs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir() && !v.contains(p)).collect();
        // Web apps first: "web", "site", "www", "app" beat "docs", "api" and others.
        subs.sort_by_key(|p| {
            let n = p.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            let rank = ["web", "site", "www", "app", "frontend", "client"].iter().position(|x| n == *x).unwrap_or(9);
            (rank, n)
        });
        v.extend(subs);
    }
    v
}

const EXTS: [&str; 3] = ["svg", "png", "ico"];

/// Candidate icon files, best first.
fn local_candidates(root: &Path, name: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for r in roots(root) {
        let mut tier: Vec<PathBuf> = Vec::new();
        // Next.js app router (also under src/).
        for app in ["app", "src/app"] {
            for stem in ["icon", "favicon", "apple-icon"] {
                for ext in EXTS {
                    tier.push(r.join(app).join(format!("{stem}.{ext}")));
                }
            }
        }
        // public/ and static/ (Vite, CRA, Next, SvelteKit, Hugo...).
        for dir in ["public", "static", "src/assets", "assets", ""] {
            let d = r.join(dir);
            for f in ["favicon.svg", "favicon.png", "icon.svg", "icon.png", "apple-touch-icon.png", "favicon.ico"] {
                tier.push(d.join(f));
            }
            tier.extend(glob(&d, |n| (n.starts_with("icon-") || n.starts_with("favicon-")) && n.ends_with(".png")));
        }
        out.extend(best_of(tier));
        // <link rel="icon"> in HTML files, and web manifests.
        out.extend(best_of(html_icons(&r)));
        out.extend(best_of(manifest_icons(&r)));
        // Tauri, Electron, Android and desktop (Rust/egui) app icons.
        let mut app = vec![
            r.join("src-tauri/icons/icon.png"),
            r.join("src-tauri/icons/128x128@2x.png"),
            r.join("src-tauri/icons/128x128.png"),
            r.join("build/icon.png"),
            r.join("resources/icon.png"),
            r.join("assets/icon.svg"),
            r.join("assets/icon.png"),
            r.join(format!("icons/{name}.svg")),
            r.join(format!("icons/{name}.png")),
            r.join(format!("assets/{name}.svg")),
            r.join(format!("assets/{name}.png")),
        ];
        app.extend(glob(&r.join("assets"), |n| n.starts_with("icon") && (n.ends_with(".png") || n.ends_with(".svg"))));
        for dpi in ["xxxhdpi", "xxhdpi", "xhdpi"] {
            for base in ["android/app/src/main/res", "app/src/main/res"] {
                app.push(r.join(format!("{base}/mipmap-{dpi}/ic_launcher.png")));
            }
        }
        out.extend(best_of(app));
        out.extend(desktop_icons(&r));
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| p.is_file() && seen.insert(p.clone()));
    out
}

/// Files in `dir` whose (lowercase) name matches.
fn glob(dir: &Path, f: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut v: Vec<PathBuf> =
        rd.flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| f(&n.to_string_lossy().to_lowercase()))).collect();
    v.sort();
    v
}

/// The existing files of one tier, best first: SVG and the largest square
/// PNG, then other images, then .ico.
fn best_of(files: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut v: Vec<(u8, i64, usize, PathBuf)> = files
        .into_iter()
        .enumerate()
        .filter(|(_, p)| p.is_file())
        .map(|(i, p)| {
            let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let (rank, size) = match ext.as_str() {
                "svg" => (0, i64::MAX),
                "ico" => (2, 0),
                _ => match image::image_dimensions(&p) {
                    Ok((w, h)) if w == h => (0, w as i64),
                    Ok((w, h)) => (1, w.min(h) as i64),
                    Err(_) => (3, 0),
                },
            };
            (rank, -size, i, p)
        })
        .collect();
    v.sort();
    v.into_iter().map(|x| x.3).collect()
}

/// Icons from `<link rel="icon" | "shortcut icon" | "apple-touch-icon">` in
/// the folder's HTML files, resolved relative to the folder (and public/).
fn html_icons(r: &Path) -> Vec<PathBuf> {
    let mut files = glob(r, |n| n.ends_with(".html"));
    for d in ["public", "src", "static"] {
        files.extend(glob(&r.join(d), |n| n == "index.html"));
    }
    let mut v = Vec::new();
    for f in files {
        let Ok(html) = std::fs::read_to_string(&f) else { continue };
        for href in link_icons(&html) {
            if href.contains("://") || href.starts_with("//") || href.starts_with("data:") {
                continue;
            }
            v.extend(local_href(r, f.parent().unwrap_or(r), &href));
        }
    }
    v
}

/// A site-relative href as files: relative to the HTML file, the root, or
/// the public/static folder (where bundlers serve "/" from).
fn local_href(r: &Path, base: &Path, href: &str) -> Vec<PathBuf> {
    let href = href.split(['?', '#']).next().unwrap_or("");
    if href.contains("..") || href.is_empty() {
        return vec![];
    }
    match href.strip_prefix('/') {
        Some(abs) => ["", "public", "static"].iter().map(|d| r.join(d).join(abs)).collect(),
        None => vec![base.join(href), r.join("public").join(href)],
    }
}

/// hrefs of icon `<link>`s, in document order.
fn link_icons(html: &str) -> Vec<String> {
    let lower = html.to_lowercase();
    let mut v = Vec::new();
    let mut at = 0;
    while let Some(i) = lower[at..].find("<link") {
        let start = at + i;
        let end = lower[start..].find('>').map_or(lower.len(), |e| start + e);
        let tag = &html[start..end];
        let rel = attr(tag, "rel").unwrap_or_default().to_lowercase();
        if rel.split_whitespace().any(|w| w == "icon" || w == "apple-touch-icon") {
            if let Some(h) = attr(tag, "href") {
                v.push(h);
            }
        }
        at = end;
    }
    v
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let mut at = 0;
    while let Some(i) = lower[at..].find(name) {
        let p = at + i;
        at = p + name.len();
        let before = lower[..p].chars().last();
        if !before.is_some_and(|c| c.is_whitespace()) {
            continue;
        }
        let rest = lower[at..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let off = tag.len() - rest.len();
        let val = tag[off..].trim_start();
        let q = val.chars().next()?;
        return Some(if q == '"' || q == '\'' {
            val[1..].split(q).next()?.to_string()
        } else {
            val.split(|c: char| c.is_whitespace() || c == '>').next()?.to_string()
        });
    }
    None
}

/// Icons listed in manifest.json / site.webmanifest.
fn manifest_icons(r: &Path) -> Vec<PathBuf> {
    let mut v = Vec::new();
    for d in ["", "public", "static", "app"] {
        for f in ["manifest.json", "site.webmanifest", "manifest.webmanifest"] {
            let p = r.join(d).join(f);
            let Ok(s) = std::fs::read_to_string(&p) else { continue };
            let Ok(j) = serde_json::from_str::<serde_json::Value>(&s) else { continue };
            for icon in j["icons"].as_array().into_iter().flatten() {
                if let Some(src) = icon["src"].as_str() {
                    if !src.contains("://") {
                        v.extend(local_href(r, p.parent().unwrap_or(r), src));
                    }
                }
            }
        }
    }
    v
}

/// `Icon=` of .desktop files in the folder (and its packaging dirs): a path,
/// or an icon name looked up inside the repo.
fn desktop_icons(r: &Path) -> Vec<PathBuf> {
    let mut files = glob(r, |n| n.ends_with(".desktop"));
    for d in ["assets", "data", "packaging", "dist", "resources"] {
        files.extend(glob(&r.join(d), |n| n.ends_with(".desktop")));
    }
    let mut v = Vec::new();
    for f in files {
        let Ok(s) = std::fs::read_to_string(&f) else { continue };
        let Some(icon) = s.lines().find_map(|l| l.strip_prefix("Icon=")).map(str::trim) else { continue };
        if icon.contains('/') {
            v.push(f.parent().unwrap_or(r).join(icon));
        } else {
            for d in ["", "assets", "icons", "data", "resources"] {
                for ext in ["svg", "png"] {
                    v.push(r.join(d).join(format!("{icon}.{ext}")));
                }
            }
        }
    }
    best_of(v)
}

// ------------------------------------------------------------ decoding

/// Decodes a PNG/ICO/JPEG/WebP/GIF or SVG file into a SIZE x SIZE square.
pub fn decode(p: &Path) -> Option<egui::ColorImage> {
    let bytes = std::fs::read(p).ok()?;
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_lowercase();
    let is_svg = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("svg")) || head.contains("<svg") || head.starts_with("<?xml");
    let img = if is_svg { image::load_from_memory(&rasterize_svg(p)?).ok()? } else { image::load_from_memory(&bytes).ok()? };
    let img = img.to_rgba8();
    if img.width() == 0 || img.height() == 0 {
        return None;
    }
    // Fit into a transparent square.
    let s = img.width().max(img.height());
    let mut sq = image::RgbaImage::new(s, s);
    image::imageops::overlay(&mut sq, &img, ((s - img.width()) / 2) as i64, ((s - img.height()) / 2) as i64);
    let out = if s == SIZE { sq } else { image::imageops::resize(&sq, SIZE, SIZE, image::imageops::FilterType::Lanczos3) };
    Some(egui::ColorImage::from_rgba_unmultiplied([SIZE as usize, SIZE as usize], out.as_raw()))
}

/// SVG to PNG bytes with rsvg-convert (librsvg), else ImageMagick.
fn rasterize_svg(p: &Path) -> Option<Vec<u8>> {
    let px = (SIZE * 2).to_string();
    let run = |cmd: &mut std::process::Command| cmd.output().ok().filter(|o| o.status.success() && !o.stdout.is_empty()).map(|o| o.stdout);
    run(std::process::Command::new("rsvg-convert").args(["-w", &px, "-h", &px, "-a"]).arg(p))
        .or_else(|| run(std::process::Command::new("magick").args(["-background", "none", "-density", "384"]).arg(p).args(["-resize", &format!("{px}x{px}"), "png:-"])))
}

// ------------------------------------------------------------ website

/// The project's own website domain, from its config files.
fn website(root: &Path) -> Option<String> {
    let read = |f: &str| std::fs::read_to_string(root.join(f)).ok();
    if let Some(j) = read("package.json").and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
        if let Some(d) = j["homepage"].as_str().and_then(domain_of) {
            return Some(d);
        }
    }
    for f in ["CNAME", "public/CNAME", "static/CNAME", "docs/CNAME"] {
        if let Some(d) = read(f).and_then(|s| s.lines().next().and_then(domain_of)) {
            return Some(d);
        }
    }
    if let Some(j) = read("vercel.json").and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
        let alias = j["alias"].as_str().or_else(|| j["alias"].as_array().and_then(|a| a.first()).and_then(|v| v.as_str()));
        if let Some(d) = alias.and_then(domain_of) {
            return Some(d);
        }
    }
    if let Some(s) = read("netlify.toml") {
        // A redirect's `from = "https://example.com/*"` names the site's domain.
        if let Some(d) = s.lines().filter_map(|l| l.split_once("https://").map(|x| x.1)).find_map(domain_of) {
            return Some(d);
        }
    }
    let readme = ["README.md", "readme.md", "README"].iter().find_map(|f| read(f))?;
    first_url(&readme).and_then(|u| domain_of(&u))
}

/// Hosts that are never a project's own website.
const NOT_SITES: [&str; 22] = [
    "github.com", "githubusercontent.com", "gitlab.com", "bitbucket.org", "shields.io", "npmjs.com", "npmjs.org", "crates.io",
    "docs.rs", "pypi.org", "localhost", "127.0.0.1", "0.0.0.0", "example.com", "vercel.com", "netlify.com", "nextjs.org",
    "vitejs.dev", "vite.dev", "badge.fury.io", "travis-ci.org", "codecov.io",
];

/// The host of a URL (or bare domain), unless it's a third-party site.
fn domain_of(s: &str) -> Option<String> {
    let s = s.trim();
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")).unwrap_or(s);
    let host = rest.split(['/', '?', '#', ':', '"', '\'', ')', '*']).next()?.trim().to_lowercase();
    let ok = host.contains('.')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && !NOT_SITES.iter().any(|n| host == *n || host.ends_with(&format!(".{n}")));
    ok.then_some(host)
}

fn first_url(text: &str) -> Option<String> {
    let i = text.find("https://").or_else(|| text.find("http://"))?;
    let u: String = text[i..].chars().take_while(|c| !c.is_whitespace() && !matches!(c, ')' | ']' | '>' | '"' | '\'' | '`')).collect();
    Some(u)
}

/// The site's icon file, cached under favicons/<domain> for a week (a
/// <domain>.none marker remembers that it has none). Only fetches from
/// `domain` itself.
fn fetch_site_icon(domain: &str, refresh: bool) -> Option<PathBuf> {
    let dir = cache_dir();
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join(domain);
    let none = dir.join(format!("{domain}.none"));
    let fresh = |p: &Path| mtime(p).is_some_and(|t| t.elapsed().is_ok_and(|e| e.as_secs() < 7 * 86400));
    if !refresh {
        if fresh(&file) {
            return Some(file);
        }
        if fresh(&none) {
            return None;
        }
    }
    let base = format!("https://{domain}");
    let curl = |url: &str, out: &Path| {
        std::process::Command::new("curl")
            .args(["-sfL", "--max-time", "8", "--max-filesize", "2000000", "--proto", "=https", "-o"])
            .arg(out)
            .arg(url)
            .status()
            .is_ok_and(|s| s.success())
    };
    // The page's <link rel=icon>, if it points at this domain, then /favicon.ico.
    let mut urls = Vec::new();
    let page = dir.join(format!("{domain}.html"));
    if curl(&format!("{base}/"), &page) {
        let html = std::fs::read_to_string(&page).unwrap_or_default();
        for href in link_icons(&html) {
            let url = if href.starts_with("https://") {
                href.clone()
            } else if href.starts_with("//") || href.starts_with("data:") || href.contains("://") {
                continue;
            } else if href.starts_with('/') {
                format!("{base}{href}")
            } else {
                format!("{base}/{href}")
            };
            if domain_of(&url).as_deref() == Some(domain) {
                urls.push(url);
            }
        }
    }
    let _ = std::fs::remove_file(&page);
    urls.push(format!("{base}/favicon.ico"));
    let tmp = dir.join(format!("{domain}.part"));
    for url in urls {
        if curl(&url, &tmp) && decode(&tmp).is_some() {
            let _ = std::fs::rename(&tmp, &file);
            let _ = std::fs::remove_file(&none);
            return Some(file);
        }
    }
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::write(&none, "");
    file.is_file().then_some(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_links() {
        let html = r#"<head><link rel="stylesheet" href="a.css"><LINK REL='shortcut icon' HREF='/fav.ico'><link href="/i.svg" rel="icon" type="image/svg+xml"></head>"#;
        assert_eq!(link_icons(html), vec!["/fav.ico", "/i.svg"]);
    }

    #[test]
    fn domains() {
        assert_eq!(domain_of("https://Spok.app/path?x").as_deref(), Some("spok.app"));
        assert_eq!(domain_of("https://img.shields.io/badge"), None);
        assert_eq!(domain_of("http://localhost:3000"), None);
        assert_eq!(domain_of("www.example.org").as_deref(), Some("www.example.org"));
    }

    /// Prints what the user's projects resolve to: `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_projects() {
        let db = rusqlite::Connection::open_with_flags(
            crate::store::data_dir().join("harbor.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let mut q = db.prepare("SELECT path, name FROM repos").unwrap();
        let rows: Vec<(String, String)> = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().flatten().collect();
        for (path, name) in rows {
            println!("{name}: {}", describe(Path::new(&path), &name));
        }
    }
}
