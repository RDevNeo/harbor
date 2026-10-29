// NDK r23+ has no libgcc, but some dependency still asks for -lgcc: a stand-in that links
// libunwind instead (the usual fix for Android builds of Rust).
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
        std::fs::write(out.join("libgcc.a"), "INPUT(-lunwind)\n").unwrap();
        println!("cargo:rustc-link-search=native={}", out.display());
    }
}
