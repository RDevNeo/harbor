package dev.harbor.app;

import android.app.Activity;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** A voice message or audio file in a person's chat (the PC's AudioPlayer): play / pause, the bars (played part in
 *  ink, a tap seeks there), the position or the length, the speed (1x, 1.5x, 2x, for every audio), a dot until it is
 *  played; "Transcribe" under it (the PC's speech to text), then its text. Played here with MediaPlayer, one at a
 *  time, from a copy in the app's cache (fetched once through /v1/persons/file); stopped when the chat closes. */
final class PersonsAudio {
    private PersonsAudio() { }

    private static MediaPlayer mp;
    private static String key = "";
    private static boolean playing, prepared;
    private static float speed = 1f;
    /** A seek made before it plays (or while paused), in ms. */
    private static int pendingMs = -1;
    private static final Map<String, File> files = new HashMap<>();
    private static final Set<String> transcribing = new HashSet<>();
    private static final Set<String> playedHere = new HashSet<>();
    /** The bubble of the one playing (its bars and time move). */
    private static WeakReference<Bubble> shown = new WeakReference<>(null);

    private static final Runnable tick = new Runnable() {
        @Override public void run() {
            Bubble b = shown.get();
            if (b != null && key.equals(b.key)) b.update();
            if (playing) Ui.main.postDelayed(this, 100);
        }
    };

    /** Stops what plays (the chat closed, another person opened). */
    static void stop() {
        playing = false;
        prepared = false;
        pendingMs = -1;
        Ui.main.removeCallbacks(tick);
        if (mp != null) {
            try { mp.release(); } catch (Exception ignored) { }
            mp = null;
        }
        key = "";
        Bubble b = shown.get();
        if (b != null) b.update();
    }

    private static int posMs() {
        if (pendingMs >= 0) return pendingMs;
        if (mp != null && prepared) try { return mp.getCurrentPosition(); } catch (Exception ignored) { }
        return 0;
    }

    /** The bubble's view. `f` is the attachment (files[] of the chat's JSON), `reload` loads the chat again. */
    static View view(Activity a, Hub hub, JSONObject f, boolean mine, String account, int inner, Runnable reload) {
        return new Bubble(a, hub, f, mine, account, inner, reload).root;
    }

    private static final class Bubble {
        final Activity a;
        final Hub hub;
        final JSONObject f;
        final String key, account;
        final double durS;
        final boolean mine;
        final LinearLayout root;
        final TextView btn, time, speedChip;
        final View dot;
        final Bars bars;
        final Runnable reload;

        Bubble(Activity a, Hub hub, JSONObject f, boolean mine, String account, int inner, Runnable reload) {
            this.a = a;
            this.hub = hub;
            this.f = f;
            this.mine = mine;
            this.account = account;
            this.reload = reload;
            key = PersonsUi.s(f, "audio").isEmpty() ? PersonsUi.s(f, "url") : PersonsUi.s(f, "audio");
            durS = f.optDouble("duration", 0);
            root = Ui.col(a);
            LinearLayout row = Ui.row(a);
            row.setGravity(Gravity.CENTER_VERTICAL);
            int ink = Ui.FG;
            btn = Ui.icon(a, Ui.I_PLAY, 16, Ui.BG);
            btn.setGravity(Gravity.CENTER);
            btn.setBackground(Ui.round(ink, 0, 18));
            btn.setOnClickListener(v -> toggle());
            row.addView(btn, new LinearLayout.LayoutParams(Ui.dp(36), Ui.dp(36)));
            LinearLayout mid = Ui.col(a);
            bars = new Bars(a, bars(f), ink);
            bars.setOnTouchListener((v, e) -> {
                if (e.getAction() == MotionEvent.ACTION_UP) seek(Math.max(0, Math.min(1, e.getX() / Math.max(1, v.getWidth()))));
                return true;
            });
            mid.addView(bars, new LinearLayout.LayoutParams(Math.min(inner - Ui.dp(100), Ui.dp(190)), Ui.dp(26)));
            LinearLayout under = Ui.row(a);
            under.setGravity(Gravity.CENTER_VERTICAL);
            time = Ui.text(a, "", 12, Ui.G600);
            under.addView(time);
            dot = new View(a);
            dot.setBackground(Ui.round(Ui.BLUE, 0, 3));
            under.addView(dot, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(6), Ui.dp(6)), 6, 0, 0, 0));
            mid.addView(under, Ui.wrap());
            row.addView(mid, Ui.margins(Ui.wrap(), 10, 0, 8, 0));
            speedChip = Ui.bold(a, "", 12, Ui.FG);
            speedChip.setGravity(Gravity.CENTER);
            speedChip.setBackground(Ui.press(Ui.G100, 0, 12));
            speedChip.setPadding(Ui.dp(8), Ui.dp(3), Ui.dp(8), Ui.dp(3));
            speedChip.setOnClickListener(v -> nextSpeed());
            row.addView(speedChip, Ui.wrap());
            root.addView(row, Ui.wrap());
            String tr = PersonsUi.s(f, "transcript");
            if (!tr.isEmpty()) {
                TextView t = Ui.text(a, tr, 14, Ui.G700);
                t.setMaxWidth(inner);
                t.setTextIsSelectable(true);
                root.addView(t, Ui.margins(Ui.wrap(), 2, 6, 0, 0));
            } else {
                TextView t = Ui.text(a, transcribing.contains(key) ? "Transcribing…" : "Transcribe", 13, Ui.BLUE);
                t.setPadding(Ui.dp(2), Ui.dp(6), Ui.dp(8), Ui.dp(2));
                t.setOnClickListener(v -> transcribe(t));
                t.setContentDescription("Transcribe this audio (on the PC)");
                root.addView(t, Ui.wrap());
            }
            if (key.equals(PersonsAudio.key)) shown = new WeakReference<>(this);
            update();
        }

        void update() {
            boolean cur = key.equals(PersonsAudio.key);
            boolean on = cur && playing;
            btn.setText(on ? Ui.I_PAUSE : Ui.I_PLAY);
            btn.setContentDescription(on ? "Pause" : "Play");
            double dur = durS;
            if (cur && mp != null && prepared) try { dur = mp.getDuration() / 1000.0; } catch (Exception ignored) { }
            double pos = cur ? posMs() / 1000.0 : 0;
            bars.frac = cur && dur > 0 ? (float) Math.min(1, pos / dur) : 0f;
            bars.invalidate();
            time.setText(PersonsUi.duration(cur && (on || pos > 0) ? pos : dur));
            boolean played = f.optBoolean("played", true) || playedHere.contains(key) || mine;
            dot.setVisibility(played ? View.GONE : View.VISIBLE);
            speedChip.setText(speed >= 1.75f ? "2x" : speed >= 1.25f ? "1.5x" : "1x");
        }

        private void toggle() {
            if (key.equals(PersonsAudio.key) && mp != null) {
                if (playing) {
                    try { mp.pause(); } catch (Exception ignored) { }
                    playing = false;
                } else start();
                update();
                return;
            }
            PersonsAudio.stop();
            PersonsAudio.key = key;
            shown = new WeakReference<>(this);
            File have;
            synchronized (files) { have = files.get(key); }
            if (have != null && have.exists()) { open(have); return; }
            btn.setText(Ui.I_LOADER);
            String url = PersonsUi.s(f, "url"), name = PersonsUi.s(f, "name");
            Context c = a.getApplicationContext();
            Ui.bg(a, () -> {
                byte[] d = PersonsUi.bytes(hub, url);
                String ext = name.contains(".") ? name.substring(name.lastIndexOf('.')) : ".ogg";
                File out = new File(c.getCacheDir(), "persons-audio-" + Integer.toHexString(key.hashCode()) + ext.replaceAll("[^.\\w]", ""));
                try (FileOutputStream o = new FileOutputStream(out)) { o.write(d); }
                return out;
            }, file -> {
                synchronized (files) { files.put(key, file); }
                if (key.equals(PersonsAudio.key)) open(file);
            });
        }

        private void open(File file) {
            MediaPlayer p = new MediaPlayer();
            mp = p;
            prepared = false;
            try {
                p.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                p.setDataSource(file.getAbsolutePath());
                p.setOnPreparedListener(x -> {
                    if (mp != p) return;
                    prepared = true;
                    if (pendingMs >= 0) { try { p.seekTo(pendingMs); } catch (Exception ignored) { } pendingMs = -1; }
                    start();
                });
                p.setOnCompletionListener(x -> {
                    if (mp != p) return;
                    playing = false;
                    try { p.seekTo(0); } catch (Exception ignored) { }
                    Ui.main.removeCallbacks(tick);
                    Bubble b = shown.get();
                    if (b != null) b.update();
                });
                p.setOnErrorListener((x, w, e) -> {
                    if (mp == p) { Ui.toast(a, "Couldn't play it"); PersonsAudio.stop(); }
                    return true;
                });
                p.prepareAsync();
            } catch (Exception e) {
                Ui.toast(a, "Couldn't play it: " + e.getMessage());
                PersonsAudio.stop();
            }
        }

        private void start() {
            if (mp == null || !prepared) return;
            try {
                mp.setPlaybackParams(new PlaybackParams().setSpeed(speed));
                mp.start();
            } catch (Exception e) {
                Ui.toast(a, "Couldn't play it");
                return;
            }
            playing = true;
            Ui.main.removeCallbacks(tick);
            Ui.main.post(tick);
            if (playedHere.add(key) && !f.optBoolean("played", true)) {
                JSONObject b = PersonsUi.put(new JSONObject(), "key", key);
                Ui.pool.execute(() -> { try { hub.call("POST", "/v1/persons/audio/played", b); } catch (Exception ignored) { } });
            }
            update();
        }

        private void seek(float frac) {
            if (!key.equals(PersonsAudio.key) || mp == null) {
                // not loaded yet: it starts there
                int ms = (int) (frac * durS * 1000);
                toggle();
                pendingMs = ms;
                return;
            }
            int ms = 0;
            try { ms = (int) (frac * mp.getDuration()); } catch (Exception ignored) { }
            if (prepared) { try { mp.seekTo(ms); } catch (Exception ignored) { } } else pendingMs = ms;
            update();
        }

        private void nextSpeed() {
            speed = speed < 1.25f ? 1.5f : speed < 1.75f ? 2f : 1f;
            if (mp != null && prepared && playing) {
                try { mp.setPlaybackParams(new PlaybackParams().setSpeed(speed)); } catch (Exception ignored) { }
            }
            update();
        }

        private void transcribe(TextView t) {
            if (transcribing.contains(key)) return;
            transcribing.add(key);
            t.setText("Transcribing…");
            JSONObject b = new JSONObject();
            PersonsUi.put(b, "key", key);
            PersonsUi.put(b, "account", account);
            PersonsUi.put(b, "url", PersonsUi.s(f, "raw"));
            PersonsUi.put(b, "name", PersonsUi.s(f, "name"));
            Ui.pool.execute(() -> {
                String err = null;
                try {
                    JSONObject r = hub.call("POST", "/v1/persons/audio/transcribe", b, 300_000);
                    if (r.optString("text", "").trim().isEmpty()) err = "No speech in it";
                } catch (Exception e) { err = Hub.why(e); }
                String fe = err;
                Ui.main.post(() -> {
                    transcribing.remove(key);
                    if (fe != null) { Ui.toast(a, fe); t.setText("Transcribe"); }
                    if (reload != null) reload.run();
                });
            });
        }
    }

    /** The bars: the platform's waveform (or a flat line), the played part in ink. */
    static float[] bars(JSONObject f) {
        JSONArray b = f.optJSONArray("bars");
        int n = b == null || b.length() == 0 ? 40 : b.length();
        float[] out = new float[n];
        for (int i = 0; i < n; i++) out[i] = b == null || b.length() == 0 ? 0.18f : (float) b.optDouble(i, 0.18);
        return out;
    }

    static final class Bars extends View {
        final float[] v;
        final int ink;
        float frac;
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF r = new RectF();

        Bars(Context c, float[] v, int ink) {
            super(c);
            this.v = v;
            this.ink = ink;
        }

        @Override protected void onDraw(Canvas c) {
            int n = v.length;
            float gap = Ui.dp(2);
            float w = Math.max(1, (getWidth() - (n - 1) * gap) / n);
            float h = getHeight();
            for (int i = 0; i < n; i++) {
                float bh = Math.max(Ui.dp(3), v[i] * h);
                float x = i * (w + gap);
                r.set(x, (h - bh) / 2, x + w, (h + bh) / 2);
                p.setColor((i + 0.5f) / n <= frac ? ink : (ink & 0x00ffffff) | 0x48000000);
                c.drawRoundRect(r, w / 2, w / 2, p);
            }
        }
    }
}
