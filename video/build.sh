#!/bin/bash
# Compiles Harbor's video engine for one architecture, in video/Dockerfile's image, from /src:
# libmpv and a small FFmpeg, LGPL only, as one shared library that needs nothing but glibc.
#   build.sh <x86_64|aarch64>   -> /out/video/<arch>/libmpv-harbor.so
#   build.sh source             -> /out/video/harbor-video-source.tar.gz and /out/video/licenses
#
# Everything is static inside it. The system's optional libraries (libva, EGL, PipeWire, PulseAudio,
# ALSA) are not linked: their symbols stay weak, Harbor loads the ones the system has before it
# loads this (src/video.rs `optional`) and turns off what they would serve when one is missing.
set -euo pipefail
what=$1
recipe=/src/video
dl=/c/video-dl
mkdir -p "$dl"

each_source() { grep -v -e '^#' -e '^$' "$recipe/sources"; }

while read -r name version file sum url; do
  [ "$(sha256sum "$dl/$file" 2>/dev/null | cut -d' ' -f1)" = "$sum" ] || curl -fsSL --retry 3 -o "$dl/$file" "$url"
  echo "$sum  $dl/$file" | sha256sum -c --quiet -
done < <(each_source)

if [ "$what" = source ]; then
  # What the LGPL asks for: the sources of what's in the library, and how to build it again.
  mkdir -p /out/video/licenses
  s=/tmp/harbor-video-source
  rm -rf /tmp/harbor-video-source && mkdir -p "$s"
  cp -r "$recipe" "$s/recipe"
  while read -r name version file sum url; do cp "$dl/$file" "$s/"; done < <(each_source)
  tar -C /tmp -czf /out/video/harbor-video-source.tar.gz harbor-video-source
  rm -rf /tmp/harbor-video-source
  while read -r name version file sum url; do
    rm -rf /tmp/video-lic && mkdir -p /tmp/video-lic
    tar -xf "$dl/$file" -C /tmp/video-lic
    d=$(ls -d /tmp/video-lic/*/ | head -1)
    for l in COPYING COPYING.LGPL COPYING.LGPLv2.1 COPYING.LGPLv3 LICENSE LICENSE.LGPL LICENSE.md LICENSE.MIT LICENSE-MIT \
             LICENSE-APACHE docs/FTL.TXT docs/LICENSE.TXT LICENSE.TXT; do
      [ ! -f "$d$l" ] || cp "$d$l" "/out/video/licenses/$name-$(basename "$l").txt"
    done
  done < <(each_source)
  rm -rf /tmp/video-lic
  cp "$recipe/NOTICE.txt" /out/video/licenses/README.txt
  ls -la /out/video/harbor-video-source.tar.gz
  exit 0
fi

arch=$what
case "$arch" in
  x86_64) host=x86_64-linux-gnu cc=gcc cxx=g++ tool="" ffarch=() ;;
  aarch64) host=aarch64-linux-gnu cc=aarch64-linux-gnu-gcc cxx=aarch64-linux-gnu-g++ tool=aarch64-linux-gnu-
           ffarch=(--enable-cross-compile --arch=aarch64 --target-os=linux --cross-prefix=aarch64-linux-gnu-) ;;
  *) echo "no engine for $arch" >&2; exit 1 ;;
esac
work=/tmp/video-$arch
pre=$work/prefix
rm -rf "/tmp/video-$arch" && mkdir -p "$pre/lib/pkgconfig" "$pre/include"
cd "$work"
unpack() { tar -xf "$dl/$(awk -v n="$1" '$1==n {print $3}' "$recipe/sources")" -C "$work"; }
export PKG_CONFIG_LIBDIR=$pre/lib/pkgconfig:/usr/lib/$host/pkgconfig:/usr/share/pkgconfig
export PKG_CONFIG_PATH=
flags="-O2 -pipe -fPIC -fvisibility=hidden -ffunction-sections -fdata-sections -fno-semantic-interposition -I$pre/include"
export CFLAGS="$flags" CXXFLAGS="$flags" LDFLAGS="-L$pre/lib"
crossfile=()
if [ "$arch" != x86_64 ]; then
  cat > cross.ini <<EOF
[binaries]
c = '$cc'
cpp = '$cxx'
ar = '${tool}ar'
strip = '${tool}strip'
pkg-config = 'pkg-config'
[host_machine]
system = 'linux'
cpu_family = 'aarch64'
cpu = 'aarch64'
endian = 'little'
EOF
  crossfile=(--cross-file "$work/cross.ini")
fi
ms() { # ms <source dir> [meson options]
  local d=$1; shift
  meson setup "$d/out" "$d" "${crossfile[@]}" --prefix="$pre" --libdir=lib --buildtype=release \
    --default-library=static --wrap-mode=nodownload "$@" >"$d.log" 2>&1 || { tail -40 "$d.log"; exit 1; }
  ninja -C "$d/out" install >>"$d.log" 2>&1 || { tail -40 "$d.log"; exit 1; }
}
s=$SECONDS
step() { echo "== $arch $1 ($((SECONDS - s)) s)"; }

step zlib; unpack zlib
(cd zlib-1.3.2 && CC=$cc ./configure --static --prefix="$pre" >/dev/null && make -s -j"$(nproc)" install >/dev/null)
step freetype; unpack freetype
ms freetype-2.15.0 -Dbrotli=disabled -Dbzip2=disabled -Dharfbuzz=disabled -Dpng=disabled -Dzlib=disabled -Dtests=disabled
step fribidi; unpack fribidi
ms fribidi-1.0.17 -Ddocs=false -Dbin=false -Dtests=false
step harfbuzz; unpack harfbuzz
ms harfbuzz-14.6.0 -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled -Dpng=disabled -Dzlib=disabled -Dicu=disabled \
   -Dfreetype=disabled -Dtests=disabled -Dintrospection=disabled -Ddocs=disabled -Dbenchmark=disabled -Dutilities=disabled
step libass; unpack libass
(cd libass-0.17.5 && ./configure --host="$host" --prefix="$pre" --enable-static --disable-shared --disable-fontconfig \
  --disable-require-system-font-provider --disable-libunibreak --disable-asm >/dev/null && make -s -j"$(nproc)" install >/dev/null)
step dav1d; unpack dav1d
ms dav1d-1.5.4 -Denable_tools=false -Denable_tests=false -Denable_docs=false -Dbitdepths="['8','16']"
step nv-codec-headers; unpack nv-codec-headers
make -s -C nv-codec-headers-n12.2.72.0 PREFIX="$pre" install >/dev/null
step pipewire-headers; unpack pipewire
# Only its headers (Ubuntu 22.04's are too old for mpv): nothing of PipeWire is compiled in.
mkdir -p "$pre/include/pipewire-0.3" "$pre/include/spa-0.2"
cp -r pipewire-0.3.65/src/pipewire "$pre/include/pipewire-0.3/"
cp -r pipewire-0.3.65/spa/include/spa "$pre/include/spa-0.2/"
sed -e 's/@PIPEWIRE_VERSION_MAJOR@/0/; s/@PIPEWIRE_VERSION_MINOR@/3/; s/@PIPEWIRE_VERSION_MICRO@/65/; s/@PIPEWIRE_API_VERSION@/0.3/' \
  pipewire-0.3.65/src/pipewire/version.h.in > "$pre/include/pipewire-0.3/pipewire/version.h"
printf 'Name: libpipewire-0.3\nDescription: headers\nVersion: 0.3.65\nCflags: -I%s/include/pipewire-0.3 -I%s/include/spa-0.2 -D_REENTRANT\nLibs:\n' \
  "$pre" "$pre" > "$pre/lib/pkgconfig/libpipewire-0.3.pc"

step ffmpeg; unpack ffmpeg
decoders=h264,hevc,vp8,vp9,av1,libdav1d,aac,aac_latm,mp3,mp3float,opus,vorbis,flac,alac,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le,pcm_mulaw,pcm_alaw
parsers=h264,hevc,vp8,vp9,av1,aac,aac_latm,mpegaudio,opus,vorbis,flac
hw=h264_vaapi,hevc_vaapi,vp8_vaapi,vp9_vaapi,av1_vaapi,h264_nvdec,hevc_nvdec,vp8_nvdec,vp9_nvdec,av1_nvdec
(cd ffmpeg-9.0.2 && ./configure --prefix="$pre" --pkg-config=pkg-config --pkg-config-flags=--static "${ffarch[@]}" \
  --cc="$cc" --cxx="$cxx" --extra-cflags="$flags" --extra-ldflags="-L$pre/lib" \
  --disable-everything --disable-autodetect --disable-programs --disable-doc --disable-debug --disable-network \
  --disable-avdevice --disable-shared --enable-static --enable-pic \
  --enable-zlib --enable-libdav1d --enable-vaapi --enable-ffnvcodec --enable-nvdec \
  --enable-decoder="$decoders" --enable-parser="$parsers" --enable-hwaccel="$hw" --enable-demuxer=mov,matroska \
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,vp9_superframe,vp9_superframe_split,av1_frame_merge,av1_frame_split,extract_extradata \
  --enable-filter=buffer,buffersink,abuffer,abuffersink,format,aformat,scale,aresample >ffconfig.log 2>&1 \
  || { tail -30 ffconfig.log ffbuild/config.log; exit 1; }
  grep -i '^license' ffconfig.log
  grep -qi '^license: lgpl' ffconfig.log || { echo "this FFmpeg isn't LGPL" >&2; exit 1; }
  make -s -j"$(nproc)" install >/dev/null)

step libplacebo; unpack libplacebo; unpack fast_float; unpack vulkan-headers
mkdir -p libplacebo-7.360.1/3rdparty/fast_float
cp -r fast_float-8.3.2/include libplacebo-7.360.1/3rdparty/fast_float/
# Only its headers: libplacebo's stubs for the Vulkan it's built without still include them.
cp -r Vulkan-Headers-*/include/vulkan Vulkan-Headers-*/include/vk_video "$pre/include/"
ms libplacebo-7.360.1 -Dvulkan=disabled -Dopengl=disabled -Dd3d11=disabled -Dglslang=disabled -Dshaderc=disabled -Dlcms=disabled \
   -Ddovi=disabled -Dlibdovi=disabled -Ddemos=false -Dtests=false

step mpv; unpack mpv
(cd mpv-0.41.0 && patch -p1 --quiet < "$recipe/vaapi-render-node.patch")
ms mpv-0.41.0 -Dauto_features=disabled -Dgpl=false -Dcplayer=false -Dlibmpv=true -Dbuild-date=false -Dvector=enabled \
   -Dzlib=enabled -Dgl=enabled -Degl=enabled -Dplain-gl=enabled -Dvaapi=enabled -Dvaapi-drm=enabled \
   -Dcuda-hwaccel=enabled -Dcuda-interop=enabled -Dalsa=enabled -Dpulse=enabled -Dpipewire=enabled
grep -E '^ +(gpl|lua|javascript|x11|wayland|vaapi[a-z-]*|pipewire|pulse|alsa|cuda[a-z-]*|egl|gl)\s*:' mpv-0.41.0/out/meson-logs/meson-log.txt | head -20 || true

step link
libs=(libmpv libavfilter libavformat libavcodec libswscale libswresample libavutil libplacebo libass libharfbuzz libfribidi libfreetype libdav1d libz)
# Optional at run time: weak, so a missing one is a null nobody calls instead of a failed load.
"${tool}nm" --undefined-only --format=just-symbols "$pre"/lib/lib*.a 2>/dev/null | sort -u \
  | grep -E '^(va[A-Z]|pa_|pw_|spa_|snd_|egl[A-Z])' > weak.list || true
find "$work/mpv-0.41.0/out" -name 'libmpv*.a' -exec "${tool}nm" --undefined-only --format=just-symbols {} + 2>/dev/null | sort -u \
  | grep -E '^(va[A-Z]|pa_|pw_|spa_|snd_|egl[A-Z])' >> weak.list || true
sort -u -o weak.list weak.list
echo "$(wc -l < weak.list) optional symbols"
archives=()
for l in "${libs[@]}"; do
  a=$pre/lib/$l.a
  [ -f "$a" ] || a=$(find "$work/mpv-0.41.0/out" -name "$l.a" | head -1)
  cp "$a" "$work/$l.weak.a"
  "${tool}objcopy" --weaken-symbols=weak.list "$work/$l.weak.a"
  archives+=("$work/$l.weak.a")
done
out=/out/video/$arch
mkdir -p "$out"
"$cxx" -shared -o "$out/libmpv-harbor.so" -Wl,-soname,libmpv-harbor.so -Wl,--version-script="$recipe/libmpv.map" \
  -Wl,--gc-sections -Wl,--no-undefined -Wl,--as-needed -Wl,-z,noexecstack -Wl,-z,relro \
  -static-libgcc -static-libstdc++ \
  -Wl,--whole-archive "${archives[0]}" -Wl,--no-whole-archive "${archives[@]:1}" -lm -ldl -lpthread
"${tool}strip" --strip-unneeded "$out/libmpv-harbor.so"

step check
"${tool}readelf" -d "$out/libmpv-harbor.so" | grep NEEDED
bad=$("${tool}readelf" -d "$out/libmpv-harbor.so" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | grep -v -E '^(libc\.so\.6|libm\.so\.6|libdl\.so\.2|libpthread\.so\.0|ld-linux.*)$' || true)
[ -z "$bad" ] || { echo "needs more than glibc: $bad" >&2; exit 1; }
# Anything undefined and not weak must be glibc's.
bad=$("${tool}nm" -D --undefined-only "$out/libmpv-harbor.so" | awk '$1 == "U" && $2 !~ /@GLIBC_/ {print $2}')
[ -z "$bad" ] || { echo "strong symbols from elsewhere: $bad" >&2; exit 1; }
new=$("${tool}nm" -D --undefined-only "$out/libmpv-harbor.so" | sed -n 's/.*@GLIBC_\([0-9.]*\).*/\1/p' | sort -V | tail -1)
echo "needs glibc $new"
"${tool}nm" -D --defined-only "$out/libmpv-harbor.so" | awk '$3 !~ /^mpv_/ && $3 !~ /^LIBMPV/ {print "exports " $3}' | head
"${tool}nm" -D --defined-only "$out/libmpv-harbor.so" | grep -q ' mpv_render_context_create' || { echo "it exports no libmpv" >&2; exit 1; }
[ "$(stat -c %s "$out/libmpv-harbor.so")" -gt 4000000 ] || { echo "far too small: something got dropped" >&2; exit 1; }
! grep -qa -e '--enable-gpl' -e '--enable-nonfree' "$out/libmpv-harbor.so" || { echo "a GPL or nonfree FFmpeg" >&2; exit 1; }
ls -la "$out"
echo "== $arch done in $((SECONDS - s)) s"
