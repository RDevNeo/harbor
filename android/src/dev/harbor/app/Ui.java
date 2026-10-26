package dev.harbor.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextPaint;
import android.text.TextUtils;
import android.text.style.MetricAffectingSpan;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Harbor's look on the phone: warm paper in light mode, a matching warm dark, serif titles,
 *  Geist text, Lucide outline icons, and small view builders. Colours are set per activity by
 *  theme() (Color mode: System, Light or Dark). */
final class Ui {
    // Palette (theme() fills these). BG: the page; CARD: grouped cards and the composer;
    // G100..G900: fills to secondary text; FG: text; INK/ON_INK: the black pill and send button.
    static int BG, BG2, CARD, LINE, G100, G200, G300, G400, G500, G600, G700, G900, FG, INK, ON_INK;
    static int BLUE, RED, RED_BG, GREEN, AMBER;
    static boolean dark;
    static int themeGen; // bumped when Color mode changes: open screens redraw on resume

    // Lucide glyphs in assets/fonts/lucide.ttf (a subset: the code points of src/icons.rs).
    static final String I_SETTINGS = "", I_PLUS = "", I_LEFT = "", I_CLIP = "",
            I_SEND = "", I_STOP = "", I_X = "", I_CHECK = "", I_RIGHT = "",
            I_DOWN = "", I_BRAIN = "", I_HAMMER = "", I_MENU = "", I_FORK = "",
            I_COPY = "", I_FILE = "", I_IMAGE = "", I_LAPTOP = "",
            I_MONITOR = "", I_PHONE = "", I_HOUSE = "", I_DOWNLOAD = "",
            I_ALERT = "", I_LOADER = "", I_FOLDER = "", I_ARCHIVE = "",
            I_UP = "", I_SEARCH = "", I_CHAT = "", I_LOCK = "", I_LOCK_OPEN = "",
            I_SLIDERS = "", I_USER = "", I_MOON = "", I_SUN_MOON = "",
            I_PLUG = "", I_TRASH = "", I_UPLOAD = "", I_GAUGE = "",
            I_LAYERS = "", I_SPARKLES = "", I_LINK = "", I_PEN = "",
            I_TERMINAL = "", I_GLOBE = "", I_BOT = "", I_CLOCK = "",
            I_CIRCLE_CHECK = "", I_CIRCLE_X = "", I_WEBHOOK = "", I_ACTIVITY = "",
            I_ROTATE = "", I_UP_CHEVRON = "",
            I_PANEL_RIGHT = "\ue431", I_PR_OPEN = "\ue555", I_PR_DRAFT = "\ue35b", I_PR_CLOSED = "\ue35a",
            I_MERGE = "\ue0e4", I_CIRCLE_DOT = "\ue345", I_CIRCLE_SLASH = "\ue402", I_CIRCLE_DASHED = "\ue4b0",
            I_TAG = "\ue17f", I_BRANCH = "\ue0e2", I_EXTERNAL = "\ue0b9", I_FILTER = "\ue460", I_REFRESH = "\ue145",
            I_SORT = "\ue046", I_MILESTONE = "\ue298", I_USERS = "\ue1a4";

    static Typeface sans, semi, mono, icons, serif, serifBold;
    static final Handler main = new Handler(Looper.getMainLooper());
    static final ExecutorService pool = Executors.newCachedThreadPool();
    static float density = 1;
    static Context app; // for Net, which runs without an activity at hand

    static void init(Context c) {
        app = c.getApplicationContext();
        density = c.getResources().getDisplayMetrics().density;
        theme(c);
        if (sans != null) return;
        sans = Typeface.createFromAsset(c.getAssets(), "fonts/Geist-Regular.ttf");
        semi = Typeface.createFromAsset(c.getAssets(), "fonts/Geist-SemiBold.ttf");
        mono = Typeface.createFromAsset(c.getAssets(), "fonts/GeistMono-Regular.ttf");
        icons = Typeface.createFromAsset(c.getAssets(), "fonts/lucide.ttf");
        serif = Typeface.create(Typeface.SERIF, Typeface.NORMAL);
        serifBold = Typeface.create(Typeface.SERIF, Typeface.BOLD);
    }

