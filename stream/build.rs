//! Builds moonlight-common-c (vendored in third_party/, GPL-3.0) for the
//! GameStream backend, and links the system libraries it and the backend use:
//! OpenSSL's libcrypto/libssl, libopus and ALSA's libasound (all in /usr/lib).

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var_os("CARGO_FEATURE_GAMESTREAM").is_none() {
        return;
    }
    let root = std::path::Path::new("third_party/moonlight-common-c");
    let mut b = cc::Build::new();
    for dir in ["enet", "src"] {
        for e in std::fs::read_dir(root.join(dir)).unwrap().flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "c") && !p.ends_with("win32.c") {
                b.file(p);
            }
        }
    }
    for f in ["nanors/rs.c", "nanors/deps/obl/oblas_common.c", "nanors/deps/obl/oblas_lite.c"] {
        b.file(root.join(f));
    }
    for inc in ["enet/include", "src", "nanors", "nanors/deps", "nanors/deps/obl"] {
        b.include(root.join(inc));
    }
    for d in [
        "HAS_SOCKLEN_T", "HAS_FCNTL", "HAS_IOCTL", "HAS_POLL", "HAS_GETADDRINFO", "HAS_GETNAMEINFO",
        "HAS_INET_PTON", "HAS_INET_NTOP", "HAS_MSGHDR_FLAGS", "HAVE_CLOCK_GETTIME", "NDEBUG",
    ] {
        b.define(d, "1");
    }
    b.file("src/gamestream/shim.c");
    b.std("gnu11").warnings(false).flag_if_supported("-Wno-unused-parameter").opt_level(2);
    b.compile("moonlight-common-c");
    for lib in ["ssl", "crypto", "opus", "asound"] {
        println!("cargo:rustc-link-lib={lib}");
    }
    println!("cargo:rerun-if-changed=third_party/moonlight-common-c");
    println!("cargo:rerun-if-changed=src/gamestream/shim.c");
}
