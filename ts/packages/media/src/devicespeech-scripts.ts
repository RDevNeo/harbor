/** What Harbor puts on an SSH device that transcribes (devicespeech.ts): the speech worker and its setup script, run there as "sh -s". */

/** The worker's protocol and files; a device with another version is set up again (in the background). */
export const WORKER_VERSION = "1";

/** Python, run in ~/.harbor-voice/venv: Parakeet TDT 0.6B v3 on MLX (Apple Silicon) or sherpa-onnx (int8, CPU). */
export const WORKER_PY = String.raw`# Harbor's speech worker on an SSH device: reads requests on stdin, answers one JSON line each on stdout.
# A request is a JSON line; "transcribe" is followed by "bytes" bytes of 16 kHz mono s16le audio.
# It exits after "keep" seconds without a request (the model leaves memory with it), or when stdin closes.
import json, os, select, sys, time

VERSION = "1"
ROOT = os.path.dirname(os.path.abspath(__file__))
RATE = 16000
os.environ["HF_HUB_OFFLINE"] = "1"

def engine_name():
    try:
        with open(os.path.join(ROOT, "engine")) as f:
            return f.read().strip()
    except OSError:
        return ""

ENGINE = engine_name()
MODEL_NAME = {"mlx": "parakeet-mlx", "onnx": "parakeet-onnx"}.get(ENGINE, ENGINE)
model = None

def load():
    global model
    if model is not None:
        return False
    import numpy as np
    if ENGINE == "mlx":
        import mlx.core as mx
        import parakeet_mlx.parakeet as pk
        from parakeet_mlx import from_pretrained
        m = from_pretrained(os.path.join(ROOT, "models", "parakeet-mlx"))
        def run(pcm):
            audio = mx.array(pcm)
            # The library's own chunking for long recordings, fed from memory instead of a file.
            pk.load_audio = lambda *_a, **_k: audio
            return m.transcribe("-", chunk_duration=120.0, overlap_duration=15.0).text
        model = run
    elif ENGINE == "onnx":
        import sherpa_onnx
        d = os.path.join(ROOT, "models", "parakeet-onnx") + "/"
        threads = max(1, min(4, os.cpu_count() or 1))
        rec = sherpa_onnx.OfflineRecognizer.from_transducer(encoder=d + "encoder.int8.onnx", decoder=d + "decoder.int8.onnx", joiner=d + "joiner.int8.onnx", tokens=d + "tokens.txt", num_threads=threads, model_type="nemo_transducer")
        def one(piece):
            s = rec.create_stream()
            s.accept_waveform(RATE, piece)
            rec.decode_stream(s)
            return s.result.text.strip()
        def run(pcm):
            return " ".join(t for t in (one(p) for p in pieces(pcm, np)) if t)
        model = run
    else:
        raise RuntimeError("not set up (no engine)")
    model(np.zeros(RATE // 2, dtype=np.float32))
    return True

def pieces(pcm, np):
    # Under 30 s whole; longer cut near 25 s at the quietest 100 ms within 3 s of it.
    out, start, n = [], 0, len(pcm)
    while n - start > 30 * RATE:
        want = start + 25 * RATE
        lo, hi = want - 3 * RATE, want + 3 * RATE
        win = RATE // 10
        best, cut = None, want
        for at in range(lo, hi - win, win // 2):
            e = float(np.mean(pcm[at:at + win] ** 2))
            if best is None or e < best:
                best, cut = e, at + win // 2
        out.append(pcm[start:cut])
        start = cut
    out.append(pcm[start:])
    return out

def say(obj):
    sys.stdout.buffer.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
    sys.stdout.buffer.flush()

def main():
    keep = float(sys.argv[1]) if len(sys.argv) > 1 else 300.0
    if len(sys.argv) > 2 and sys.argv[2] == "--check":
        t = time.time()
        load()
        say({"ok": True, "model": MODEL_NAME, "ms": int((time.time() - t) * 1000)})
        return
    say({"hello": 1, "version": VERSION, "engine": MODEL_NAME})
    buf = bytearray()
    fd = sys.stdin.fileno()
    def fill(deadline):
        while True:
            left = None if deadline is None else deadline - time.time()
            if left is not None and left <= 0:
                return False
            r, _, _ = select.select([fd], [], [], left)
            if not r:
                return False
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                sys.exit(0)
            buf.extend(chunk)
            return True
    while True:
        while b"\n" not in buf:
            if not fill(time.time() + keep if not buf else None):
                sys.exit(0)
        line, _, rest = bytes(buf).partition(b"\n")
        del buf[: len(line) + 1]
        try:
            req = json.loads(line)
        except ValueError:
            say({"ok": False, "error": "bad request"})
            continue
        op = req.get("op")
        n = int(req.get("bytes", 0)) if op == "transcribe" else 0
        while len(buf) < n:
            fill(None)
        data = bytes(buf[:n])
        del buf[:n]
        t = time.time()
        try:
            cold = load()
            if op == "warm":
                say({"ok": True, "op": "warm", "model": MODEL_NAME, "cold": cold, "ms": int((time.time() - t) * 1000)})
            elif op == "transcribe":
                import numpy as np
                pcm = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
                text = model(pcm).strip() if len(pcm) >= RATE // 10 else ""
                say({"ok": True, "text": text, "model": MODEL_NAME, "cold": cold, "ms": int((time.time() - t) * 1000)})
            else:
                say({"ok": False, "error": "unknown op"})
        except Exception as e:
            say({"ok": False, "error": str(e) or type(e).__name__})

if __name__ == "__main__":
    main()`;