    // ---- colour mode ----

    static final String[] MODES = {"system", "light", "dark"};
    static final String[] MODE_LABELS = {"System", "Light", "Dark"};

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("ui", Context.MODE_PRIVATE); }
    static String mode(Context c) { return prefs(c).getString("color_mode", "system"); }
    static String modeLabel(Context c) {
        String m = mode(c);
        for (int i = 0; i < MODES.length; i++) if (MODES[i].equals(m)) return MODE_LABELS[i];
        return "System";
    }

    static void theme(Context c) {
        String m = mode(c);
        dark = "dark".equals(m) || ("system".equals(m)
                && (c.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
        if (dark) {
            BG = 0xff262624; BG2 = 0xff1f1e1d; CARD = 0xff30302e; LINE = 0xff3d3c39;
            G100 = 0xff353432; G200 = 0xff3b3a37; G300 = 0xff43423e; G400 = 0xff4f4e49; G500 = 0xff64625c;
            G600 = 0xff8a8880; G700 = 0xffa6a39a; G900 = 0xffc8c5bb; FG = 0xfffaf9f5;
            INK = 0xfffaf9f5; ON_INK = 0xff1f1e1d;
            BLUE = 0xff5fa8f5; RED = 0xffff7b72; RED_BG = 0xff3a2422; GREEN = 0xff6cc07a; AMBER = 0xfff2b440;
        } else {
            BG = 0xfffaf9f5; BG2 = 0xfff4f3ee; CARD = 0xffffffff; LINE = 0xffe6e4dc;
            G100 = 0xfff0eee6; G200 = 0xffe9e7df; G300 = 0xffe1dfd6; G400 = 0xffd3d0c6; G500 = 0xffb5b2a8;
            G600 = 0xff8d8b83; G700 = 0xff73726c; G900 = 0xff55544f; FG = 0xff141413;
            INK = 0xff141413; ON_INK = 0xfffaf9f5;
            BLUE = 0xff2d7ff0; RED = 0xffa83232; RED_BG = 0xfffbecea; GREEN = 0xff2f8a49; AMBER = 0xffb87510;
        }
    }

    /** Status and navigation bars in the page colour, with icons that read on it. */
    static void bars(Activity a) {
        a.getWindow().setStatusBarColor(BG);
        a.getWindow().setNavigationBarColor(BG);
        a.getWindow().getDecorView().setBackgroundColor(BG);
        int f = a.getWindow().getDecorView().getSystemUiVisibility();
        int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        a.getWindow().getDecorView().setSystemUiVisibility(dark ? f & ~light : f | light);
    }

    static int dp(float v) { return Math.round(v * density); }

    // ---- background work ----

    interface Job<T> { T run() throws Exception; }
    interface Done<T> { void ok(T t); }

    /** Runs job off the UI thread; done (or a toast with the error) back on it, unless the
     *  activity is gone by then. */
    static <T> void bg(Activity a, Job<T> job, Done<T> done) {
        pool.execute(() -> {
            try {
                T r = job.run();
                main.post(() -> { if (!a.isFinishing() && !a.isDestroyed() && done != null) done.ok(r); });
            } catch (Exception e) {
                main.post(() -> { if (!a.isFinishing() && !a.isDestroyed()) toast(a, Hub.why(e)); });
            }
        });
    }

    static void toast(Context c, String s) { Toast.makeText(c, s, Toast.LENGTH_LONG).show(); }

    static void copy(Context c, String s) {
        ((ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Harbor", s));
        toast(c, "Copied");
    }

    // ---- drawables ----

    static GradientDrawable round(int fill, int stroke, float radius) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radius));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    /** Rounded top corners only (bottom sheets). */
    static GradientDrawable top(int fill, float radius) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        float r = dp(radius);
        g.setCornerRadii(new float[]{r, r, r, r, 0, 0, 0, 0});
        return g;
    }

    /** A pressable background: fill (0 = transparent) with a soft ripple. */
    static RippleDrawable press(int fill, int stroke, float radius) {
        GradientDrawable mask = round(0xffffffff, 0, radius);
        return new RippleDrawable(ColorStateList.valueOf(dark ? 0x33ffffff : 0x1f000000),
                fill == 0 && stroke == 0 ? null : round(fill, stroke, radius), mask);
    }

    // ---- views ----

    static TextView text(Context c, CharSequence s, float sp, int color) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setTypeface(sans);
        t.setLineSpacing(0, 1.15f);
        return t;
    }

    static TextView bold(Context c, CharSequence s, float sp, int color) {
        TextView t = text(c, s, sp, color);
        t.setTypeface(semi);
        return t;
    }

    /** Serif titles, like the wordmark. */
    static TextView title(Context c, CharSequence s, float sp) {
        TextView t = text(c, s, sp, FG);
        t.setTypeface(serif);
        t.setLetterSpacing(-0.01f);
        return t;
    }

    /** The drawer's and the team panel's bold serif heading. */
    static TextView heading(Context c, CharSequence s, float sp) {
        TextView t = title(c, s, sp);
        t.setTypeface(serifBold);
        return t;
    }

    /** An icon glyph. Sized in dp, not sp: a large system font size must not grow (and clip)
     *  icons inside their fixed round buttons. */
    static TextView icon(Context c, String glyph, float size, int color) {
        TextView t = new TextView(c);
        t.setText(glyph);
        t.setTypeface(icons);
        t.setTextSize(TypedValue.COMPLEX_UNIT_DIP, size);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        t.setPadding(0, 0, 0, 0);
        return t;
    }

    /** A round icon button, 44 dp. */
    static TextView iconButton(Context c, String glyph, int color, View.OnClickListener on) {
        TextView t = icon(c, glyph, 22, color);
        t.setBackground(press(0, 0, 22));
        t.setLayoutParams(new LinearLayout.LayoutParams(dp(44), dp(44)));
        t.setOnClickListener(on);
        return t;
    }

    /** A filled round button (size dp) with a centred glyph or drawn icon. */
    static FrameLayout roundButton(Context c, Object glyph, int fill, int color, float size, View.OnClickListener on) {
        FrameLayout f = new FrameLayout(c);
        f.setBackground(press(fill, 0, size / 2));
        if (glyph instanceof Drawable) {
            ImageView iv = new ImageView(c);
            iv.setImageDrawable((Drawable) glyph);
            f.addView(iv, new FrameLayout.LayoutParams(dp(size * 0.46f), dp(size * 0.46f), Gravity.CENTER));
        } else {
            f.addView(icon(c, (String) glyph, size * 0.45f, color), new FrameLayout.LayoutParams(dp(size), dp(size), Gravity.CENTER));
        }
        f.setOnClickListener(on);
        f.setLayoutParams(new LinearLayout.LayoutParams(dp(size), dp(size)));
        return f;
    }

    /** primary = the black pill; else a quiet outlined one. */
    static TextView button(Context c, String label, boolean primary, View.OnClickListener on) {
        TextView t = bold(c, label, 15, primary ? ON_INK : FG);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(20), dp(12), dp(20), dp(12));
        t.setBackground(primary ? press(INK, 0, 24) : press(CARD, LINE, 24));
        t.setOnClickListener(on);
        return t;
    }

    /** A soft pill (fill G100) with a label, like the composer's model pill. */
    static TextView pill(Context c, CharSequence label, View.OnClickListener on) {
        TextView t = text(c, label, 15, FG);
        t.setGravity(Gravity.CENTER);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setPadding(dp(16), 0, dp(16), 0);
        t.setBackground(press(G100, 0, 22));
        t.setOnClickListener(on);
        t.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)));
        return t;
    }

    static EditText input(Context c, String hint, boolean multi) {
        EditText e = new EditText(c);
        e.setHint(hint);
        e.setHintTextColor(G600);
        e.setTextColor(FG);
        e.setTypeface(sans);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        e.setBackground(round(CARD, LINE, 12));
        e.setPadding(dp(14), dp(12), dp(14), dp(12));
        e.setInputType(multi ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        if (!multi) e.setSingleLine(true);
        return e;
    }

    static LinearLayout col(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    static LinearLayout row(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    static LinearLayout.LayoutParams wrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    static LinearLayout.LayoutParams fill() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    static LinearLayout.LayoutParams weight() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
    }

    static <T extends ViewGroup.MarginLayoutParams> T margins(T p, float l, float t, float r, float b) {
        p.setMargins(dp(l), dp(t), dp(r), dp(b));
        return p;
    }

    static View dot(Context c, int color, float size) {
        View v = new View(c);
        v.setBackground(round(color, 0, size / 2));
        v.setLayoutParams(new LinearLayout.LayoutParams(dp(size), dp(size)));
        return v;
    }

    static View rule(Context c) {
        View v = new View(c);
        v.setBackgroundColor(LINE);
        v.setLayoutParams(margins(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)), 0, 8, 0, 8));
        return v;
    }

    /** A small muted section header in the side panels ("Recents", "Agents"). */
    static TextView label(Context c, String s) {
        TextView t = text(c, s, 13, G700);
        t.setPadding(dp(20), dp(14), dp(20), dp(4));
        return t;
    }

    /** A one-line side-panel row: a small outline icon and an ellipsized title. Trailing views
     *  (a status dot, a count) can be added to it. */
    static LinearLayout listRow(Context c, String glyph, int glyphColor, CharSequence title, int titleColor) {
        LinearLayout r = row(c);
        r.setMinimumHeight(dp(40));
        r.setPadding(dp(12), dp(8), dp(12), dp(8));
        r.addView(icon(c, glyph, 18, glyphColor), margins(new LinearLayout.LayoutParams(dp(20), dp(20)), 0, 0, 14, 0));
        r.addView(subtitle(text(c, title, 15, titleColor)), weight());
        return r;
    }

    /** Side-panel rows sit 8 dp in from the edges, so their pressed and selected fill is rounded. */
    static LinearLayout.LayoutParams inset() { return margins(fill(), 8, 0, 8, 0); }

    // ---- provider logos (assets/logos, shared with the desktop's src/logos.rs) ----

    private static final java.util.Map<String, android.graphics.Bitmap> logos = new java.util.HashMap<>();

    /** A provider's 48×48 logo: RGBA ones as drawn, alpha masks in the text colour; null if unknown. */
    static android.graphics.Bitmap logo(Context c, String file) {
        if (file == null || file.isEmpty()) return null;
        String key = file + "|" + FG;
        if (logos.containsKey(key)) return logos.get(key);
        android.graphics.Bitmap b = null;
        try (java.io.InputStream in = c.getAssets().open("logos/" + file)) {
            byte[] d = new byte[48 * 48 * 4];
            int n = 0, r;
            while (n < d.length && (r = in.read(d, n, d.length - n)) > 0) n += r;
            int[] px = new int[48 * 48];
            boolean rgba = n == 48 * 48 * 4;
            for (int i = 0; i < px.length; i++) {
                if (rgba) px[i] = (d[i * 4 + 3] & 0xff) << 24 | (d[i * 4] & 0xff) << 16 | (d[i * 4 + 1] & 0xff) << 8 | (d[i * 4 + 2] & 0xff);
                else px[i] = (d[i] & 0xff) << 24 | (FG & 0xffffff);
            }
            b = android.graphics.Bitmap.createBitmap(px, 48, 48, android.graphics.Bitmap.Config.ARGB_8888);
        } catch (Exception ignored) { }
        logos.put(key, b);
        return b;
    }

    /** The desktop's account mark: the provider's logo with the account badge ("AB") in its
     *  lower right corner. `size` in dp. */
    static View accountMark(Context c, String file, String badge, int size) {
        FrameLayout f = new FrameLayout(c);
        android.graphics.Bitmap b = logo(c, file);
        if (b != null) {
            ImageView iv = new ImageView(c);
            iv.setImageBitmap(b);
            int s = Math.round(size * 0.76f);
            f.addView(iv, new FrameLayout.LayoutParams(dp(s), dp(s)));
        } else {
            f.addView(icon(c, I_BOT, size * 0.8f, G700), new FrameLayout.LayoutParams(dp(size), dp(size)));
        }
        if (badge != null && !badge.isEmpty()) {
            TextView t = bold(c, badge, 7, FG);
            t.setIncludeFontPadding(false);
            t.setPadding(dp(2), 0, dp(2), 0);
            t.setBackground(round(G300, 0, 3));
            f.addView(t, new FrameLayout.LayoutParams(-2, -2, Gravity.END | Gravity.BOTTOM));
        }
        f.setLayoutParams(new LinearLayout.LayoutParams(dp(size), dp(size)));
        return f;
    }

    static TextView subtitle(TextView t) {
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        return t;
    }

    static AlertDialog.Builder dialog(Context c) {
        return new AlertDialog.Builder(c, dark ? android.R.style.Theme_DeviceDefault_Dialog_Alert
                : android.R.style.Theme_DeviceDefault_Light_Dialog_Alert);
    }

    // ---- grouped cards (Settings, sheets) ----

    /** A rounded card that holds rows separated by thin gaps, like the reference's groups. */
    static LinearLayout card(Context c) {
        LinearLayout l = col(c);
        l.setBackground(round(CARD, dark ? 0 : LINE, 20));
        l.setClipToOutline(true);
        return l;
    }

    /** A card row: icon (glyph String, Drawable or a View such as disc(), or null), title,
     *  optional subtitle, clickable when on isn't null. Trailing views can be added to it. */
    static LinearLayout cardRow(Context c, Object glyph, CharSequence title, CharSequence sub, int titleColor, View.OnClickListener on) {
        LinearLayout r = row(c);
        r.setMinimumHeight(dp(64));
        r.setPadding(dp(18), dp(12), dp(16), dp(12));
        if (on != null) r.setBackground(press(0, 0, 0));
        if (glyph != null) {
            if (glyph instanceof View) {
                View ic = (View) glyph;
                r.addView(ic, margins(new LinearLayout.LayoutParams(ic.getLayoutParams().width, ic.getLayoutParams().height), 0, 0, 14, 0));
            } else if (glyph instanceof Drawable) {
                ImageView iv = new ImageView(c);
                iv.setImageDrawable((Drawable) glyph);
                r.addView(iv, margins(new LinearLayout.LayoutParams(dp(24), dp(24)), 0, 0, 16, 0));
            } else {
                r.addView(icon(c, (String) glyph, 22, titleColor), margins(new LinearLayout.LayoutParams(dp(26), dp(26)), 0, 0, 16, 0));
            }
        }
        LinearLayout t = col(c);
        t.addView(subtitle(text(c, title, 17, titleColor)));
        if (sub != null && sub.length() > 0) t.addView(subtitle(text(c, sub, 14, G700)));
        r.addView(t, weight());
        if (on != null) r.setOnClickListener(on);
        return r;
    }

    static View chevron(Context c) {
        TextView t = icon(c, I_RIGHT, 20, G600);
        t.setLayoutParams(margins(new LinearLayout.LayoutParams(dp(24), dp(24)), 8, 0, 0, 0));
        return t;
    }

    /** Thin gap between rows inside a card. */
    static View gap(Context c) {
        View v = new View(c);
        v.setBackgroundColor(BG);
        v.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));
        return v;
    }

    /** A round tinted icon disc (the + sheet's rows and tiles). */
    static View disc(Context c, Object glyph, float size) {
        FrameLayout f = new FrameLayout(c);
        f.setBackground(round(G100, 0, size / 2));
        if (glyph instanceof Drawable) {
            ImageView iv = new ImageView(c);
            iv.setImageDrawable((Drawable) glyph);
            f.addView(iv, new FrameLayout.LayoutParams(dp(size * 0.45f), dp(size * 0.45f), Gravity.CENTER));
        } else {
            f.addView(icon(c, (String) glyph, size * 0.42f, FG), new FrameLayout.LayoutParams(dp(size), dp(size), Gravity.CENTER));
        }
        f.setLayoutParams(new LinearLayout.LayoutParams(dp(size), dp(size)));
        return f;
    }

    /** Typeface as a span (TypefaceSpan(Typeface) needs API 28; min is 26). skew != 0 fakes
     *  italics: Geist ships no italic. */
    static final class Font extends MetricAffectingSpan {
        final Typeface tf; final float skew;
        Font(Typeface tf, float skew) { this.tf = tf; this.skew = skew; }
        @Override public void updateDrawState(TextPaint p) { apply(p); }
        @Override public void updateMeasureState(TextPaint p) { apply(p); }
        private void apply(Paint p) {
            if (tf != null) p.setTypeface(tf);
            if (skew != 0) p.setTextSkewX(skew);
        }
    }

    /** Outline icons the Lucide subset lacks (menu, mic, camera), drawn on a 24-unit grid with
     *  Lucide's 2-unit round strokes. */
    static final class Draw extends Drawable {
        static final int MENU = 0, MIC = 1, CAMERA = 2;
        private final int kind;
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        Draw(int kind, int color) {
            this.kind = kind;
            p.setColor(color);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeCap(Paint.Cap.ROUND);
            p.setStrokeJoin(Paint.Join.ROUND);
        }

        @Override public void draw(Canvas c) {
            float s = Math.min(getBounds().width(), getBounds().height()) / 24f;
            c.save();
            c.translate(getBounds().left, getBounds().top);
            c.scale(s, s);
            p.setStrokeWidth(2f);
            switch (kind) {
                case MENU:
                    c.drawLine(4, 8, 20, 8, p);
                    c.drawLine(4, 16, 14, 16, p);
                    break;
                case MIC: {
                    c.drawRoundRect(new RectF(9, 2, 15, 15), 3, 3, p);
                    Path a = new Path();
                    a.addArc(new RectF(5, 5, 19, 19), 0, 180);
                    c.drawPath(a, p);
                    c.drawLine(12, 19, 12, 22, p);
                    break;
                }
                case CAMERA: {
                    Path b = new Path();
                    b.moveTo(4, 7); b.lineTo(7.5f, 7); b.lineTo(9.5f, 4); b.lineTo(14.5f, 4); b.lineTo(16.5f, 7);
                    b.lineTo(20, 7);
                    b.quadTo(22, 7, 22, 9); b.lineTo(22, 18); b.quadTo(22, 20, 20, 20); b.lineTo(4, 20);
                    b.quadTo(2, 20, 2, 18); b.lineTo(2, 9); b.quadTo(2, 7, 4, 7); b.close();
                    c.drawPath(b, p);
                    c.drawCircle(12, 13, 3.5f, p);
                    break;
                }
            }
            c.restore();
        }

        @Override public void setAlpha(int a) { p.setAlpha(a); }
        @Override public void setColorFilter(ColorFilter f) { p.setColorFilter(f); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }

    static String ago(long ms) {
        long s = Math.max(0, (System.currentTimeMillis() - ms) / 1000);
        if (s < 60) return "now";
        if (s < 3600) return s / 60 + "m";
        if (s < 86400) return s / 3600 + "h";
        if (s < 86400 * 30) return s / 86400 + "d";
        return s / (86400 * 30) + "mo";
    }
}
