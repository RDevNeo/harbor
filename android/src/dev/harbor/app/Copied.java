package dev.harbor.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/** Copy of a message (its sheet's Copy, or Copy on a selection in it) with its images, as the
 *  desktop copies one (ts clipboard.ts `copyRich`): the PC's images come here, then one clip
 *  holds the text and them. Its first item has both the text and the first image, so a plain
 *  text box still pastes just the text while apps that take images (WhatsApp, Telegram, Gmail,
 *  Harbor's own composer) get the images too. The images are content:// URIs of CamProvider
 *  (clip/), which the clipboard lets the pasting app read. */
final class Copied {
    static final String LABEL = "Harbor message";
    /** Past this, an image is left out (it would be a slow copy). */
    private static final int MAX_BYTES = 32 << 20;

    /** The last copy made here, so Harbor's composer can give its `[Image #k]` tokens back. Kept
     *  in cache/clip too (SAVED): Android may end the app between the copy and the paste. */
    static final class Info {
        final String text; final List<Uri> uris; final boolean named;
        Info(String text, List<Uri> uris, boolean named) { this.text = text; this.uris = uris; this.named = named; }
    }
    private static volatile Info last;
    private static final String SAVED = "last.json";
    /** Each copy's files get their own names: a clip still pasting never reads the next one's. */
    private static volatile int seq = (int) (System.currentTimeMillis() / 1000 % 100_000_000); // not an earlier run's names

    static File dir(Context c) {
        File d = new File(c.getCacheDir(), "clip");
        d.mkdirs();
        return d;
    }

    static Uri uri(File f) { return Uri.parse("content://" + CamProvider.AUTHORITY + "/clip/" + Uri.encode(f.getName())); }

