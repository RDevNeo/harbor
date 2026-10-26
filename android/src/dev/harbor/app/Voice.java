package dev.harbor.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;

/** Dictation in the composer, the desktop's mic (src/voice.rs). The phone's own recogniser
 *  (SpeechRecognizer, on-device where the phone has it) listens in place, with a level meter and
 *  the time; the words go in at the cursor, to edit before sending. A phone without a recogniser
 *  records (16 kHz WAV) and the PC transcribes it with whisper.cpp (POST /v1/transcribe). Asks
 *  for the microphone the first time. Never sends anything by itself. */
final class Voice {
    static final int PERMISSION = 44;
    /** (code, label): the language setting (Settings › Dictation), kept on this phone. */
    static final String[][] LANGS = {{"auto", "The phone's language"}, {"en", "English"}, {"pt", "Portuguese"}};

    private final Activity a;
    private final Hub hub;
    private final EditText edit;
    /** The strip over the composer's buttons while it listens. */
    final LinearLayout strip;
    private final TextView time, said;
    private final Meter meter;
    Runnable onState;

    private SpeechRecognizer sr;
    private AudioRecord rec;
    private volatile boolean recording;
    private long started;
    private boolean busy;

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

    boolean active() { return recording || sr != null || busy; }

    static String lang(Context c) { return Ui.prefs(c).getString("voice_lang", "auto"); }

    static String langLabel(Context c) {
        String l = lang(c);
        for (String[] x : LANGS) if (x[0].equals(l)) return x[1];
        return LANGS[0][1];
    }

    /** The mic button: start, or stop (and transcribe). */
    void toggle() {
        if (busy) return;
        if (sr != null) { sr.stopListening(); return; }
        if (recording) { stopRecording(); return; }
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

    private void start() {
        boolean onDevice = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(a);
        if (onDevice || SpeechRecognizer.isRecognitionAvailable(a)) listen(onDevice);
        else record();
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

    // ---- the phone's recogniser ----

    private void listen(boolean onDevice) {
        try {
            sr = onDevice && Build.VERSION.SDK_INT >= 31 ? SpeechRecognizer.createOnDeviceSpeechRecognizer(a) : SpeechRecognizer.createSpeechRecognizer(a);
        } catch (Exception e) {
            sr = null;
            record();
            return;
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L);
        String l = lang(a);
        if ("en".equals(l)) i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US");
        else if ("pt".equals(l)) i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "pt-BR");
        sr.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle b) { }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float db) { meter.set(Math.max(0f, Math.min(1f, (db + 2f) / 12f))); }
            @Override public void onBufferReceived(byte[] b) { }
            @Override public void onEndOfSpeech() { said.setText("…"); }
            @Override public void onError(int error) {
                done();
                // No words heard is not worth more than a word.
                if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) Ui.toast(a, "Didn't catch any words");
                else if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) Ui.toast(a, "Dictation needs the microphone");
                else if (error == 13 /* ERROR_LANGUAGE_UNAVAILABLE */ || error == 12 /* ERROR_LANGUAGE_NOT_SUPPORTED */) Ui.toast(a, "The phone can't recognise " + langLabel(a) + " offline: download it in the phone's voice settings, or pick another language");
                else Ui.toast(a, "Dictation stopped (recogniser error " + error + ")");
            }
            @Override public void onResults(Bundle b) {
                ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                done();
                if (r != null && !r.isEmpty()) insert(r.get(0));
            }
            @Override public void onPartialResults(Bundle b) {
                ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (r != null && !r.isEmpty() && !r.get(0).isEmpty()) said.setText(r.get(0));
            }
            @Override public void onEvent(int t, Bundle b) { }
        });
        show(true);
        sr.startListening(i);
    }

    private void done() {
        if (sr != null) { try { sr.destroy(); } catch (Exception ignored) { } sr = null; }
        show(false);
    }

    /** Leaving the screen: stop listening, keep nothing. */
    void cancel() {
        if (sr != null) { try { sr.cancel(); } catch (Exception ignored) { } done(); }
        recording = false;
        strip.setVisibility(View.GONE);
    }

    // ---- no recogniser: record, the PC transcribes ----

    private void record() {
        int rate = 16000;
        int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 6400));
            rec.startRecording();
        } catch (Exception e) {
            Ui.toast(a, "Couldn't record: " + e.getMessage());
            rec = null;
            return;
        }
        recording = true;
        show(true);
        said.setText("Recording · the PC transcribes it");
        final AudioRecord r = rec;
        Ui.pool.execute(() -> {
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            byte[] buf = new byte[3200];
            long limit = 16000L * 2 * 600;
            while (recording) {
                int n = r.read(buf, 0, buf.length);
                if (n <= 0) continue;
                if (pcm.size() < limit) pcm.write(buf, 0, n);
                double sum = 0;
                for (int i = 0; i + 1 < n; i += 2) { short v = (short) ((buf[i] & 0xff) | (buf[i + 1] << 8)); sum += (v / 32768.0) * (v / 32768.0); }
                final float level = (float) Math.min(1.0, Math.sqrt(sum / Math.max(1, n / 2)) * 6);
                Ui.main.post(() -> meter.set(level));
            }
            try { r.stop(); } catch (Exception ignored) { }
            r.release();
            byte[] wav = wav(pcm.toByteArray(), 16000);
            Ui.main.post(() -> transcribe(wav));
        });
    }

    private void stopRecording() {
        recording = false;
        busy = true;
        said.setText("Transcribing on " + hub.label() + "…");
    }

    private void transcribe(byte[] wav) {
        if (wav.length < 44 + 16000 / 2) { busy = false; show(false); Ui.toast(a, "Nothing was recorded"); return; }
        String l = lang(a);
        Ui.pool.execute(() -> {
            String text = null, err = null;
            try { text = hub.transcribe(wav, "auto".equals(l) ? "" : l); } catch (Exception e) { err = Hub.why(e); }
            final String t = text, e = err;
            Ui.main.post(() -> {
                busy = false;
                show(false);
                if (a.isFinishing()) return;
                if (e != null) Ui.toast(a, e);
                else if (t == null || t.trim().isEmpty()) Ui.toast(a, "Didn't catch any words");
                else insert(t);
            });
        });
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

    // ---- into the text ----

    /** At the cursor, spaced from the words around it (as the desktop does). */
    private void insert(String text) {
        String t = text.trim();
        if (t.isEmpty()) return;
        String s = edit.getText().toString();
        int at = edit.getSelectionStart();
        if (at < 0 || at > s.length()) at = s.length();
        String[] r = insertSpaced(s, at, t);
        edit.setText(r[0]);
        edit.setSelection(Integer.parseInt(r[1]));
        edit.requestFocus();
    }

    /** {new text, cursor}: `text` put in at `at`, a space before it after a word, after it before one. */
    static String[] insertSpaced(String s, int at, String text) {
        boolean before = at > 0 && !Character.isWhitespace(s.charAt(at - 1));
        boolean after = at < s.length() && !Character.isWhitespace(s.charAt(at));
        String ins = (before ? " " : "") + text + (after ? " " : "");
        return new String[]{s.substring(0, at) + ins + s.substring(at), String.valueOf(at + ins.length() - (after ? 1 : 0))};
    }

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
