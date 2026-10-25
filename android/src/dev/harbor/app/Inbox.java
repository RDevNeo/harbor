package dev.harbor.app;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** What the user's PCs send this phone (Harbor › Devices › Send on a PC): text or an image for
 *  the clipboard, images that open in the photo app, files for Downloads. Each waits on the PC
 *  that sent it (GET /v1/inbox) until it's picked up here, which happens while the app is open:
 *  from every PC of every pairing every 30 s, and at once when the events long-poll says
 *  something waits. */
final class Inbox {
    private static final long SWEEP = 30_000;
    private static final Object lock = new Object();
    /** hub/pc/id taken in already: a lost "done" never makes it happen twice. */
    private static final Set<String> handled = new HashSet<>();
    private static int open;   // resumed screens
    private static int gen;    // bumped to stop the sweep loop
    private static long last;  // when the last sweep started
    private static Activity current;

    static void resumed(Activity a) {
        current = a;
        if (open++ == 0) start();
    }

    static void paused(Activity a) {
        if (current == a) current = null;
        if (open > 0 && --open == 0) gen++;
    }

    /** The events long-poll of h (now through PC v) says something waits. */
    static void poke(Hub h, String v) {
        Ui.pool.execute(() -> check(h, v));
    }

    private static void start() {
        final int my = ++gen;
        Ui.pool.execute(() -> {
            while (my == gen) {
                // Screens come and go quickly: no new sweep for each of them.
                if (System.currentTimeMillis() - last > SWEEP / 3 && Ui.app != null) {
                    last = System.currentTimeMillis();
                    for (Hub h : Hub.all(Ui.app))
                        for (String v : h.endpoints()) {
                            if (my != gen) return;
                            check(h, v);
                        }
                }
                try { Thread.sleep(SWEEP); } catch (InterruptedException e) { return; }
            }
        });
    }

