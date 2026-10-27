package dev.harbor.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.SystemClock;
import android.text.Editable;
import android.text.Spanned;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.k2fsa.sherpa.onnx.SpeechSegment;
import com.k2fsa.sherpa.onnx.Vad;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

/** Dictation in the composer, the desktop's mic (src/voice.rs). The phone records (16 kHz mono)
 *  and Silero VAD (Asr) cuts it into phrases at pauses; each phrase goes to the hub
 *  (POST /v1/transcribe, the hub picks the PC that transcribes) and its words appear in the text
 *  while you talk, in order, where the cursor was. When the PC doesn't answer within a few
 *  seconds, fails, or is still downloading its model, the phone's own offline model (Asr) takes
 *  the phrase. It listens until the mic is tapped again (a minute without speech also ends it);
 *  then, if the hub's "Clean up dictation" is on, the words are cleaned up there once
 *  (POST /v1/voice/cleanup) and replace what was dictated, unless it was edited meanwhile. A hub
 *  before 0.55 (404 on GET /v1/voice) gets the whole dictation when you stop, uncleaned. A
 *  phone whose ABI the APK has no sherpa-onnx library for records the whole dictation for the PC.
 *  Asks for the microphone the first time. Never sends anything by itself. Log tag: HarborVoice. */
final class Voice {
    static final int PERMISSION = 44;
    /** (code, label): the language setting (Settings › Dictation), kept on this phone. */
    static final String[][] LANGS = {{"auto", "The phone's language"}, {"en", "English"}, {"pt", "Portuguese"}};
    private static final String TAG = Asr.TAG;
    /** Listening ends after this long without speech. */
    private static final long IDLE_MS = 60_000;

    private final Activity a;
    private final Hub hub;
    private final EditText edit;
    /** The strip over the composer's buttons while it listens. */
    final LinearLayout strip;
    private final TextView time, said;
    private final Meter meter;
    Runnable onState;

    /** Recording (until stop), then finishing (phrases still out, then the cleanup). */
    private volatile boolean recording;
    private boolean busy;
    private long started, lastTap;
    /** Bumped per dictation: late work of an old one does nothing. */
    private volatile int gen;
    /** Phrases sent and not back yet; the dictation is done when the recording ended and this is 0. */
    private final AtomicInteger out = new AtomicInteger();
    private boolean recorded;
    /** Phrases are transcribed one at a time, in order (shared by every composer). */
    private static final ExecutorService work = Executors.newSingleThreadExecutor();
    /** GET /v1/voice at the start (null: an older hub, or unreachable); `probed` once it answered
     *  or failed. A 404 is a hub before 0.55: its whisper.cpp gets the whole dictation at the
     *  end (a process per request would be too slow per phrase), and nothing is cleaned up. */
    private volatile JSONObject info;
    private volatile java.util.concurrent.CountDownLatch probed;
    private volatile boolean oldHub;
    /** An older hub's phrases, kept for the end. */
    private final java.util.List<float[]> held = new java.util.ArrayList<>();
    /** PC failures in a row: after two, the phone's model takes the rest of the dictation. */
    private volatile int hubFails;
    private volatile String problem;
    /** A problem was shown this dictation (once is enough). */
    private boolean told;
    /** Where the words go: grows with each phrase. And what was dictated, for the cleanup. */
    private Object mark;
    private final StringBuilder dictated = new StringBuilder();

    Voice(Activity a, Hub hub, EditText edit) {
        this.a = a;
        this.hub = hub;
        this.edit = edit;
        strip = Ui.row(a);
        strip.setGravity(Gravity.CENTER_VERTICAL);
        strip.setPadding(Ui.dp(14), Ui.dp(2), Ui.dp(10), Ui.dp(4));
        View dot = new View(a);
        dot.setBackground(Ui.round(Ui.RED, 0, 5));
        strip.addView(dot, new LinearLayout.LayoutParams(Ui.dp(10), Ui.dp(10)));
        time = Ui.text(a, "0:00", 14, Ui.G700);
        time.setTypeface(android.graphics.Typeface.MONOSPACE);
        strip.addView(time, Ui.margins(new LinearLayout.LayoutParams(-2, -2), 8, 0, 8, 0));
        meter = new Meter(a);
        strip.addView(meter, new LinearLayout.LayoutParams(Ui.dp(40), Ui.dp(22)));
        said = Ui.text(a, "Listening…", 14, Ui.G700);
        said.setSingleLine(true);
        said.setEllipsize(android.text.TextUtils.TruncateAt.START);
        strip.addView(said, Ui.margins(new LinearLayout.LayoutParams(0, -2, 1), 10, 0, 0, 0));
        strip.setVisibility(View.GONE);
    }

