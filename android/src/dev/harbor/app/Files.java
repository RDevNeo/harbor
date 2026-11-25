package dev.harbor.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.net.Uri;
import android.os.Build;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.HashMap;
import java.util.Map;

/** Files an agent attached to a reply (a card's `files`, PROTOCOL.md), drawn like the desktop's
 *  cards: an icon by kind, the name, size and kind, and Download. The download runs off the chat
 *  (the chat keeps scrolling and drawing), by Range over the hub's pinned connection, so a broken
 *  connection goes on where it stopped and a copy of another PC's chat comes part by part; it
 *  lands in Download/Harbor (MediaStore, no permission). Then Open: an APK goes to the package
 *  installer (after "Install unknown apps" for Harbor when that's off), anything else to the app
 *  for its type, else the share sheet. */
final class Files {
    private static final int TIMEOUT = 30_000;
    private static final int RETRIES = 5;

    /** One file's download, by its hub and URL: kept while the app runs, so a card drawn again
     *  (the chat redraws its cards often) shows where it is. */
    static final class Got {
        volatile long done, total = -1;
        volatile boolean running;
        volatile String error;
        volatile Uri saved;
        /** The card that shows it now (the last one drawn). */
        volatile Runnable shown;
        /** When the card was last told (a redraw per 64 KB would flood the UI thread). */
        long posted;
    }

    private static final Map<String, Got> all = new HashMap<>();

    private static Got got(Context c, String key) {
        synchronized (all) {
            Got g = all.get(key);
            if (g == null) {
                g = new Got();
                String u = c.getSharedPreferences("files", 0).getString(key, null);
                if (u != null) g.saved = Uri.parse(u);
                all.put(key, g);
            }
            return g;
        }
    }

