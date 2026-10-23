package dev.harbor.app;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.View;
import android.widget.HorizontalScrollView;
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
 *  (ACTION_OPEN_DOCUMENT), upload it to the hub at once, show it as a removable chip. */
final class Attach {
    static final int PICK = 41, SHOT = 42;

    private final Activity a;
    private final Hub hub;
    final HorizontalScrollView view;
    private final LinearLayout chips;
    private final List<Up> ups = new ArrayList<>();

    private static final class Up {
        String name, id; boolean failed; TextView chip;
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

    /** The camera app takes a full-size photo into a file of ours (CamProvider). */
    void camera() {
        try {
            shot = CamProvider.newShot(a);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, shot)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            a.startActivityForResult(i, SHOT);
        } catch (Exception e) {
            Ui.toast(a, "No camera app");
        }
    }

    private void launch(Intent i) {
        try { a.startActivityForResult(i, PICK); } catch (Exception e) { Ui.toast(a, "No app to pick files with"); }
    }

    /** Call from onActivityResult; true when it was ours. */
    boolean result(int req, int res, Intent data) {
        if (req == SHOT) {
            if (res == Activity.RESULT_OK && shot != null) add(shot);
            shot = null;
            return true;
        }
        if (req != PICK) return false;
        if (res != Activity.RESULT_OK || data == null) return true;
        if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) add(data.getClipData().getItemAt(i).getUri());
        else if (data.getData() != null) add(data.getData());
        return true;
    }

    /** A file already on the hub (an upload id), e.g. from a stopped turn's queue. */
    void addUploaded(String id) {
        if (id == null || id.isEmpty()) return;
        Up u = new Up();
        u.id = id;
        u.name = id.substring(id.lastIndexOf('/') + 1);
        chip(u);
    }

    private void chip(Up u) {
        u.chip = Ui.text(a, "", 13, Ui.FG);
        u.chip.setPadding(Ui.dp(10), Ui.dp(6), Ui.dp(10), Ui.dp(6));
        u.chip.setBackground(Ui.round(Ui.G100, 0, 14));
        u.chip.setOnClickListener(v -> { ups.remove(u); chips.removeView(u.chip); show(); });
        ups.add(u);
        chips.addView(u.chip, Ui.margins(Ui.wrap(), 0, 0, 6, 0));
        label(u);
        show();
    }

    private void add(Uri uri) {
        Up u = new Up();
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
            Ui.main.post(() -> label(u));
        });
    }

    private void label(Up u) {
        String state = u.failed ? "  failed" : u.id == null ? "  …" : "";
        u.chip.setText((isImage(u.name) ? "▣ " : "▤ ") + u.name + state + "  ✕");
        u.chip.setTextColor(u.failed ? Ui.RED : u.id == null ? Ui.G700 : Ui.FG);
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

    private String name(Uri uri) {
        try (Cursor c = a.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (Exception ignored) { }
        String s = uri.getLastPathSegment();
        return s == null ? "file" : s.substring(s.lastIndexOf('/') + 1);
    }

    private long size(Uri uri) {
        try (Cursor c = a.getContentResolver().query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) { }
        return -1;
    }

    static boolean isImage(String n) {
        String l = n.toLowerCase();
        return l.endsWith(".png") || l.endsWith(".jpg") || l.endsWith(".jpeg") || l.endsWith(".webp") || l.endsWith(".gif") || l.endsWith(".heic");
    }
}
