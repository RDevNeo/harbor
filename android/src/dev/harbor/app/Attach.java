package dev.harbor.app;

import android.app.Activity;
import android.content.ClipDescription;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/** The composer's attachments: pick a photo (system photo picker) or any file
 *  (ACTION_OPEN_DOCUMENT), take one, or paste one (Composer), upload it to the hub at once and
 *  show it: an image as a thumbnail (tap for the viewer), anything else as a chip. */
final class Attach {
    static final int PICK = 41, SHOT = 42;
    static final int THUMB = 256; // px of a composer thumbnail

    private final Activity a;
    private final Hub hub;
    final HorizontalScrollView view;
    private final LinearLayout chips;
    private final List<Up> ups = new ArrayList<>();

    /** The files changed here (added and uploaded, or removed): the shared draft follows. */
    Runnable onChange;

    private static final class Up {
        String name, id; boolean failed;
        Uri uri;          // on this phone (null: already on the hub)
        String url;       // an image on the hub (a shared draft's), for its thumbnail
        View chip;        // the chip or the thumbnail tile
        TextView text;    // a chip's label
        TextView state;   // a tile's uploading / failed overlay
    }

    private final String chat;

    /** chat: the chat the files are for (null for a new one), so the hub files them there. */
    Attach(Activity a, Hub hub, String chat) {
        this.a = a;
        this.hub = hub;
        this.chat = chat;
        view = new HorizontalScrollView(a);
        view.setHorizontalScrollBarEnabled(false);
        chips = Ui.row(a);
        chips.setPadding(Ui.dp(8), Ui.dp(6), Ui.dp(8), 0);
        view.addView(chips);
        view.setVisibility(View.GONE);
    }

    void choose() {
        Ui.dialog(a).setItems(new String[]{"Photo", "File"}, (d, w) -> { if (w == 0) photos(); else files(); }).show();
    }

