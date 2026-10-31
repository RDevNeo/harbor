package dev.harbor.app;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.SurfaceTexture;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.Window;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.FileInputStream;
import java.io.IOException;

/** The videos of the image viewer ({@link Images#view}), played like the desktop's: just the
 *  picture, with play and pause, the time, a seek bar, mute and full screen, which fade while it
 *  plays; a tap brings them back. MediaPlayer decodes on the phone's hardware and reads a
 *  {@link Stream}, so a video plays while it arrives.
 *
 *  One player, on a thread of its own: starting, stopping and seeking never wait on the UI thread.
 *  It's released when the viewer leaves a video, closes, or the app goes to the background. */
final class Video {
    /** How long the controls stay after the last touch, in ms (the desktop's too). */
    private static final long CONTROLS_FOR = 2500;
    private static final long TICK = 250;

    /** What the viewer does for it. */
    interface Host {
        /** Show or hide the viewer's controls, its own included (see {@link #chrome}). */
        void chrome(boolean on);
    }

    final TextureView picture;
    /** The controls, along the bottom. */
    final LinearLayout bar;
    /** What's over the picture while there's nothing to see: a spinner, or why not. */
    final FrameLayout state;

    private final Activity a;
    private final Window win;
    private final Host host;
    private final AudioManager audio;
    private final HandlerThread thread = new HandlerThread("video");
    private final Handler h;
    private final TextView play, time, mute, full;
    private final Seek seek;
    private final ProgressBar spin;
    private final TextView why;

    // The UI thread's.
    private Images.Src now;
    private boolean playing, shown, ended;
    /** It's prepared, so the next frame the picture gets is this video's. */
    private boolean live;
    private long position, duration;
    private boolean suspended, held;
    private boolean fullscreen;
    private int orientation;
    private int width, height;
    private long started;
    private Surface surface;
    /** The video being shown: what a thread's work is for, if it's still this. */
    private volatile int gen;

    // The video thread's.
    private MediaPlayer player;
    private volatile Stream stream;
    private boolean ready, seeking;
    /** Where the last player stopped, in ms. */
    private volatile int stoppedAt;
    private int pendingSeek = -1;
    private boolean pendingExact;
    private static boolean muted;