    /** Copies `text` and the images of `images` (videos are left out). `named`: the text is a
     *  user message's, whose `[Image #k]` names its k-th image. */
    static void copy(Activity a, Hub hub, String text, List<Images.Src> images, boolean named) {
        List<Images.Src> pics = new ArrayList<>();
        for (Images.Src s : images) if (!s.video() && s.hub != null && s.url != null) pics.add(s);
        if (pics.isEmpty()) { Ui.copy(a, text); return; }
        Context c = a.getApplicationContext();
        int n = ++seq;
        Ui.pool.execute(() -> {
            File d = dir(c);
            last = null; // its images go now
            File[] old = d.listFiles();
            if (old != null) for (File f : old) if (!f.getName().startsWith(n + "-")) f.delete();
            List<Uri> uris = new ArrayList<>();
            List<String> types = new ArrayList<>();
            for (int i = 0; i < pics.size(); i++) {
                Images.Src s = pics.get(i);
                File f = new File(d, n + "-" + (i + 1) + "-" + Inbox.safeName(s.name == null || s.name.isEmpty() ? "image.png" : s.name));
                String type = fetch(hub, s.url, f);
                if (type == null) continue;
                uris.add(uri(f));
                if (!types.contains(type)) types.add(type);
            }
            Ui.main.post(() -> {
                if (n != seq) return; // a later copy came first
                if (uris.isEmpty()) {
                    // Said, not silent: a paste of just the text would look like this feature failing.
                    ((ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Harbor", text));
                    Ui.toast(c, pics.size() == 1 ? "Copied the text: its image couldn't be fetched" : "Copied the text: its images couldn't be fetched");
                    return;
                }
                List<String> mimes = new ArrayList<>();
                mimes.add(ClipDescription.MIMETYPE_TEXT_PLAIN);
                mimes.addAll(types);
                ClipData clip = new ClipData(new ClipDescription(LABEL, mimes.toArray(new String[0])), new ClipData.Item(text, null, null, uris.get(0)));
                // The others with an empty text: a plain text box pastes nothing for them, not their address.
                for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item("", null, null, uris.get(i)));
                last = new Info(text, uris, named);
                save(c, last, n);
                ((ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(clip);
                Ui.toast(c, uris.size() == 1 ? "Copied with its image" : "Copied with " + uris.size() + " images");
            });
        });
    }

    /** The image at `url` on the hub (its full size: the URL's max= dropped) into `to`; its type, or null. */
    private static String fetch(Hub hub, String url, File to) {
        String full = url.replaceAll("&max=\\d+", "").replaceAll("\\?max=\\d+&", "?").replaceAll("\\?max=\\d+$", "");
        Net.Http h = null;
        try {
            h = hub.open("GET", full, 30_000);
            if (h.code() != 200) return null;
            long got = 0;
            byte[] buf = new byte[1 << 16];
            byte[] head = new byte[12];
            int headLen = 0;
            try (InputStream in = h.in(); OutputStream out = new FileOutputStream(to)) {
                for (int k; (k = in.read(buf)) > 0; ) {
                    if (headLen < head.length) {
                        int m = Math.min(k, head.length - headLen);
                        System.arraycopy(buf, 0, head, headLen, m);
                        headLen += m;
                    }
                    out.write(buf, 0, k);
                    got += k;
                    if (got > MAX_BYTES) throw new IOException("too big");
                }
            }
            String type = sniff(head, headLen);
            if (type == null) to.delete();
            return type;
        } catch (IOException | RuntimeException e) {
            to.delete();
            return null;
        } finally {
            if (h != null) h.close();
        }
    }

    /** An image's type from its first bytes (the hub sends PNG, JPEG, GIF or WebP); null: not an image. */
    static String sniff(byte[] b, int n) {
        if (n >= 4 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
        if (n >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff) return "image/jpeg";
        if (n >= 4 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8') return "image/gif";
        if (n >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
        return null;
    }

    private static void save(Context c, Info l, int n) {
        try {
            org.json.JSONArray us = new org.json.JSONArray();
            for (Uri u : l.uris) us.put(u.toString());
            String json = new org.json.JSONObject().put("text", l.text).put("named", l.named).put("uris", us).toString();
            Ui.pool.execute(() -> {
                if (n != seq) return;
                try (OutputStream o = new FileOutputStream(new File(dir(c), SAVED))) { o.write(json.getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
                catch (IOException ignored) { }
            });
        } catch (org.json.JSONException ignored) { }
    }

    /** The last copy: this run's, or the one an earlier run saved, while its images are still here. */
    private static Info last(Context c) {
        Info l = last;
        if (l != null || c == null) return l;
        File f = new File(dir(c), SAVED);
        if (!f.isFile()) return null;
        try {
            org.json.JSONObject o = new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()), java.nio.charset.StandardCharsets.UTF_8));
            org.json.JSONArray us = o.getJSONArray("uris");
            List<Uri> uris = new ArrayList<>();
            for (int i = 0; i < us.length(); i++) {
                Uri u = Uri.parse(us.getString(i));
                if (!new File(dir(c), String.valueOf(u.getLastPathSegment())).isFile()) return null;
                uris.add(u);
            }
            if (uris.isEmpty()) return null;
            return last = new Info(o.getString("text"), uris, o.optBoolean("named"));
        } catch (IOException | org.json.JSONException e) {
            return null;
        }
    }

    /** The copy made here that `clip` is, or null: the clip itself still, or its text alone (a
     *  phone's own clipboard, Samsung's, or a clipboard app may hand the text back without the
     *  images, or with copies of them under its own addresses). */
    static Info mine(Context c, ClipData clip) {
        Info l = last(c);
        if (l == null || clip == null) return null;
        if (clip.getDescription() != null && LABEL.contentEquals(clip.getDescription().getLabel()) && clip.getItemCount() == l.uris.size()) {
            boolean same = true;
            for (int i = 0; i < clip.getItemCount(); i++) same &= l.uris.get(i).equals(clip.getItemAt(i).getUri());
            if (same) return l;
        }
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < clip.getItemCount(); i++) if (clip.getItemAt(i).getText() != null) text.append(clip.getItemAt(i).getText());
        return ClipMatch.same(l.text, text) ? l : null;
    }

    /** The copy made here whose text `typed` is (a keyboard's clipboard types just the text), or null. */
    static Info typed(Context c, CharSequence typed) {
        Info l = last(c);
        return l != null && ClipMatch.same(l.text, typed) ? l : null;
    }
}