    /** The cards of a reply's files, one under the other, or null when it has none. */
    static View list(Activity a, Hub hub, JSONArray files) {
        if (files == null || files.length() == 0) return null;
        LinearLayout col = Ui.col(a);
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f == null || f.optString("url").isEmpty()) continue;
            col.addView(card(a, hub, f), Ui.margins(Ui.fill(), 0, col.getChildCount() == 0 ? 0 : 8, 0, 0));
        }
        return col.getChildCount() == 0 ? null : col;
    }

    private static View card(Activity a, Hub hub, JSONObject f) {
        String name = Inbox.safeName(f.optString("name", "file"));
        String url = f.optString("url");
        String key = hub.id + "|" + url;
        Got g = got(a, key);
        LinearLayout row = Ui.row(a);
        row.setBackground(Ui.round(Ui.CARD, Ui.LINE, 12));
        row.setPadding(Ui.dp(10), Ui.dp(10), Ui.dp(10), Ui.dp(10));
        FrameLayout tile = new FrameLayout(a);
        tile.setBackground(Ui.round(Ui.G100, 0, 8));
        String glyph = f.optString("glyph");
        tile.addView(Ui.icon(a, glyph.isEmpty() ? Ui.I_FILE : glyph, 20, Ui.FG), new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
        row.addView(tile, new LinearLayout.LayoutParams(Ui.dp(40), Ui.dp(40)));
        LinearLayout mid = Ui.col(a);
        TextView title = Ui.bold(a, name, 15, Ui.FG);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        mid.addView(title, Ui.fill());
        String meta = f.optString("meta");
        TextView line = Ui.text(a, meta, 13, Ui.G700);
        line.setSingleLine(true);
        line.setEllipsize(TextUtils.TruncateAt.END);
        mid.addView(line, Ui.margins(Ui.fill(), 0, 2, 0, 0));
        ProgressBar bar = new ProgressBar(a, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(1000);
        bar.setProgressTintList(ColorStateList.valueOf(Ui.FG));
        bar.setProgressBackgroundTintList(ColorStateList.valueOf(Ui.G300));
        mid.addView(bar, Ui.margins(new LinearLayout.LayoutParams(-1, Ui.dp(4)), 0, 6, 0, 0));
        LinearLayout.LayoutParams mp = Ui.weight();
        mp.setMargins(Ui.dp(12), 0, Ui.dp(8), 0);
        row.addView(mid, mp);
        TextView act = Ui.rowButton(a, "Download", false, null);
        act.setBackground(Ui.press(0, Ui.LINE, 18));
        row.addView(act, Ui.wrap());
        boolean apk = FileText.isApk(name);
        Runnable show = () -> {
            boolean running = g.running;
            bar.setVisibility(running ? View.VISIBLE : View.GONE);
            if (running) {
                bar.setIndeterminate(g.total <= 0);
                if (g.total > 0) bar.setProgress((int) (g.done * 1000 / g.total));
                line.setText(FileText.progress(g.done, g.total));
                line.setTextColor(Ui.G700);
            } else if (g.error != null) {
                line.setText("Couldn't download: " + g.error);
                line.setTextColor(Ui.RED);
            } else if (g.saved != null) {
                line.setText(meta.isEmpty() ? "In Download/Hub" : meta + " · In Download/Hub");
                line.setTextColor(Ui.G700);
            } else {
                line.setText(meta);
                line.setTextColor(Ui.G700);
            }
            act.setText(running ? "Cancel" : g.saved != null ? (apk ? "Install" : "Open") : g.error != null ? "Retry" : "Download");
        };
        g.shown = show;
        show.run();
        act.setOnClickListener(v -> {
            if (g.running) { g.running = false; return; } // the download stops at its next part
            if (g.saved != null) { open(a, g, key, name, apk); return; }
            start(a, hub, url, name, key, g);
        });
        row.setContentDescription(name + ", " + meta);
        return row;
    }

    private static void changed(Got g) {
        Runnable r = g.shown;
        if (r != null) Ui.main.post(r);
    }

    private static void start(Activity a, Hub hub, String url, String name, String key, Got g) {
        Context c = a.getApplicationContext();
        g.running = true;
        g.error = null;
        g.done = 0;
        changed(g);
        Ui.pool.execute(() -> {
            File part = new File(c.getCacheDir(), "file-" + Integer.toHexString(key.hashCode()) + ".part");
            try {
                fetch(hub, url, part, g);
                if (!g.running) { changed(g); return; } // cancelled (finally drops the part)
                Uri u = Inbox.save(c, part, name, Inbox.mime(name, false), false);
                g.saved = u;
                c.getSharedPreferences("files", 0).edit().putString(key, u.toString()).apply();
                g.running = false;
                changed(g);
                Ui.main.post(() -> {
                    Ui.toast(c, name + " saved to Download/Hub");
                    if (FileText.isApk(name)) open(a, g, key, name, true);
                });
            } catch (Exception e) {
                g.error = e instanceof Hub.ApiError || e instanceof IOException ? String.valueOf(e.getMessage()) : Hub.why(e);
                g.running = false;
                changed(g);
            } finally {
                part.delete();
            }
        });
    }

    /** The file into {@code to}, part after part: each answer is a Range from where the last one
     *  stopped (a copy of another PC's chat comes 8 MB at a time; a dropped connection goes on). */
    private static void fetch(Hub hub, String url, File to, Got g) throws IOException {
        int fails = 0;
        byte[] buf = new byte[1 << 16];
        try (RandomAccessFile out = new RandomAccessFile(to, "rw")) {
            out.setLength(0);
            long at = 0;
            while (g.running) {
                Net.Http h = null;
                try {
                    h = hub.open("GET", url, TIMEOUT);
                    h.header("Range", "bytes=" + at + "-");
                    int code = h.code();
                    if (code == 416 && g.total == at) break;
                    if (code != 200 && code != 206) {
                        String why = code == 404 ? "it's gone, or the PC that has it is off" : "the PC answered " + code;
                        throw new Hub.ApiError(code, why);
                    }
                    if (code == 200) { at = 0; out.setLength(0); }
                    long total = code == 206 ? Blocks.total(h.range()) : h.length();
                    if (total > 0) g.total = total;
                    out.seek(at);
                    InputStream in = h.in();
                    long began = at;
                    for (int n; g.running && (n = in.read(buf)) > 0; ) {
                        out.write(buf, 0, n);
                        at += n;
                        g.done = at;
                        long now = System.currentTimeMillis();
                        if (now - g.posted > 100) { g.posted = now; changed(g); }
                    }
                    if (g.total > 0 && at >= g.total) break;
                    if (g.total <= 0 && code == 200) break; // all of it, length unsaid
                    if (at == began) throw new IOException("the PC stopped sending it");
                    fails = 0;
                } catch (Hub.ApiError e) {
                    throw e;
                } catch (IOException e) {
                    if (++fails >= RETRIES) throw e;
                    try { Thread.sleep(500L * fails); } catch (InterruptedException x) { throw e; }
                } finally {
                    if (h != null) h.close();
                }
            }
            if (g.running && g.total > 0 && at != g.total) throw new IOException("cut short");
        }
    }

    /** Opens what was saved: an APK in the package installer (Harbor needs "Install unknown apps"
     *  first: the system's page for it opens, and Open is tapped again after), the rest in the
     *  app for its type, else the share sheet. A file deleted from Downloads meanwhile is
     *  downloaded again. */
    static void open(Activity a, Got g, String key, String name, boolean apk) {
        Uri u = g.saved;
        if (u == null) return;
        if (!exists(a, u)) {
            g.saved = null;
            a.getSharedPreferences("files", 0).edit().remove(key).apply();
            changed(g);
            Ui.toast(a, name + " is no longer in Downloads: download it again");
            return;
        }
        if (apk) {
            if (!a.getPackageManager().canRequestPackageInstalls()) {
                Ui.toast(a, "Allow Hub to install apps, then tap Install again");
                try {
                    a.startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
                } catch (ActivityNotFoundException ignored) { }
                return;
            }
            try {
                a.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(u, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                return;
            } catch (ActivityNotFoundException e) {
                // no installer that takes it: the share sheet below
            }
        } else {
            try {
                a.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(u, Inbox.mime(name, false))
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                return;
            } catch (ActivityNotFoundException e) {
                // nothing opens this type: share it
            }
        }
        Intent send = new Intent(Intent.ACTION_SEND).setType(Inbox.mime(name, false)).putExtra(Intent.EXTRA_STREAM, u)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            a.startActivity(Intent.createChooser(send, name));
        } catch (ActivityNotFoundException e) {
            Ui.toast(a, "No app on this phone opens " + name);
        }
    }

    private static boolean exists(Context c, Uri u) {
        if (Build.VERSION.SDK_INT < 29 && "file".equals(u.getScheme())) return new File(String.valueOf(u.getPath())).exists();
        try (android.os.ParcelFileDescriptor fd = c.getContentResolver().openFileDescriptor(u, "r")) {
            return fd != null;
        } catch (Exception e) {
            return false;
        }
    }
}
