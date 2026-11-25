package dev.harbor.app;

import android.app.Activity;
import android.app.Dialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Outline;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.util.LruCache;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Calendar;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Semaphore;

/** The Persons tab's shared pieces (ts/packages/persons/API.md): JSON and time helpers, a person's
 *  round avatar with Discord's presence mark, the channel marks (Discord, Gmail, WhatsApp), a
 *  person row as Person Hub's PersonRow draws it, and pictures and files from the PC (the
 *  /v1/persons/img and /v1/persons/file routes answer `{type, data: base64}`; raw bytes work too). */
final class PersonsUi {
    private PersonsUi() { }

    // ---- JSON ----

    /** A string field; "" for a missing one or JSON null (optString gives "null" for those). */
    static String s(JSONObject o, String k) {
        if (o == null || o.isNull(k)) return "";
        return o.optString(k, "");
    }

    static JSONObject obj(JSONObject o, String k) {
        return o == null || o.isNull(k) ? null : o.optJSONObject(k);
    }

    static JSONArray arr(JSONObject o, String k) {
        JSONArray a = o == null || o.isNull(k) ? null : o.optJSONArray(k);
        return a != null ? a : new JSONArray();
    }

    static boolean has(JSONArray a, String v) {
        for (int i = 0; i < a.length(); i++) if (v.equals(a.optString(i))) return true;
        return false;
    }

    static JSONObject put(JSONObject o, String k, Object v) {
        try { o.put(k, v); } catch (JSONException ignored) { }
        return o;
    }

    /** A person's row info for a section ("" = All people), falling back to All people's. */
    static JSONObject info(JSONObject person, String section) {
        JSONObject rows = obj(person, "rows");
        JSONObject r = rows == null ? null : obj(rows, section == null ? "" : section);
        if (r == null && rows != null) r = obj(rows, "");
        return r != null ? r : new JSONObject();
    }

    static String enc(String s) { return Uri.encode(s == null ? "" : s); }

    // ---- time ----

    /** An ISO time in ms (0 when absent or unreadable). */
    static long ms(String iso) {
        if (iso == null || iso.isEmpty() || "null".equals(iso)) return 0;
        try { return java.time.Instant.parse(iso).toEpochMilli(); } catch (RuntimeException ignored) { }
        try { return java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli(); } catch (RuntimeException ignored) { }
        try { return Long.parseLong(iso); } catch (RuntimeException e) { return 0; }
    }