    /** The system photo picker (Android 13+), else any image picker. */
    void photos() {
        Intent i = Build.VERSION.SDK_INT >= 33
                ? new Intent(MediaStore.ACTION_PICK_IMAGES).putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 10)
                : new Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE)
                        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        launch(i);
    }

    void files() {
        launch(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE)
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true));
    }

    private Uri shot; // where the camera app writes the photo (CamProvider)

    /** The camera app takes a full-size photo into a file of ours (CamProvider). The app
     *  declares CAMERA (for the pairing scanner), and then Android refuses IMAGE_CAPTURE until
     *  it is granted: ask first. */
    void camera() {
        if (a.checkSelfPermission(android.Manifest.permission.CAMERA) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            a.requestPermissions(new String[]{android.Manifest.permission.CAMERA}, SHOT);
            return;
        }
        try {
            shot = CamProvider.newShot(a);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, shot)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            a.startActivityForResult(i, SHOT);
        } catch (Exception e) {
            Ui.toast(a, "No camera app");
        }
    }

    /** Call from onRequestPermissionsResult. */
    void permission(int req, int[] granted) {
        if (req != SHOT) return;
        if (granted.length > 0 && granted[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) camera();
        else Ui.toast(a, "Harbor needs the camera permission to take a photo");
    }

    private void launch(Intent i) {
        try { a.startActivityForResult(i, PICK); } catch (Exception e) { Ui.toast(a, "No app to pick files with"); }
    }

    /** Call from onActivityResult; true when it was ours. */
    boolean result(int req, int res, Intent data) {
        if (req == SHOT) {
            if (res == Activity.RESULT_OK && shot != null) add(shot, null);
            shot = null;
            return true;
        }
        if (req != PICK) return false;
        if (res != Activity.RESULT_OK || data == null) return true;
        if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) add(data.getClipData().getItemAt(i).getUri(), null);
        else if (data.getData() != null) add(data.getData(), null);
        return true;
    }

    /** An image pasted or sent by the keyboard, attached like a pick. done (if any) runs once
     *  it is uploaded or failed: a keyboard's read permission can end then. */
    void paste(Uri uri, Runnable done) { add(uri, done); }

    /** Whether uri is an image: its type, else the clip's, else its name. */
    static boolean image(Context c, Uri uri, ClipDescription d) {
        String t = null;
        try { t = c.getContentResolver().getType(uri); } catch (Exception ignored) { }
        if (t != null) return t.startsWith("image/");
        if (d != null && d.hasMimeType("image/*")) return true;
        String s = uri.getLastPathSegment();
        return s != null && isImage(s);
    }

    /** A file already on the hub (an upload id), e.g. from a stopped turn's queue. */
    void addUploaded(String id) {
        if (id == null || id.isEmpty()) return;
        Up u = new Up();
        u.id = id;
        u.name = id.substring(id.lastIndexOf('/') + 1);
        chip(u);
    }

    /** The shared draft's files (PROTOCOL.md "Typing": [{id, name, path}]), in place of the
     *  ones here; ones being uploaded here stay. */
    void setRemote(JSONArray files, String chatId) {
        java.util.List<String> want = new ArrayList<>();
        for (int i = 0; files != null && i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f != null && !f.optString("id").isEmpty()) want.add(f.optString("id"));
        }
        java.util.List<String> have = new ArrayList<>();
        for (Up u : ups) if (u.id != null) have.add(u.id);
        if (want.equals(have)) return;
        for (Up u : new ArrayList<>(ups)) if (u.id != null || u.failed) { ups.remove(u); chips.removeView(u.chip); }
        for (int i = 0; files != null && i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f == null || f.optString("id").isEmpty()) continue;
            Up u = new Up();
            u.id = f.optString("id");
            u.name = f.optString("name", u.id.substring(u.id.lastIndexOf('/') + 1));
            String path = f.optString("path");
            if (!path.isEmpty() && isImage(u.name)) u.url = "/v1/image?path=" + Uri.encode(path) + "&max=512" + (chatId == null ? "" : "&chat=" + Uri.encode(chatId));
            chip(u);
        }
        show();
    }

    private void changed() { if (onChange != null) onChange.run(); }

    private void chip(Up u) {
        if ((u.uri != null || u.url != null) && isImage(u.name)) tile(u);
        else {
            u.text = Ui.text(a, "", 13, Ui.FG);
            u.text.setPadding(Ui.dp(10), Ui.dp(6), Ui.dp(10), Ui.dp(6));
            u.text.setBackground(Ui.round(Ui.G100, 0, 14));
            u.text.setOnClickListener(v -> remove(u));
            u.chip = u.text;
        }
        ups.add(u);
        LinearLayout.LayoutParams p = u.text != null ? Ui.wrap() : new LinearLayout.LayoutParams(Ui.dp(72), Ui.dp(72));
        p.rightMargin = Ui.dp(6);
        p.gravity = Gravity.BOTTOM;
        chips.addView(u.chip, p);
        label(u);
        show();
    }

    /** An image about to be sent: its thumbnail, a remove badge on the corner, and a veil
     *  while it uploads (or when it failed). */
    private void tile(Up u) {
        FrameLayout f = new FrameLayout(a);
        ImageView iv = Images.tile(a, u.name);
        f.addView(iv, new FrameLayout.LayoutParams(Ui.dp(64), Ui.dp(64), Gravity.BOTTOM | Gravity.START));
        u.state = Ui.icon(a, Ui.I_LOADER, 18, 0xffffffff);
        u.state.setBackground(Ui.round(0x73000000, 0, 12));
        f.addView(u.state, new FrameLayout.LayoutParams(Ui.dp(64), Ui.dp(64), Gravity.BOTTOM | Gravity.START));
        TextView x = Ui.icon(a, Ui.I_X, 12, Ui.ON_INK);
        x.setBackground(Ui.round(Ui.INK, Ui.CARD, 11));
        x.setContentDescription("Remove " + u.name);
        x.setOnClickListener(v -> remove(u));
        f.addView(x, new FrameLayout.LayoutParams(Ui.dp(22), Ui.dp(22), Gravity.TOP | Gravity.END));
        View.OnClickListener open = v -> {
            List<Images.Src> all = new ArrayList<>();
            int at = 0;
            for (Up o : ups) {
                if (o.uri != null && isImage(o.name)) { if (o == u) at = all.size(); all.add(new Images.Src(o.uri, o.name)); }
                else if (o.url != null) { if (o == u) at = all.size(); all.add(new Images.Src(hub, o.url, o.name)); }
            }
            Images.view(a, all, at);
        };
        iv.setOnClickListener(open);
        u.state.setOnClickListener(open);
        if (u.uri != null) Images.local(a, u.uri, THUMB, iv);
        else Images.load(a, hub, u.url, iv);
        u.chip = f;
    }

    private void remove(Up u) {
        ups.remove(u);
        chips.removeView(u.chip);
        show();
        changed();
    }

    private void add(Uri uri, Runnable done) {
        Up u = new Up();
        u.uri = uri;
        u.name = name(uri);
        chip(u);
        Ui.pool.execute(() -> {
            try {
                long size = size(uri);
                JSONObject r;
                if (size >= 0) {
                    try (InputStream in = a.getContentResolver().openInputStream(uri)) { r = hub.upload(u.name, chat, in, size); }
                } else {
                    // Unknown size: spool it so the upload has a Content-Length.
                    File tmp = File.createTempFile("up", null, a.getCacheDir());
                    try {
                        try (InputStream in = a.getContentResolver().openInputStream(uri); OutputStream o = new FileOutputStream(tmp)) {
                            byte[] buf = new byte[1 << 16];
                            for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
                        }
                        try (InputStream in = new FileInputStream(tmp)) { r = hub.upload(u.name, chat, in, tmp.length()); }
                    } finally {
                        tmp.delete();
                    }
                }
                u.id = r.optString("id");
            } catch (Exception e) {
                u.failed = true;
                String why = Hub.why(e);
                Ui.main.post(() -> Ui.toast(a, u.name + ": " + why));
            }
            Ui.main.post(() -> {
                label(u);
                if (done != null) done.run();
                changed();
            });
        });
    }

    private void label(Up u) {
        if (u.state != null) {
            u.state.setVisibility(u.failed || u.id == null ? View.VISIBLE : View.GONE);
            u.state.setText(u.failed ? Ui.I_ALERT : Ui.I_LOADER);
            u.state.setTextColor(u.failed ? Ui.RED : 0xffffffff);
            u.state.setContentDescription(u.failed ? u.name + " failed to upload" : "Uploading " + u.name);
            return;
        }
        String state = u.failed ? "  failed" : u.id == null ? "  …" : "";
        u.text.setText((isImage(u.name) ? "▣ " : "▤ ") + u.name + state + "  ✕");
        u.text.setTextColor(u.failed ? Ui.RED : u.id == null ? Ui.G700 : Ui.FG);
    }

    private void show() { view.setVisibility(ups.isEmpty() ? View.GONE : View.VISIBLE); }

    boolean busy() {
        for (Up u : ups) if (u.id == null && !u.failed) return true;
        return false;
    }

    boolean any() { return !ups.isEmpty(); }

    JSONArray ids() {
        JSONArray a = new JSONArray();
        for (Up u : ups) if (u.id != null) a.put(u.id);
        return a;
    }

    void clear() {
        ups.clear();
        chips.removeAllViews();
        show();
    }

    /** The file's name; an image without an image extension (a pasted one is often just a
     *  number) gets one from its type, so the hub and the agent see an image. */
    private String name(Uri uri) {
        String n = null;
        try (Cursor c = a.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            int i = c == null ? -1 : c.getColumnIndex(OpenableColumns.DISPLAY_NAME); // some providers send other columns
            if (i >= 0 && c.moveToFirst() && c.getString(i) != null) n = c.getString(i);
        } catch (Exception ignored) { }
        if (n == null) {
            String s = uri.getLastPathSegment();
            n = s == null || s.isEmpty() ? "pasted" : s.substring(s.lastIndexOf('/') + 1);
        }
        String t = null;
        try { t = a.getContentResolver().getType(uri); } catch (Exception ignored) { }
        if (t != null && t.startsWith("image/") && !isImage(n)) {
            String ext = t.substring(6).toLowerCase();
            ext = ext.equals("jpeg") ? "jpg" : ext.equals("heif") ? "heic" : ext.replaceAll("[^a-z0-9].*", "");
            n = n + "." + (ext.isEmpty() ? "png" : ext);
        }
        return n;
    }

    private long size(Uri uri) {
        try (Cursor c = a.getContentResolver().query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            int i = c == null ? -1 : c.getColumnIndex(OpenableColumns.SIZE);
            if (i >= 0 && c.moveToFirst() && !c.isNull(i)) return c.getLong(i);
        } catch (Exception ignored) { }
        return -1;
    }

    static boolean isImage(String n) {
        String l = n.toLowerCase();
        return l.endsWith(".png") || l.endsWith(".jpg") || l.endsWith(".jpeg") || l.endsWith(".webp") || l.endsWith(".gif") || l.endsWith(".heic");
    }
}