    private static void check(Hub h, String v) {
        synchronized (lock) {
            JSONArray items;
            try {
                items = h.callOn(v, "GET", "/v1/inbox", null).optJSONArray("items");
            } catch (Exception e) {
                return; // that PC is away (or older than this feature)
            }
            if (items == null) return;
            String from = h.labelOn(v);
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it == null) continue;
                String id = it.optString("id"), key = h.id + "/" + v + "/" + id;
                String err = null;
                if (!handled.contains(key)) {
                    try {
                        File got = "text".equals(it.optString("kind")) ? null : download(h, v, id);
                        take(it, got, from);
                    } catch (Hub.ApiError e) {
                        err = e.getMessage();
                    } catch (IOException e) {
                        continue; // the connection broke: the next sweep tries again
                    } catch (Exception e) {
                        err = Hub.why(e);
                    }
                    handled.add(key);
                }
                try {
                    JSONObject b = new JSONObject();
                    if (err != null) b.put("error", err);
                    h.callOn(v, "POST", "/v1/inbox/" + URLEncoder.encode(id, "UTF-8") + "/done", b);
                } catch (Exception ignored) { } // asked again next time; handled keeps it single
            }
        }
    }

    /** The parcel's bytes into a file of the app's cache. */
    private static File download(Hub h, String v, String id) throws IOException {
        Net.Http c = h.openOn(v, "GET", "/v1/inbox/" + URLEncoder.encode(id, "UTF-8"), 60_000);
        try {
            int code = c.code();
            if (code >= 400) throw new Hub.ApiError(code, "the PC no longer has it (HTTP " + code + ")");
            File f = new File(Ui.app.getCacheDir(), "inbox-" + id.replaceAll("[^0-9A-Za-z]", ""));
            long n = 0;
            try (InputStream in = c.in(); OutputStream o = new FileOutputStream(f)) {
                byte[] buf = new byte[1 << 16];
                for (int r; (r = in.read(buf)) > 0; n += r) o.write(buf, 0, r);
            }
            if (c.length() >= 0 && n != c.length()) { f.delete(); throw new IOException("cut short"); }
            return f;
        } finally {
            c.close();
        }
    }

    /** Does with a parcel what it's for. */
    private static void take(JSONObject it, File got, String from) throws Exception {
        Context c = Ui.app;
        String kind = it.optString("kind"), name = safeName(it.optString("name"));
        if ("text".equals(kind)) {
            String text = it.optString("text");
            Ui.main.post(() -> {
                ((ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Harbor", text));
                Ui.toast(c, "Copied text from " + from);
            });
            return;
        }
        boolean image = !"file".equals(kind);
        String mime = mime(name, image);
        Uri u;
        try {
            u = save(c, got, name, mime, image);
        } catch (IOException e) {
            throw new Exception("couldn't save " + name + ": " + Hub.why(e)); // not retried: told to the PC
        } finally {
            got.delete();
        }
        final Uri uri = u;
        switch (kind) {
            case "clip-image":
                Ui.main.post(() -> {
                    ((ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newUri(c.getContentResolver(), name, uri));
                    Ui.toast(c, "Image copied from " + from);
                });
                break;
            case "image":
                Ui.main.post(() -> {
                    Ui.toast(c, "Image from " + from + " saved to Pictures/Harbor");
                    Activity a = current;
                    if (a != null) try { a.startActivity(view(uri, mime)); } catch (Exception ignored) { }
                });
                notify(c, name, "From " + from + ", in Pictures/Harbor", uri, mime);
                break;
            default:
                Ui.main.post(() -> Ui.toast(c, name + " from " + from + " saved to Download/Harbor"));
                notify(c, name, "From " + from + ", in Download/Harbor. Tap to open it.", uri, mime);
        }
    }

    /** Into the shared Pictures/Harbor or Download/Harbor (Android 10+, no permission needed);
     *  older Androids keep it in the app's own folder, shared through CamProvider. */
    private static Uri save(Context c, File f, String name, String mime, boolean image) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = c.getContentResolver();
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            cv.put(MediaStore.MediaColumns.RELATIVE_PATH, (image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS) + "/Harbor");
            cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri where = image ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                    : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            Uri u = cr.insert(where, cv);
            if (u == null) throw new IOException("the phone's storage refused the file");
            try (InputStream in = new FileInputStream(f); OutputStream o = cr.openOutputStream(u)) {
                if (o == null) throw new IOException("the phone's storage refused the file");
                copy(in, o);
            } catch (IOException e) {
                cr.delete(u, null, null);
                throw e;
            }
            cv.clear();
            cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(u, cv, null, null);
            return u;
        }
        File dir = CamProvider.received(c);
        File to = new File(dir, name);
        for (int n = 1; to.exists(); n++) {
            int dot = name.lastIndexOf('.');
            to = new File(dir, dot > 0 ? name.substring(0, dot) + " (" + n + ")" + name.substring(dot) : name + " (" + n + ")");
        }
        try (InputStream in = new FileInputStream(f); OutputStream o = new FileOutputStream(to)) {
            copy(in, o);
        }
        return CamProvider.receivedUri(to);
    }

    private static void copy(InputStream in, OutputStream o) throws IOException {
        byte[] buf = new byte[1 << 16];
        for (int r; (r = in.read(buf)) > 0; ) o.write(buf, 0, r);
    }

    private static Intent view(Uri u, String mime) {
        return new Intent(Intent.ACTION_VIEW).setDataAndType(u, mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    /** A notification that opens the file (when the user allows Harbor's notifications; asked
     *  once, the first time something arrives). */
    private static void notify(Context c, String title, String text, Uri u, String mime) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            Activity a = current;
            if (a != null && !c.getSharedPreferences("inbox", 0).getBoolean("asked", false)) {
                c.getSharedPreferences("inbox", 0).edit().putBoolean("asked", true).apply();
                Ui.main.post(() -> a.requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 41));
            }
            return;
        }
        nm.createNotificationChannel(new NotificationChannel("received", "Sent from your PCs", NotificationManager.IMPORTANCE_DEFAULT));
        int id = u.hashCode();
        PendingIntent pi = PendingIntent.getActivity(c, id, view(u, mime), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        nm.notify(id, new Notification.Builder(c, "received").setSmallIcon(c.getApplicationInfo().icon)
                .setContentTitle(title).setContentText(text).setContentIntent(pi).setAutoCancel(true).build());
    }

    static String mime(String name, boolean image) {
        int dot = name.lastIndexOf('.');
        String m = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return m != null ? m : image ? "image/png" : "application/octet-stream";
    }

    /** A file name the PC chose, made safe for a folder of ours. */
    static String safeName(String n) {
        n = n.replaceAll("[/\\\\\\x00-\\x1f]", "_").trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.length() > 120) n = n.substring(n.length() - 120);
        return n.isEmpty() ? "file" : n;
    }
}