    boolean active() { return recording || busy; }

    static String lang(Context c) { return Ui.prefs(c).getString("voice_lang", "auto"); }

    static String langLabel(Context c) {
        String l = lang(c);
        for (String[] x : LANGS) if (x[0].equals(l)) return x[1];
        return LANGS[0][1];
    }

    private static String langParam(Context c) { String l = lang(c); return "auto".equals(l) ? "" : l; }

    /** The mic button: start, or stop (the last phrase is still transcribed). */
    void toggle() {
        long now = SystemClock.uptimeMillis();
        if (now - lastTap < 400) return;
        lastTap = now;
        if (recording) { stop(); return; }
        if (busy) return;
        if (a.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            a.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, PERMISSION);
            return;
        }
        start();
    }

    /** Call from onRequestPermissionsResult. */
    void permission(int req, int[] granted) {
        if (req != PERMISSION) return;
        if (granted.length > 0 && granted[0] == PackageManager.PERMISSION_GRANTED) start();
        else Ui.toast(a, "Dictation needs the microphone: allow it in the phone's settings for Harbor");
    }

    private void show(boolean on) {
        strip.setVisibility(on ? View.VISIBLE : View.GONE);
        if (on) { started = System.currentTimeMillis(); said.setText("Listening…"); tick(); }
        if (onState != null) onState.run();
    }

    private void tick() {
        if (strip.getVisibility() != View.VISIBLE) return;
        long s = (System.currentTimeMillis() - started) / 1000;
        time.setText(s / 60 + ":" + (s % 60 < 10 ? "0" : "") + s % 60);
        Ui.main.postDelayed(this::tick, 250);
    }

    private void log(String m) { Log.d(TAG, "[" + gen + "] " + m); }

    // ---- recording ----

    private void start() {
        final AudioRecord r;
        try {
            int min = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            r = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 16000));
            r.startRecording();
        } catch (Exception e) {
            Ui.toast(a, "Couldn't record: " + e.getMessage());
            return;
        }
        gen++;
        final int g = gen;
        recording = true;
        recorded = false;
        busy = true;
        hubFails = 0;
        problem = null;
        told = false;
        info = null;
        oldHub = false;
        synchronized (held) { held.clear(); }
        final java.util.concurrent.CountDownLatch p = probed = new java.util.concurrent.CountDownLatch(1);
        out.set(0);
        dictated.setLength(0);
        // The words go where the cursor is, and grow from there.
        Editable e = edit.getText();
        int at = edit.getSelectionStart();
        if (at < 0 || at > e.length()) at = e.length();
        if (mark != null) e.removeSpan(mark);
        mark = new Object();
        e.setSpan(mark, at, at, Spanned.SPAN_MARK_POINT);
        show(true);
        final boolean phrases = Asr.available();
        log("start, phrases " + phrases + ", offline model " + (Asr.ready(a) ? "ready" : "none"));
        Ui.pool.execute(() -> {
            try { info = hub.call("GET", "/v1/voice", null, 5000); log("hub voice " + info); }
            catch (Exception ex) {
                oldHub = ex instanceof Hub.ApiError && ((Hub.ApiError) ex).code == 404;
                log("no /v1/voice: " + ex.getMessage() + (oldHub ? " (an older hub)" : ""));
            }
            p.countDown();
        });
        Ui.pool.execute(() -> listen(r, g, phrases));
    }

    /** The recording thread: levels for the meter, phrases out of the VAD as they end. */
    private void listen(AudioRecord r, int g, boolean phrases) {
        Vad vad = null;
        if (phrases) {
            try { vad = Asr.vad(a); } catch (Throwable t) { log("no VAD: " + t); }
        }
        ByteArrayOutputStream whole = vad == null ? new ByteArrayOutputStream() : null;
        short[] buf = new short[512];
        float[] f = new float[512];
        long lastSpeech = SystemClock.uptimeMillis();
        while (recording && g == gen) {
            int n = r.read(buf, 0, buf.length);
            if (n < 0) { log("read error " + n); break; }
            if (n == 0) continue;
            double sum = 0;
            for (int i = 0; i < n; i++) { f[i] = buf[i] / 32768f; sum += f[i] * f[i]; }
            final float level = (float) Math.min(1.0, Math.sqrt(sum / n) * 6);
            Ui.main.post(() -> meter.set(level));
            if (vad != null) {
                vad.acceptWaveform(n == f.length ? f : java.util.Arrays.copyOf(f, n));
                if (vad.isSpeechDetected()) lastSpeech = SystemClock.uptimeMillis();
                drain(vad, g);
            } else if (whole.size() < 16000 * 2 * 600) {
                for (int i = 0; i < n; i++) { whole.write(buf[i] & 0xff); whole.write((buf[i] >> 8) & 0xff); }
                if (level > 0.08f) lastSpeech = SystemClock.uptimeMillis();
            }
            if (SystemClock.uptimeMillis() - lastSpeech > IDLE_MS) { log("a minute without speech"); Ui.main.post(() -> { if (g == gen) stop(); }); break; }
        }
        try { r.stop(); } catch (Exception ignored) { }
        r.release();
        if (vad != null) {
            vad.flush();
            drain(vad, g);
            vad.release();
        } else if (whole.size() > 16000) {
            final byte[] pcm = whole.toByteArray();
            out.incrementAndGet();
            work.execute(() -> phrase(pcmFloat(pcm), g));
        }
        Ui.main.post(() -> { if (g == gen) { recorded = true; maybeDone(); } });
    }

    private void drain(Vad vad, int g) {
        while (!vad.empty()) {
            SpeechSegment s = vad.front();
            vad.pop();
            final float[] samples = s.getSamples();
            log("phrase " + samples.length * 1000 / 16000 + " ms");
            out.incrementAndGet();
            work.execute(() -> phrase(samples, g));
        }
    }

    /** The user's stop (or a minute of silence): the last phrase is still transcribed. */
    private void stop() {
        if (!recording) return;
        log("stop");
        recording = false;
        said.setText("Finishing…");
    }

    /** Leaving the screen: stop listening; what was said still goes in (and into the draft). */
    void cancel() {
        if (recording) stop();
    }

    // ---- transcribing, one phrase at a time ----

    /** On `work`, in order: the PC first, the phone's own model when the PC can't. */
    private void phrase(float[] samples, int g) {
        try { probed.await(6, TimeUnit.SECONDS); } catch (InterruptedException e) { return; }
        if (oldHub) {
            synchronized (held) { held.add(samples); }
            Ui.main.post(() -> {
                if (g == gen && recording) said.setText("Recording · " + host() + " transcribes it when you stop");
                out.decrementAndGet();
                if (g == gen) maybeDone();
            });
            return;
        }
        String text = null, where = null;
        boolean local = hubFails >= 2 && Asr.ready(a);
        if (!local) {
            final byte[] w = wav(samples);
            final boolean raw = info != null;
            final long budget = 6000 + samples.length / 16;
            Ui.main.post(() -> { if (g == gen && !recording) said.setText("Transcribing on " + host() + "…"); });
            Future<JSONObject> f = Ui.pool.submit(() -> hub.transcribe(w, langParam(a), raw, (int) budget + 2000));
            try {
                JSONObject j = f.get(budget, TimeUnit.MILLISECONDS);
                text = j.optString("text", "").trim();
                where = j.optString("host", host());
                hubFails = 0;
            } catch (TimeoutException e) {
                f.cancel(true);
                hubFails++;
                problem = "The PC took too long to answer.";
                log("PC timed out");
            } catch (ExecutionException e) {
                Throwable c = e.getCause();
                if (c instanceof Hub.ApiError && ((Hub.ApiError) c).code == 409) problem = c.getMessage();
                else { hubFails++; problem = Hub.why(c); }
                log("PC failed: " + c);
            } catch (InterruptedException e) {
                return;
            }
        }
        if (text == null) {
            Ui.main.post(() -> { if (g == gen && !recording) said.setText("Transcribing on this phone…"); });
            text = Asr.transcribe(a, samples, langParam(a));
            where = "this phone";
            if (text == null) log("offline model not ready");
        }
        final String t = text, from = where;
        log("phrase → " + (t == null ? "nothing" : "\"" + t + "\" on " + from));
        Ui.main.post(() -> {
            if (t != null && !t.isEmpty()) {
                put(t);
                if (g == gen && recording) said.setText(t);
            } else if (t == null && problem != null && g == gen && !told) {
                Ui.toast(a, Asr.available() && !Asr.ready(a) ? problem + " The offline model isn't on this phone yet." : problem);
                told = true;
            }
            out.decrementAndGet();
            if (g == gen) maybeDone();
        });
    }

    private String host() {
        JSONObject i = info;
        String h = i == null ? "" : i.optString("host", "");
        return h.isEmpty() ? hub.label() : h;
    }

    /** All phrases back after the recording ended: the cleanup, then done. */
    private void maybeDone() {
        if (recording || !recorded || out.get() > 0 || !busy) return;
        final int g = gen;
        final float[][] whole;
        synchronized (held) { whole = held.toArray(new float[0][]); held.clear(); }
        if (whole.length > 0) { out.incrementAndGet(); work.execute(() -> wholeToOldHub(whole, g)); return; }
        final String text = dictated.toString().trim();
        work.execute(Asr::free);
        // The first dictation asks for the offline model (on Wi-Fi, in the background).
        if (Asr.available() && !Asr.wanted(a) && !Asr.ready(a)) Asr.want(a);
        JSONObject i = info;
        if (text.isEmpty() || i == null || !i.optBoolean("cleanup")) { done(text.isEmpty()); return; }
        said.setText("Cleaning up on " + host() + "…");
        Ui.pool.execute(() -> {
            String clean = null;
            try {
                JSONObject j = new JSONObject().put("text", text);
                clean = hub.call("POST", "/v1/voice/cleanup", j, 30_000).optString("text", "").trim();
            } catch (Exception e) { log("cleanup failed: " + e.getMessage()); }
            final String c = clean;
            Ui.main.post(() -> {
                if (g != gen) return;
                if (c != null && !c.isEmpty()) replace(text, c);
                done(false);
            });
        });
    }

    /** An older hub: the phrases as one recording (a short pause between them); the phone's
     *  model takes them one by one if the PC can't. */
    private void wholeToOldHub(float[][] phrases, int g) {
        int n = 0, gap = 16000 / 4;
        for (float[] x : phrases) n += x.length + gap;
        float[] all = new float[n];
        int at = 0;
        for (float[] x : phrases) { System.arraycopy(x, 0, all, at, x.length); at += x.length + gap; }
        Ui.main.post(() -> { if (g == gen) said.setText("Transcribing on " + host() + "…"); });
        java.util.List<String> got = new java.util.ArrayList<>();
        try {
            String t = hub.transcribe(wav(all), langParam(a), false, 180_000).optString("text", "").trim();
            log("whole dictation → \"" + t + "\" on " + host());
            got.add(t);
        } catch (Exception e) {
            problem = Hub.why(e);
            log("PC failed: " + e);
            Ui.main.post(() -> { if (g == gen) said.setText("Transcribing on this phone…"); });
            for (float[] x : phrases) {
                String t = Asr.transcribe(a, x, langParam(a));
                if (t == null) { got.clear(); break; }
                got.add(t);
            }
        }
        Ui.main.post(() -> {
            for (String t : got) if (!t.isEmpty()) put(t);
            if (got.isEmpty() && problem != null && g == gen && !told) {
                Ui.toast(a, Asr.available() && !Asr.ready(a) ? problem + " The offline model isn't on this phone yet." : problem);
                told = true;
            }
            out.decrementAndGet();
            if (g == gen) maybeDone();
        });
    }

    private void done(boolean nothing) {
        log("done" + (nothing ? ", no words" : ""));
        busy = false;
        show(false);
        if (nothing && !told && !a.isFinishing()) Ui.toast(a, "Didn't catch any words");
        problem = null;
    }

    // ---- into the text ----

    /** A phrase at the end of what was dictated, spaced from the words around it. */
    private void put(String text) {
        Editable e = edit.getText();
        int at = mark == null ? -1 : e.getSpanEnd(mark);
        if (at < 0) {
            at = e.length();
            mark = new Object();
            e.setSpan(mark, at, at, Spanned.SPAN_MARK_POINT);
        }
        boolean before = at > 0 && !Character.isWhitespace(e.charAt(at - 1));
        boolean after = at < e.length() && !Character.isWhitespace(e.charAt(at));
        e.insert(at, (before ? " " : "") + text + (after ? " " : ""));
        edit.setSelection(Math.min(e.length(), at + (before ? 1 : 0) + text.length()));
        if (dictated.length() > 0) dictated.append(' ');
        dictated.append(text);
    }

    /** The cleaned-up words in place of the dictated ones, if they weren't edited meanwhile. */
    private void replace(String was, String clean) {
        Editable e = edit.getText();
        int s = mark == null ? -1 : e.getSpanStart(mark), t = mark == null ? -1 : e.getSpanEnd(mark);
        if (s < 0 || t < s) return;
        String cur = e.subSequence(s, t).toString();
        if (!cur.trim().equals(was)) { log("edited meanwhile: no cleanup"); return; }
        int lead = cur.length() - cur.replaceAll("^\\s+", "").length();
        int trail = cur.length() - cur.replaceAll("\\s+$", "").length();
        e.replace(s + lead, t - trail, clean);
        edit.setSelection(Math.min(e.length(), s + lead + clean.length()));
        log("cleaned up");
    }

    /** {new text, cursor}: `text` put in at `at`, a space before it after a word, after it before one. */
    static String[] insertSpaced(String s, int at, String text) {
        boolean before = at > 0 && !Character.isWhitespace(s.charAt(at - 1));
        boolean after = at < s.length() && !Character.isWhitespace(s.charAt(at));
        String ins = (before ? " " : "") + text + (after ? " " : "");
        return new String[]{s.substring(0, at) + ins + s.substring(at), String.valueOf(at + ins.length() - (after ? 1 : 0))};
    }

    // ---- audio ----

    private static float[] pcmFloat(byte[] pcm) {
        float[] f = new float[pcm.length / 2];
        for (int i = 0; i < f.length; i++) f[i] = (short) ((pcm[2 * i] & 0xff) | (pcm[2 * i + 1] << 8)) / 32768f;
        return f;
    }

    /** 16-bit PCM WAV, mono 16 kHz: what /v1/transcribe takes. */
    static byte[] wav(float[] samples) {
        byte[] pcm = new byte[samples.length * 2];
        for (int i = 0; i < samples.length; i++) {
            int v = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768f)));
            pcm[2 * i] = (byte) v;
            pcm[2 * i + 1] = (byte) (v >> 8);
        }
        return wav(pcm, 16000);
    }

    static byte[] wav(byte[] pcm, int rate) {
        ByteArrayOutputStream o = new ByteArrayOutputStream(44 + pcm.length);
        int data = pcm.length;
        o.write("RIFF".getBytes(), 0, 4); le32(o, 36 + data); o.write("WAVEfmt ".getBytes(), 0, 8);
        le32(o, 16); le16(o, 1); le16(o, 1); le32(o, rate); le32(o, rate * 2); le16(o, 2); le16(o, 16);
        o.write("data".getBytes(), 0, 4); le32(o, data);
        o.write(pcm, 0, pcm.length);
        return o.toByteArray();
    }

    private static void le32(ByteArrayOutputStream o, int v) { for (int i = 0; i < 4; i++) o.write((v >> (8 * i)) & 0xff); }
    private static void le16(ByteArrayOutputStream o, int v) { o.write(v & 0xff); o.write((v >> 8) & 0xff); }

    /** Five bars rising with the level, the middle ones highest. */
    static final class Meter extends View {
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private float level;

        Meter(Context c) { super(c); p.setStrokeCap(Paint.Cap.ROUND); }

        void set(float l) { level = level * 0.4f + l * 0.6f; invalidate(); }

        @Override protected void onDraw(Canvas c) {
            float w = getWidth() / 9f, h = getHeight();
            float[] shape = {0.55f, 0.8f, 1f, 0.8f, 0.55f};
            p.setStrokeWidth(w);
            for (int i = 0; i < 5; i++) {
                float x = w / 2 + i * w * 2;
                float v = Math.min(1f, level * shape[i]);
                float bar = Math.max(w, h * (0.18f + 0.82f * v));
                p.setColor(v > 0.06f ? Ui.RED : Ui.G500);
                c.drawLine(x, (h - bar) / 2 + w / 2, x, (h + bar) / 2 - w / 2, p);
            }
        }
    }
}