    static final String[] MONTHS = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    static final String[] DAYS = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};

    /** Person Hub's shortAgo: "now", "5m ago", "3h ago", "2d ago", else "Nov 3". */
    static String shortAgo(long at) {
        if (at <= 0) return "";
        long m = Math.max(0, (System.currentTimeMillis() - at) / 60_000);
        if (m < 1) return "now";
        if (m < 60) return m + "m ago";
        long h = m / 60;
        if (h < 24) return h + "h ago";
        long d = h / 24;
        if (d < 7) return d + "d ago";
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(at);
        return MONTHS[c.get(Calendar.MONTH)] + " " + c.get(Calendar.DAY_OF_MONTH);
    }

    /** "just now", "5h ago", "22d ago", "3mo ago", "1y ago" (socials' uploads). */
    static String age(long at) {
        if (at <= 0) return "";
        long hours = (System.currentTimeMillis() - at) / 3_600_000;
        if (hours < 1) return "just now";
        if (hours < 24) return hours + "h ago";
        long days = hours / 24;
        if (days < 30) return days + "d ago";
        if (days < 365) return days / 30 + "mo ago";
        return days / 365 + "y ago";
    }

    /** 140K, 1.2M. */
    static String count(double n) {
        if (n >= 1e9) return unit(n / 1e9, "B");
        if (n >= 999_500) return unit(n / 1e6, "M");
        if (n >= 1000) return unit(n / 1000, "K");
        return String.valueOf((long) n);
    }

    private static String unit(double x, String s) {
        if (x >= 10) return Math.round(x) + s;
        String v = String.format(Locale.US, "%.1f", x);
        if (v.endsWith(".0")) v = v.substring(0, v.length() - 2);
        return v + s;
    }

    static String clock(long at) {
        return android.text.format.DateFormat.getTimeFormat(Ui.app).format(new java.util.Date(at));
    }

    static long dayOf(long at) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(at);
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    /** A day separator: "Today", "Yesterday", "Mon, 12 Nov" (+ the year when not this one). */
    static String day(long at) {
        long today = dayOf(System.currentTimeMillis()), d = dayOf(at);
        if (d == today) return "Today";
        if (today - d < 36 * 3_600_000L && today > d) return "Yesterday";
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(at);
        String s = DAYS[c.get(Calendar.DAY_OF_WEEK) - 1] + ", " + c.get(Calendar.DAY_OF_MONTH) + " " + MONTHS[c.get(Calendar.MONTH)];
        Calendar n = Calendar.getInstance();
        return c.get(Calendar.YEAR) != n.get(Calendar.YEAR) ? s + " " + c.get(Calendar.YEAR) : s;
    }

    static String bytes(long n) {
        if (n <= 0) return "";
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return Math.round(n / 1024.0) + " KB";
        return String.format(Locale.US, "%.1f MB", n / (1024.0 * 1024));
    }

    static String duration(double secs) {
        long s = Math.max(0, Math.round(secs));
        return s / 60 + ":" + String.format(Locale.US, "%02d", s % 60);
    }

    // ---- colours ----

    /** A status line's colour: Discord's green, yellow, red, else muted. */
    static int tone(String t) {
        switch (t == null ? "" : t) {
            case "green": case "online": return 0xff23a55a;
            case "yellow": case "idle": return 0xfff0b232;
            case "red": case "dnd": return 0xfff23f43;
            default: return Ui.G700;
        }
    }

    static int color(String hex, int def) {
        try { return hex == null || hex.isEmpty() ? def : Color.parseColor(hex); } catch (RuntimeException e) { return def; }
    }

    /** The Person AI's bubbles: a soft violet, apart from the conversation. */
    static int aiFill() { return Ui.dark ? 0xff302c3d : 0xfff3f0fb; }
    static int aiLine() { return Ui.dark ? 0xff5d5674 : 0xffcbc2e6; }

    static final String[] SECTIONS = {"stores", "creators", "spokpay"};

    static String sectionLabel(String s) {
        switch (s == null ? "" : s) {
            case "stores": return "Stores";
            case "creators": return "Creators";
            case "spokpay": return "SpokPay";
            default: return "All people";
        }
    }

    static String kindLabel(String k) {
        switch (k == null ? "" : k) {
            case "discord": return "Discord";
            case "gmail": return "Gmail";
            case "whatsapp": return "WhatsApp";
            default: return k == null ? "" : k;
        }
    }

    // ---- marks ----

    /** Discord's status mark on an avatar's corner: online a green dot, idle a yellow moon, do not
     *  disturb a red dot with a bar, offline a grey ring; `ring` is the page colour around it. */
    static final class Presence extends Drawable {
        private final String st;
        private final int ring;
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        Presence(String st, int ring) { this.st = st; this.ring = ring; }

        @Override public void draw(Canvas c) {
            float w = getBounds().width(), cx = getBounds().exactCenterX(), cy = getBounds().exactCenterY();
            float r = w / 2, ri = r * 0.72f;
            p.setColor(ring);
            c.drawCircle(cx, cy, r, p);
            switch (st) {
                case "online":
                    p.setColor(0xff23a55a);
                    c.drawCircle(cx, cy, ri, p);
                    break;
                case "idle":
                    p.setColor(0xfff0b232);
                    c.drawCircle(cx, cy, ri, p);
                    p.setColor(ring);
                    c.drawCircle(cx - ri * 0.5f, cy - ri * 0.5f, ri * 0.75f, p);
                    break;
                case "dnd":
                    p.setColor(0xfff23f43);
                    c.drawCircle(cx, cy, ri, p);
                    p.setColor(ring);
                    c.drawRoundRect(new RectF(cx - ri * 0.6f, cy - ri * 0.2f, cx + ri * 0.6f, cy + ri * 0.2f), ri * 0.2f, ri * 0.2f, p);
                    break;
                default:
                    p.setColor(0xff80848e);
                    c.drawCircle(cx, cy, ri, p);
                    p.setColor(ring);
                    c.drawCircle(cx, cy, ri * 0.5f, p);
            }
        }

        @Override public void setAlpha(int a) { p.setAlpha(a); }
        @Override public void setColorFilter(ColorFilter f) { p.setColorFilter(f); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }

    /** Simple coloured channel marks on a 24-unit grid: Discord's blurple face, Gmail's red M on an
     *  envelope, WhatsApp's green bubble. */
    static final class Channel extends Drawable {
        private final String kind;
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        Channel(String kind) { this.kind = kind == null ? "" : kind; }

        @Override public void draw(Canvas c) {
            float s = Math.min(getBounds().width(), getBounds().height()) / 24f;
            c.save();
            c.translate(getBounds().left, getBounds().top);
            c.scale(s, s);
            p.setStrokeCap(Paint.Cap.ROUND);
            p.setStrokeJoin(Paint.Join.ROUND);
            switch (kind) {
                case "gmail": {
                    p.setStyle(Paint.Style.FILL);
                    p.setColor(0xffffffff);
                    c.drawRoundRect(new RectF(2, 5, 22, 19), 2.5f, 2.5f, p);
                    p.setStyle(Paint.Style.STROKE);
                    p.setStrokeWidth(2.2f);
                    p.setColor(0xffea4335);
                    Path m = new Path();
                    m.moveTo(3.5f, 18); m.lineTo(3.5f, 7); m.lineTo(12, 13.5f); m.lineTo(20.5f, 7); m.lineTo(20.5f, 18);
                    c.drawPath(m, p);
                    p.setStrokeWidth(1);
                    p.setColor(0xffc5c5c5);
                    c.drawRoundRect(new RectF(2, 5, 22, 19), 2.5f, 2.5f, p);
                    break;
                }
                case "whatsapp": {
                    p.setStyle(Paint.Style.FILL);
                    p.setColor(0xff25d366);
                    c.drawCircle(12.5f, 11.5f, 9.5f, p);
                    Path t = new Path();
                    t.moveTo(3, 22); t.lineTo(4.6f, 15.5f); t.lineTo(9.5f, 19.8f); t.close();
                    c.drawPath(t, p);
                    // the handset, white
                    p.setColor(0xffffffff);
                    p.setStyle(Paint.Style.STROKE);
                    p.setStrokeWidth(2.4f);
                    Path h = new Path();
                    h.moveTo(9, 8); h.quadTo(8.5f, 12.5f, 12.5f, 15); h.quadTo(14.5f, 16.2f, 16.5f, 15);
                    c.drawPath(h, p);
                    break;
                }
                default: { // discord
                    p.setStyle(Paint.Style.FILL);
                    p.setColor(0xff5865f2);
                    Path b = new Path();
                    b.moveTo(5, 6); b.quadTo(9, 4, 10, 5); b.lineTo(14, 5); b.quadTo(15, 4, 19, 6);
                    b.quadTo(23, 12, 22, 17); b.quadTo(20, 19.5f, 17, 20); b.lineTo(15.5f, 17.5f); b.lineTo(8.5f, 17.5f);
                    b.lineTo(7, 20); b.quadTo(4, 19.5f, 2, 17); b.quadTo(1, 12, 5, 6); b.close();
                    c.drawPath(b, p);
                    p.setColor(0xffffffff);
                    c.drawOval(new RectF(7, 10.3f, 10.4f, 14.2f), p);
                    c.drawOval(new RectF(13.6f, 10.3f, 17, 14.2f), p);
                }
            }
            c.restore();
        }

        @Override public void setAlpha(int a) { p.setAlpha(a); }
        @Override public void setColorFilter(ColorFilter f) { p.setColorFilter(f); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }

    /** A channel mark, `size` dp. */
    static View channel(Context c, String kind, float size) {
        View v = new View(c);
        v.setBackground(new Channel(kind));
        v.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
        v.setContentDescription(kindLabel(kind));
        return v;
    }

    /** A clip to a circle (avatars). */
    static final ViewOutlineProvider OVAL = new ViewOutlineProvider() {
        @Override public void getOutline(View v, Outline o) { o.setOval(0, 0, v.getWidth(), v.getHeight()); }
    };

    /** A round avatar `size` dp: the initials on the person's colour, their picture over it once
     *  it's loaded, and the presence mark on its corner (none when presence is empty). */
    static FrameLayout avatar(Activity a, Hub hub, String url, String initials, int color, float size, String presence) {
        FrameLayout f = new FrameLayout(a);
        TextView ini = Ui.bold(a, initials == null ? "" : initials, 0, 0xffffffff);
        ini.setTextSize(TypedValue.COMPLEX_UNIT_DIP, Math.max(8, size * 0.36f));
        ini.setGravity(Gravity.CENTER);
        ini.setIncludeFontPadding(false);
        ini.setBackground(Ui.round(color, 0, size / 2));
        f.addView(ini, new FrameLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
        if (url != null && !url.isEmpty() && hub != null) {
            ImageView iv = new ImageView(a);
            iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
            iv.setOutlineProvider(OVAL);
            iv.setClipToOutline(true);
            f.addView(iv, new FrameLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
            String u = url.startsWith("/") && !url.contains("size=") ? url + (url.contains("?") ? "&" : "?") + "size=" + (size <= 48 ? 64 : 256) : url;
            image(a, hub, u, iv, Ui.dp(size), null);
        }
        if (presence != null && !presence.isEmpty()) {
            View dot = new View(a);
            dot.setBackground(new Presence(presence, Ui.BG));
            float ds = Math.max(10, size * 0.34f);
            f.addView(dot, new FrameLayout.LayoutParams(Ui.dp(ds), Ui.dp(ds), Gravity.END | Gravity.BOTTOM));
        }
        f.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
        return f;
    }

    /** A person of the state as an avatar. */
    static FrameLayout avatar(Activity a, Hub hub, JSONObject person, float size, String presence) {
        return avatar(a, hub, s(person, "avatar"), s(person, "initials"), color(s(person, "color"), Ui.G500), size, presence);
    }

    /** A count in a small round pill (Person Hub's: the text colour, the page's inside). */
    static TextView pill(Context c, int n, int fill, int fg) {
        TextView t = Ui.bold(c, n > 99 ? "99+" : String.valueOf(n), 11, fg);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        t.setMinWidth(Ui.dp(18));
        t.setPadding(Ui.dp(5), Ui.dp(2), Ui.dp(5), Ui.dp(2));
        t.setBackground(Ui.round(fill, 0, 9));
        t.setContentDescription(n + " unread");
        return t;
    }

    /** One person as Person Hub's PersonRow: avatar with presence, bold name + channel mark (+ a
     *  crown for a store's owner), the status line under it coloured by its tone, and on the right
     *  "typing…" or the time of the last message over the unread count. */
    static LinearLayout row(Activity a, Hub hub, JSONObject person, String section, boolean owner) {
        JSONObject info = info(person, section);
        LinearLayout r = Ui.row(a);
        r.setMinimumHeight(Ui.dp(60));
        r.setPadding(Ui.dp(10), Ui.dp(8), Ui.dp(12), Ui.dp(8));
        r.setBackground(Ui.press(0, 0, 14));
        r.addView(avatar(a, hub, person, 40, s(info, "presence")), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(40), Ui.dp(40)), 0, 0, 12, 0));
        LinearLayout mid = Ui.col(a);
        LinearLayout top = Ui.row(a);
        TextView name = Ui.subtitle(Ui.bold(a, s(person, "name"), 15, Ui.FG));
        top.addView(name, new LinearLayout.LayoutParams(-2, -2, 0));
        String ch = s(info, "channel");
        if (!ch.isEmpty()) top.addView(channel(a, ch, 14), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(14), Ui.dp(14)), 6, 0, 0, 0));
        if (owner) {
            TextView crown = Ui.text(a, "♛", 13, Ui.AMBER);
            crown.setContentDescription("Store owner");
            top.addView(crown, Ui.margins(Ui.wrap(), 5, 0, 0, 0));
        }
        mid.addView(top, Ui.fill());
        JSONObject st = obj(info, "status");
        if (st != null && !s(st, "text").isEmpty())
            mid.addView(Ui.subtitle(Ui.text(a, s(st, "text"), 12, tone(s(st, "tone")))), Ui.fill());
        r.addView(mid, Ui.weight());
        LinearLayout end = Ui.col(a);
        end.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        String typing = s(info, "typing");
        long last = ms(s(info, "lastAt"));
        if (!typing.isEmpty()) end.addView(Ui.text(a, "recording".equals(typing) ? "audio…" : "typing…", 12, Ui.BLUE));
        else if (last > 0) end.addView(Ui.text(a, shortAgo(last), 12, Ui.G600));
        int unread = info.optInt("unread");
        if (unread > 0) end.addView(pill(a, unread, Ui.INK, Ui.ON_INK), Ui.margins(Ui.wrap(), 0, 3, 0, 0));
        if (end.getChildCount() > 0) r.addView(end, Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        return r;
    }

    /** A store's mark: its picture, else a rounded square in its colour with its initial. */
    static View storeBadge(Activity a, Hub hub, JSONObject store, float size) {
        FrameLayout f = new FrameLayout(a);
        String name = s(store, "name");
        TextView t = Ui.bold(a, name.isEmpty() ? "?" : name.substring(0, 1).toUpperCase(Locale.ROOT), 0, 0xffffffff);
        t.setTextSize(TypedValue.COMPLEX_UNIT_DIP, size * 0.5f);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        t.setBackground(Ui.round(color(s(store, "color"), 0xff64748b), 0, size * 0.28f));
        f.addView(t, new FrameLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
        String img = s(store, "image");
        if (!img.isEmpty()) {
            ImageView iv = new ImageView(a);
            iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
            iv.setBackground(Ui.round(0x00000000, 0, size * 0.28f));
            iv.setClipToOutline(true);
            f.addView(iv, new FrameLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
            image(a, hub, img, iv, Ui.dp(size), null);
        }
        f.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
        return f;
    }

    // ---- pictures and files from the PC ----

    private static final LruCache<String, Bitmap> cache = new LruCache<String, Bitmap>(20 << 20) {
        @Override protected int sizeOf(String k, Bitmap b) { return b.getByteCount(); }
    };
    /** URLs that had no picture lately (404): not asked again for a while. */
    private static final Map<String, Long> none = new HashMap<>();
    private static final long NONE_MS = 5 * 60_000;
    /** Downloads at once: each is its own connection, and a PC takes only so many from a phone. */
    private static final Semaphore gate = new Semaphore(4);
    private static final int MAX_BYTES = 40 << 20;

    interface Got { void ok(Bitmap b); }

    /** Loads into the view (at most `px` on its longer side); `failed` on the UI thread when it
     *  can't be had. */
    static void image(Activity a, Hub hub, String url, ImageView into, int px, Runnable failed) {
        if (url == null || url.isEmpty()) return;
        String key = url + "@" + px;
        into.setTag(key);
        bitmap(a, hub, url, px, b -> {
            if (!key.equals(into.getTag())) return;
            if (b != null) into.setImageBitmap(b);
            else if (failed != null) failed.run();
        });
    }

    /** The picture at `url` (on the PC, or https), `done` on the UI thread (null: none). */
    static void bitmap(Activity a, Hub hub, String url, int px, Got done) {
        String key = url + "@" + px;
        Bitmap b = cache.get(key);
        if (b != null) { done.ok(b); return; }
        synchronized (none) {
            Long at = none.get(url);
            if (at != null && System.currentTimeMillis() - at < NONE_MS) { done.ok(null); return; }
        }
        Ui.pool.execute(() -> {
            Bitmap got = null;
            try {
                gate.acquire();
                try {
                    byte[] d = bytes(hub, url);
                    got = decode(d, px);
                } finally {
                    gate.release();
                }
            } catch (Hub.ApiError e) {
                if (e.code == 404) synchronized (none) { none.put(url, System.currentTimeMillis()); }
            } catch (Exception | OutOfMemoryError ignored) { }
            if (got != null && got.getByteCount() < cache.maxSize() / 4) cache.put(key, got);
            Bitmap fin = got;
            Ui.main.post(() -> { if (!a.isDestroyed()) done.ok(fin); });
        });
    }

    static Bitmap decode(byte[] d, int px) {
        if (d == null || d.length == 0) return null;
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(d, 0, d.length, o);
        int s = 1;
        while (px > 0 && Math.max(o.outWidth, o.outHeight) / (s * 2) >= px) s *= 2;
        BitmapFactory.Options r = new BitmapFactory.Options();
        r.inSampleSize = s;
        return BitmapFactory.decodeByteArray(d, 0, d.length, r);
    }

    /** The bytes at `url`: a path on the PC (its answer `{type, data: base64}`, or the raw bytes),
     *  or an https URL (socials' thumbnails). Not on the UI thread. */
    static byte[] bytes(Hub hub, String url) throws IOException {
        if (url.startsWith("https://")) return https(url);
        if (!url.startsWith("/")) throw new IOException("not a picture the phone can load");
        Net.Http c = hub.open("GET", url, 30_000);
        try {
            int code = c.code();
            byte[] body = readAll(c.in());
            if (code >= 400) throw Hub.error(c, code, new String(body, java.nio.charset.StandardCharsets.UTF_8));
            int i = 0;
            while (i < body.length && body[i] <= ' ') i++;
            if (i < body.length && body[i] == '{') {
                try {
                    JSONObject j = new JSONObject(new String(body, java.nio.charset.StandardCharsets.UTF_8));
                    String data = j.optString("data", "");
                    if (data.isEmpty()) throw new Hub.ApiError(404, "Not found");
                    return android.util.Base64.decode(data, android.util.Base64.DEFAULT);
                } catch (JSONException e) {
                    return body;
                }
            }
            return body;
        } finally {
            c.close();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[1 << 15];
        try (InputStream i = in) {
            for (int n; (n = i.read(buf)) > 0; ) {
                if (out.size() + n > MAX_BYTES) throw new IOException("too big for the phone");
                out.write(buf, 0, n);
            }
        }
        return out.toByteArray();
    }

    private static byte[] https(String url) throws IOException {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        try {
            h.setConnectTimeout(15_000);
            h.setReadTimeout(20_000);
            if (h.getResponseCode() != 200) throw new Hub.ApiError(h.getResponseCode() == 404 ? 404 : h.getResponseCode(), "HTTP " + h.getResponseCode());
            byte[] d = readAll(h.getInputStream());
            if (!"https".equals(h.getURL().getProtocol())) throw new IOException("not https");
            return d;
        } finally {
            h.disconnect();
        }
    }

    /** Files already saved to Download/Hub this run, by URL. */
    private static final Map<String, Uri> saved = new HashMap<>();

    /** An attachment: downloaded from the PC into Download/Hub, then opened in the app for its
     *  type (else the share sheet). */
    static void openFile(Activity a, Hub hub, String url, String name, String type) {
        String n = Inbox.safeName(name == null || name.isEmpty() ? "file" : name);
        String mime = type != null && !type.isEmpty() ? type : Inbox.mime(n, false);
        Uri have;
        synchronized (saved) { have = saved.get(url); }
        if (have != null) { view(a, have, mime, n); return; }
        Ui.toast(a, "Downloading " + n + "…");
        Context c = a.getApplicationContext();
        Ui.bg(a, () -> {
            byte[] d = bytes(hub, url);
            File f = new File(c.getCacheDir(), "persons-" + Integer.toHexString(url.hashCode()));
            try (FileOutputStream o = new FileOutputStream(f)) { o.write(d); }
            try {
                return Inbox.save(c, f, n, mime, false);
            } finally {
                f.delete();
            }
        }, u -> {
            synchronized (saved) { saved.put(url, u); }
            view(a, u, mime, n);
        });
    }

    private static void view(Activity a, Uri u, String mime, String name) {
        try {
            a.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(u, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
            return;
        } catch (ActivityNotFoundException ignored) { }
        try {
            a.startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, u)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), name));
        } catch (ActivityNotFoundException e) {
            Ui.toast(a, "No app on this phone opens " + name);
        }
    }

    /** The full-screen viewer over a chat's pictures (url, name), starting at `at`: pinch and
     *  double-tap zoom, swipe to the next one, a tap or Back closes it. */
    static void viewer(Activity a, Hub hub, List<String[]> all, int at) {
        Dialog d = new Dialog(a, android.R.style.Theme_Black_NoTitleBar);
        android.view.Window win = d.getWindow();
        if (win != null) {
            win.setStatusBarColor(0xff000000);
            win.setNavigationBarColor(0xff000000);
        }
        FrameLayout f = new FrameLayout(a);
        f.setBackgroundColor(0xff000000);
        Images.Zoom z = new Images.Zoom(a);
        f.addView(z, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout bar = Ui.row(a);
        bar.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        bar.setBackgroundColor(0x99000000);
        bar.addView(Ui.iconButton(a, Ui.I_X, 0xffffffff, v -> d.dismiss()));
        TextView title = Ui.subtitle(Ui.text(a, "", 15, 0xffffffff));
        bar.addView(title, Ui.weight());
        f.addView(bar, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));
        int[] cur = {at};
        Runnable show = () -> {
            String[] s = all.get(cur[0]);
            title.setText(all.size() > 1 ? (cur[0] + 1) + "/" + all.size() + "  " + s[1] : s[1]);
            String key = s[0];
            z.setTag(key);
            z.show(null);
            bitmap(a, hub, s[0], 2048, b -> { if (key.equals(z.getTag()) && b != null) z.show(b); });
        };
        z.onSwipe = new Images.Zoom.Swipe() {
            @Override public boolean can(int dir) { int n = cur[0] + dir; return n >= 0 && n < all.size(); }
            @Override public void to(int dir) { if (can(dir)) { cur[0] += dir; show.run(); } }
        };
        z.onTap = () -> bar.setVisibility(bar.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
        d.setContentView(f);
        d.show();
        show.run();
    }
}