    private final AudioFocusRequest focus;
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { pause(); }
    };
    private boolean listening;

    private final Runnable hide = () -> { if (playing && !held) Video.this.host.chrome(false); };
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!playing || !shown) return;
            int g = gen;
            h.post(() -> {
                if (g != gen || player == null || !ready) return;
                int p = player.getCurrentPosition();
                Stream s = stream;
                boolean stalled = s != null && s.stalled;
                Ui.main.post(() -> {
                    if (g != gen) return;
                    if (!held) position = p;
                    spin.setVisibility(stalled ? View.VISIBLE : View.GONE);
                    update();
                });
            });
            Ui.main.postDelayed(this, TICK);
        }
    };

    Video(Activity a, Window win, Host host) {
        this.a = a;
        this.win = win;
        this.host = host;
        thread.start();
        h = new Handler(thread.getLooper());
        audio = (AudioManager) a.getSystemService(Context.AUDIO_SERVICE);
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attributes())
                .setOnAudioFocusChangeListener(c -> { if (c < 0) Ui.main.post(this::pause); }, h)
                .build();
        picture = new TextureView(a);
        picture.setOpaque(false);
        picture.setAlpha(0);
        picture.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture t, int w, int h2) {
                surface = new Surface(t);
                Surface s = surface;
                h.post(() -> { if (player != null) player.setSurface(s); });
                fit();
            }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture t, int w, int h2) { fit(); }
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture t) {
                if (surface != null) surface.release();
                surface = null;
                h.post(() -> { if (player != null) player.setSurface(null); });
                return true;
            }
            // (The poster stays until a frame of this video is there; a seek while paused gets
            // no "rendering start", but it does get here.)
            @Override public void onSurfaceTextureUpdated(SurfaceTexture t) {
                if (!live) return;
                if (picture.getAlpha() == 0) {
                    Stream s = stream;
                    Log.i("HarborVideo", "first frame after " + (System.currentTimeMillis() - started) + " ms, " + (s == null || s.whole != null ? "from the cache" : s.fetchedKb() + " KB fetched"));
                }
                picture.setAlpha(1);
            }
        });
        bar = Ui.row(a);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(Ui.dp(4), 0, Ui.dp(4), 0);
        bar.setBackground(Ui.round(0xaa000000, 0, 10));
        bar.setClickable(true);
        play = button(Ui.I_PLAY, "Play", v -> toggle());
        bar.addView(play);
        time = Ui.text(a, "0:00 / 0:00", 12, 0xffe6e6e6);
        time.setTypeface(Ui.mono);
        bar.addView(time, Ui.margins(Ui.wrap(), 4, 0, 10, 0));
        seek = new Seek(a);
        seek.setContentDescription("Seek");
        bar.addView(seek, new LinearLayout.LayoutParams(0, Ui.dp(44), 1));
        mute = button(muted ? Ui.I_VOLUME_X : Ui.I_VOLUME, muted ? "Unmute" : "Mute", v -> toggleMute());
        bar.addView(mute);
        full = button(Ui.I_MAXIMIZE, "Full screen", v -> toggleFull());
        bar.addView(full);
        state = new FrameLayout(a);
        spin = new ProgressBar(a);
        spin.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(0xffffffff));
        state.addView(spin, new FrameLayout.LayoutParams(Ui.dp(40), Ui.dp(40), Gravity.CENTER));
        LinearLayout msg = Ui.col(a);
        msg.setGravity(Gravity.CENTER_HORIZONTAL);
        why = Ui.text(a, "", 14, 0xffe6e6e6);
        why.setGravity(Gravity.CENTER);
        msg.addView(why);
        msg.addView(Ui.text(a, "Tap to try again", 13, 0xffa0a0a0), Ui.margins(Ui.wrap(), 0, 8, 0, 0));
        msg.setOnClickListener(v -> { if (now != null) load(now, 0, true); });
        msg.setVisibility(View.GONE);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER);
        lp.leftMargin = lp.rightMargin = Ui.dp(24);
        state.addView(msg, lp);
        state.setVisibility(View.GONE);
    }

    private TextView button(String glyph, String label, View.OnClickListener on) {
        TextView t = Ui.iconButton(a, glyph, 0xffffffff, on);
        t.setBackground(null);
        t.setContentDescription(label);
        return t;
    }

    private static AudioAttributes attributes() {
        return new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build();
    }

    /** The viewer moved to a video: it plays, or (browsed onto) waits at its start. */
    void show(Images.Src s, boolean start) { load(s, 0, start); }

    /** The viewer moved to an image. */
    void leave() {
        now = null;
        stop();
        state.setVisibility(View.GONE);
        picture.setAlpha(0);
        leaveFull();
    }

    private void load(Images.Src s, int at, boolean start) {
        now = s;
        started = System.currentTimeMillis();
        stop();
        int g = gen;
        ended = false;
        position = at;
        duration = 0;
        width = height = 0;
        picture.setAlpha(0);
        spin.setVisibility(View.VISIBLE);
        ((View) why.getParent()).setVisibility(View.GONE);
        state.setVisibility(View.VISIBLE);
        update();
        Ui.pool.execute(() -> {
            Stream st;
            try {
                st = Stream.open(a, s.hub, s.url, s.name);
            } catch (IOException e) {
                failed(g, e.getMessage());
                return;
            }
            if (g != gen || !h.post(() -> prepare(g, st, at, start))) st.close();
        });
    }

    private void prepare(int g, Stream st, int at, boolean start) {
        if (g != gen) { st.close(); return; }
        MediaPlayer p = new MediaPlayer();
        p.setAudioAttributes(attributes());
        p.setOnPreparedListener(x -> prepared(g, x, at, start));
        p.setOnVideoSizeChangedListener((x, w, h2) -> Ui.main.post(() -> {
            if (g != gen) return;
            width = w;
            height = h2;
            fit();
        }));
        p.setOnSeekCompleteListener(x -> seeked(g));
        p.setOnCompletionListener(x -> Ui.main.post(() -> { if (g == gen) completed(); }));
        p.setOnErrorListener((x, what, extra) -> {
            Log.w("HarborVideo", "player error " + what + "/" + extra);
            failed(g, "this phone can't play it");
            return true;
        });
        player = p;
        stream = st;
        try {
            if (st.whole != null) {
                try (FileInputStream in = new FileInputStream(st.whole)) { p.setDataSource(in.getFD()); }
            } else {
                p.setDataSource(st);
            }
            Surface s = surface;
            if (s != null) p.setSurface(s);
            p.prepareAsync();
        } catch (IOException | RuntimeException e) {
            failed(g, "this phone can't play it");
        }
    }

    private void prepared(int g, MediaPlayer p, int at, boolean start) {
        if (g != gen || p != player) return;
        ready = true;
        p.setVolume(muted ? 0 : 1, muted ? 0 : 1);
        int len = p.getDuration();
        // (A seek draws the frame there, also while paused.)
        if (at > 0 || !start) {
            p.seekTo(at, MediaPlayer.SEEK_CLOSEST);
            seeking = true;
        }
        if (start) begin(p);
        boolean on = start;
        Ui.main.post(() -> {
            if (g != gen) return;
            duration = Math.max(0, len);
            live = true;
            state.setVisibility(View.GONE);
            spin.setVisibility(View.GONE);
            playingNow(on);
        });
    }

    private void begin(MediaPlayer p) {
        audio.requestAudioFocus(focus);
        p.start();
    }

    private void seeked(int g) {
        seeking = false;
        if (g == gen && pendingSeek >= 0) {
            int to = pendingSeek;
            pendingSeek = -1;
            seekNow(to, pendingExact);
        }
        if (g != gen) return;
        MediaPlayer p = player;
        int at = p != null && ready ? p.getCurrentPosition() : -1;
        if (at >= 0) Ui.main.post(() -> {
            if (g != gen || held) return;
            position = at;
            update();
        });
    }

    private void seekNow(int to, boolean exact) {
        MediaPlayer p = player;
        if (p == null || !ready) return;
        seeking = true;
        p.seekTo(to, exact ? MediaPlayer.SEEK_CLOSEST : MediaPlayer.SEEK_PREVIOUS_SYNC);
    }

    private void failed(int g, String reason) {
        Ui.main.post(() -> {
            if (g != gen) return;
            spin.setVisibility(View.GONE);
            state.setVisibility(View.VISIBLE);
            why.setText("Can't play this video: " + (reason == null ? "it didn't load" : reason));
            ((View) why.getParent()).setVisibility(View.VISIBLE);
            picture.setAlpha(0);
            playingNow(false);
        });
    }

    private void completed() {
        ended = true;
        position = duration;
        playingNow(false);
        h.post(this::quiet);
    }

    /** A new state: the button, the screen kept on, the audio, the controls. */
    private void playingNow(boolean on) {
        playing = on;
        picture.setKeepScreenOn(on);
        if (on != listening) {
            listening = on;
            if (on) a.registerReceiver(noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
            else a.unregisterReceiver(noisy);
        }
        update();
        touched();
        if (on && shown) {
            Ui.main.removeCallbacks(tick);
            Ui.main.post(tick);
        }
    }

    private void quiet() { audio.abandonAudioFocusRequest(focus); }

    /** Releases the player (off this thread) and forgets the video. */
    private void stop() {
        gen++;
        if (playing) playingNow(false);
        Ui.main.removeCallbacks(tick);
        Ui.main.removeCallbacks(hide);
        held = live = false;
        h.post(this::free);
    }

    private void free() {
        MediaPlayer p = player;
        Stream s = stream;
        player = null;
        stream = null;
        ready = seeking = false;
        pendingSeek = -1;
        quiet();
        if (p != null) {
            try { stoppedAt = p.getCurrentPosition(); } catch (IllegalStateException ignored) { }
            p.release();
            Log.i("HarborVideo", "player released at " + stoppedAt + " ms");
        }
        if (s != null) s.close();
    }

    void toggle() {
        if (now == null) return;
        boolean on = !playing;
        boolean again = ended;
        ended = false;
        int g = gen;
        h.post(() -> {
            MediaPlayer p = player;
            if (g != gen || p == null || !ready) return;
            if (!on) {
                p.pause();
                quiet();
            } else {
                if (again) p.seekTo(0, MediaPlayer.SEEK_CLOSEST);
                begin(p);
            }
        });
        if (again) position = 0;
        playingNow(on);
    }

    /** Paused where it is: the app left the screen, the audio went elsewhere. */
    void pause() {
        if (playing) toggle();
    }

    /** The app is in the background: nothing of the player stays. */
    void suspend() {
        if (now == null || suspended) return;
        suspended = true;
        stop();
    }

    /** Back from the background: where it was, paused. */
    void resume() {
        if (!suspended || now == null) return;
        suspended = false;
        // (After free, on its thread: that's what knows where it stopped.)
        h.post(() -> Ui.main.post(() -> { if (now != null) load(now, stoppedAt, false); }));
    }

    private void toggleMute() {
        muted = !muted;
        mute.setText(muted ? Ui.I_VOLUME_X : Ui.I_VOLUME);
        mute.setContentDescription(muted ? "Unmute" : "Mute");
        h.post(() -> { if (player != null) player.setVolume(muted ? 0 : 1, muted ? 0 : 1); });
        touched();
    }

    private void toggleFull() {
        fullscreen = !fullscreen;
        if (fullscreen) orientation = a.getRequestedOrientation();
        View d = win.getDecorView();
        d.setSystemUiVisibility(fullscreen ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE : 0);
        // A wide video turns the phone sideways; a tall one is best as it is.
        if (fullscreen && width > height) a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        else if (!fullscreen) a.setRequestedOrientation(orientation);
        full.setText(fullscreen ? Ui.I_MINIMIZE : Ui.I_MAXIMIZE);
        full.setContentDescription(fullscreen ? "Leave full screen" : "Full screen");
        touched();
    }

    /** True when it was full screen: Back leaves that first, as Esc does on the desktop. */
    boolean leaveFull() {
        if (!fullscreen) return false;
        toggleFull();
        return true;
    }

    /** Shown again, or hidden: the viewer's controls went with a tap. */
    void chrome(boolean on) {
        shown = on;
        Ui.main.removeCallbacks(tick);
        if (on && playing) Ui.main.post(tick);
        touched();
    }

    /** Something was touched: the controls stay a while longer. */
    void touched() {
        Ui.main.removeCallbacks(hide);
        if (playing && shown) Ui.main.postDelayed(hide, CONTROLS_FOR);
        if (!playing && !shown && now != null) host.chrome(true);
    }

    private void update() {
        play.setText(playing ? Ui.I_PAUSE : Ui.I_PLAY);
        play.setContentDescription(playing ? "Pause" : ended ? "Play again" : "Play");
        time.setText(Blocks.clock(position) + " / " + Blocks.clock(duration));
        seek.at = duration > 0 ? (float) position / duration : 0;
        seek.invalidate();
    }

    /** The picture at its own shape, as large as fits. MediaPlayer's size is after rotation. */
    private void fit() {
        int w = picture.getWidth(), h2 = picture.getHeight();
        if (w == 0 || h2 == 0 || width == 0 || height == 0) return;
        float scale = Math.min((float) w / width, (float) h2 / height);
        Matrix m = new Matrix();
        m.setScale(width * scale / w, height * scale / h2, w / 2f, h2 / 2f);
        picture.setTransform(m);
        picture.invalidate();
    }

    /** The viewer closes. */
    void close() {
        leave();
        gen++;
        Handler handler = h;
        handler.post(thread::quitSafely);
    }

    /** A thin bar like the desktop's: a drag previews, the lift lands on the exact frame. */
    private final class Seek extends View {
        float at;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        Seek(Context c) { super(c); }

        @Override protected void onDraw(Canvas c) {
            float y = getHeight() / 2f, w = getWidth(), t = Ui.dp(held ? 2.5f : 1.5f);
            paint.setColor(0x46ffffff);
            c.drawRoundRect(0, y - t, w, y + t, t, t, paint);
            paint.setColor(0xffffffff);
            c.drawRoundRect(0, y - t, w * Math.max(0, Math.min(1, at)), y + t, t, t, paint);
        }

        @Override public boolean onTouchEvent(MotionEvent e) {
            if (duration <= 0) return true;
            int act = e.getActionMasked();
            if (act == MotionEvent.ACTION_DOWN) {
                held = true;
                getParent().requestDisallowInterceptTouchEvent(true);
            }
            if (act == MotionEvent.ACTION_CANCEL) {
                held = false;
                return true;
            }
            float f = Math.max(0, Math.min(1, e.getX() / Math.max(1, getWidth())));
            int to = (int) (f * duration);
            boolean lift = act == MotionEvent.ACTION_UP;
            if (lift) held = false;
            position = to;
            ended = false;
            update();
            touched();
            int g = gen;
            h.post(() -> {
                if (g != gen) return;
                if (seeking) {
                    pendingSeek = to;
                    pendingExact = lift;
                } else {
                    seekNow(to, lift);
                }
            });
            return true;
        }
    }
}