/** POSIX sh: everything under ~/.harbor-voice (uv, its own Python, the model), no sudo. Prints "step: …", then "done: <engine>" or "error: …". */
const SETUP_TEMPLATE = String.raw`# Sets up Harbor's speech worker in ~/.harbor-voice on this machine (run by Harbor as "ssh <device> sh -s").
# No sudo, nothing outside ~/.harbor-voice; "rm -rf ~/.harbor-voice" removes it all.
set -eu
R="$HOME/.harbor-voice"
VERSION=1
UV_VERSION=0.13.7
step() { echo "step: $*"; }
fail() { echo "error: $*"; exit 3; }
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ENGINE=mlx; T=aarch64-apple-darwin; UV_SHA=81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731 ;;
  Darwin-x86_64) ENGINE=onnx; T=x86_64-apple-darwin; UV_SHA=20c47e4c1f630b8abaff8c291fa9b9aa300fef92c4fbff95adf198b55287cda7 ;;
  Linux-x86_64) ENGINE=onnx; T=x86_64-unknown-linux-gnu; UV_SHA=c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83 ;;
  Linux-aarch64) ENGINE=onnx; T=aarch64-unknown-linux-gnu; UV_SHA=71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc ;;
  *) fail "$(uname -s) on $(uname -m) isn't supported" ;;
esac
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2.part" "$1"; else wget -q -O "$2.part" "$1"; fi || fail "couldn't download $1"
  mv -f "$2.part" "$2"
}
# get URL FILE SIZE|- SHA256: skipped when the file is already there and right.
get() {
  if [ -f "$2" ] && { [ "$3" = - ] || [ "$(wc -c <"$2" | tr -d ' ')" = "$3" ]; } && [ "$(sha "$2")" = "$4" ]; then return 0; fi
  fetch "$1" "$2"
  [ "$(sha "$2")" = "$4" ] || { rm -f "$2"; fail "$(basename "$2") didn't download whole"; }
}
mkdir -p "$R/bin" "$R/cache" "$R/models"
free=$(df -Pk "$R" | awk 'NR==2 {print $4}')
[ -n "$free" ] && [ "$free" -gt 4000000 ] || fail "less than 4 GB free in $HOME"
export UV_CACHE_DIR="$R/cache/uv" UV_PYTHON_INSTALL_DIR="$R/python" UV_NO_CONFIG=1 UV_PYTHON_PREFERENCE=only-managed UV_NO_PROGRESS=1
if [ "$("$R/bin/uv" --version 2>/dev/null | cut -d' ' -f2)" != "$UV_VERSION" ]; then
  step "getting uv $UV_VERSION"
  get "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$T.tar.gz" "$R/cache/uv.tar.gz" - "$UV_SHA"
  tar -xzf "$R/cache/uv.tar.gz" -C "$R/cache"
  mv -f "$R/cache/uv-$T/uv" "$R/bin/uv"
  rm -rf "$R/cache/uv-$T" "$R/cache/uv.tar.gz"
fi
UV="$R/bin/uv"
if [ ! -x "$R/venv/bin/python" ]; then
  step "getting Python"
  "$UV" venv -q -p 3.12 "$R/venv" || fail "couldn't make the Python environment"
fi
step "installing the speech model's packages"
if [ "$ENGINE" = mlx ]; then
  "$UV" pip install -q -p "$R/venv/bin/python" "parakeet-mlx==0.6.0" "mlx==0.32.4" || fail "couldn't install parakeet-mlx"
  M="$R/models/parakeet-mlx"; mkdir -p "$M"
  HF=https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3/resolve/ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15
  step "getting the speech model (Parakeet TDT 0.6B v3, 2.5 GB)"
  get "$HF/config.json" "$M/config.json" 244093 f320f1292511f34ec47f513755fe20fd01dbfc09a925d42730e66059a6e1ef4c
  get "$HF/model.safetensors" "$M/model.safetensors" 2508288736 05e01c7f396c298cf7d23f61da7b504adeab698f0aaeafd9c82d198625464592
else
  "$UV" pip install -q -p "$R/venv/bin/python" "sherpa-onnx==2.0.1" "numpy<3" || fail "couldn't install sherpa-onnx"
  M="$R/models/parakeet-onnx"; mkdir -p "$M"
  HF=https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main
  step "getting the speech model (Parakeet TDT 0.6B v3 int8, 670 MB)"
  get "$HF/encoder.int8.onnx" "$M/encoder.int8.onnx" 652184281 acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247
  get "$HF/decoder.int8.onnx" "$M/decoder.int8.onnx" 11845275 179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e
  get "$HF/joiner.int8.onnx" "$M/joiner.int8.onnx" 6355277 3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3
  [ -s "$M/tokens.txt" ] || fetch "$HF/tokens.txt" "$M/tokens.txt"
fi
step "installing the worker"
cat >"$R/worker.py.new" <<'HARBOR_WORKER_PY'
@WORKER@
HARBOR_WORKER_PY
mv -f "$R/worker.py.new" "$R/worker.py"
cat >"$R/serve.new" <<'HARBOR_SERVE'
#!/bin/sh
# Harbor's speech worker (see worker.py); its errors go to serve.log.
R="$HOME/.harbor-voice"
if [ -f "$R/serve.log" ] && [ "$(wc -c <"$R/serve.log")" -gt 1000000 ]; then mv -f "$R/serve.log" "$R/serve.log.old"; fi
exec "$R/venv/bin/python" -I "$R/worker.py" "$@" 2>>"$R/serve.log"
HARBOR_SERVE
chmod +x "$R/serve.new"; mv -f "$R/serve.new" "$R/serve"
echo "$ENGINE" >"$R/engine"
step "loading the model once"
"$R/serve" 0 --check | tail -1 | grep -q '"ok": true' || fail "the model didn't load (see ~/.harbor-voice/serve.log)"
echo "$VERSION" >"$R/version"
echo "done: $ENGINE"`;

export function setupScript(): string {
  return `${SETUP_TEMPLATE.replace("@WORKER@", () => WORKER_PY)}\n`;
}
