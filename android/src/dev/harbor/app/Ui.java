package dev.harbor.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Paint;
import android.graphics.Typeface;
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
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Harbor's dark look (src/theme.rs DARK tokens, Geist, Lucide) and small view builders. */
final class Ui {
    // theme.rs DARK: bg100, bg200, gray 100..1000, and the accents the desktop uses.
    static final int BG = 0xff0a0a0a, BG2 = 0xff111111;
    static final int G100 = 0xff1a1a1a, G200 = 0xff1f1f1f, G300 = 0xff292929, G400 = 0xff2e2e2e,
            G500 = 0xff454545, G600 = 0xff878787, G700 = 0xff8f8f8f, G900 = 0xffa0a0a0, FG = 0xffededed;
    static final int BLUE = 0xff52a8ff, RED = 0xffff6166, RED_BG = 0xff2a1314, GREEN = 0xff46a758,
            AMBER = 0xffffb224;

    // Lucide glyphs in assets/fonts/lucide.ttf (same code points as src/icons.rs).
    static final String I_SETTINGS = "", I_PLUS = "", I_LEFT = "", I_CLIP = "",
            I_SEND = "", I_STOP = "", I_X = "", I_CHECK = "", I_RIGHT = "",
            I_DOWN = "", I_BRAIN = "", I_HAMMER = "", I_MENU = "", I_FORK = "",
            I_COPY = "", I_FILE = "", I_IMAGE = "", I_LAPTOP = "",
            I_MONITOR = "", I_PHONE = "", I_HOUSE = "", I_DOWNLOAD = "",
            I_ALERT = "", I_LOADER = "", I_FOLDER = "", I_ARCHIVE = "";

    static Typeface sans, semi, mono, icons;
    static final Handler main = new Handler(Looper.getMainLooper());
    static final ExecutorService pool = Executors.newCachedThreadPool();
    static float density = 1;

    static void init(Context c) {
        if (sans != null) return;
        sans = Typeface.createFromAsset(c.getAssets(), "fonts/Geist-Regular.ttf");
        semi = Typeface.createFromAsset(c.getAssets(), "fonts/Geist-SemiBold.ttf");
        mono = Typeface.createFromAsset(c.getAssets(), "fonts/GeistMono-Regular.ttf");
        icons = Typeface.createFromAsset(c.getAssets(), "fonts/lucide.ttf");
        density = c.getResources().getDisplayMetrics().density;
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

    /** A pressable background: fill (0 = transparent) with a grey ripple. */
    static RippleDrawable press(int fill, int stroke, float radius) {
        GradientDrawable mask = round(0xffffffff, 0, radius);
        return new RippleDrawable(ColorStateList.valueOf(G400), fill == 0 && stroke == 0 ? null : round(fill, stroke, radius), mask);
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

    static TextView icon(Context c, String glyph, float sp, int color) {
        TextView t = new TextView(c);
        t.setText(glyph);
        t.setTypeface(icons);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        return t;
    }

    /** A round icon button, 44 dp. */
    static TextView iconButton(Context c, String glyph, int color, View.OnClickListener on) {
        TextView t = icon(c, glyph, 20, color);
        t.setBackground(press(0, 0, 22));
        t.setLayoutParams(new LinearLayout.LayoutParams(dp(44), dp(44)));
        t.setOnClickListener(on);
        return t;
    }

    /** primary = white on black like the desktop's primary buttons; else outlined. */
    static TextView button(Context c, String label, boolean primary, View.OnClickListener on) {
        TextView t = bold(c, label, 15, primary ? BG : FG);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(16), dp(10), dp(16), dp(10));
        t.setBackground(primary ? press(FG, 0, 6) : press(G100, G400, 6));
        t.setOnClickListener(on);
        return t;
    }

    static EditText input(Context c, String hint, boolean multi) {
        EditText e = new EditText(c);
        e.setHint(hint);
        e.setHintTextColor(G600);
        e.setTextColor(FG);
        e.setTypeface(sans);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        e.setBackground(round(G100, G400, 6));
        e.setPadding(dp(12), dp(10), dp(12), dp(10));
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
        v.setBackgroundColor(G300);
        v.setLayoutParams(margins(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)), 0, 8, 0, 8));
        return v;
    }

    static TextView section(Context c, String s) {
        TextView t = bold(c, s, 12, G700);
        t.setAllCaps(false);
        t.setPadding(dp(16), dp(18), dp(16), dp(6));
        return t;
    }

    static TextView subtitle(TextView t) {
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        return t;
    }

    static AlertDialog.Builder dialog(Context c) {
        return new AlertDialog.Builder(c, android.R.style.Theme_DeviceDefault_Dialog_Alert);
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

    static String ago(long ms) {
        long s = Math.max(0, (System.currentTimeMillis() - ms) / 1000);
        if (s < 60) return "now";
        if (s < 3600) return s / 60 + "m";
        if (s < 86400) return s / 3600 + "h";
        if (s < 86400 * 30) return s / 86400 + "d";
        return s / (86400 * 30) + "mo";
    }
}
