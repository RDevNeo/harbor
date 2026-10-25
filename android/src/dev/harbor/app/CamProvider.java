package dev.harbor.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Hands the camera app a file to write its photo into (content://dev.harbor.app.cam/<name>),
 *  without a support library's FileProvider. Only files under cache/camera, only to apps the
 *  intent grants. Shots older than a day are removed when a new one starts. */
public class CamProvider extends ContentProvider {
    static final String AUTHORITY = "dev.harbor.app.cam";

    static File dir(Context c) {
        File d = new File(c.getCacheDir(), "camera");
        d.mkdirs();
        return d;
    }

    static Uri newShot(Context c) {
        File d = dir(c);
        File[] old = d.listFiles();
        if (old != null) for (File f : old) if (System.currentTimeMillis() - f.lastModified() > 86_400_000L) f.delete();
        String name = "photo-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + ".jpg";
        return Uri.parse("content://" + AUTHORITY + "/" + name);
    }

    /** Android 9 and older: what the PCs send (Inbox) stays in the app's own folder, shared
     *  from here as content://dev.harbor.app.cam/recv/<name>. */
    static File received(Context c) {
        File d = new File(c.getExternalFilesDir(null) != null ? c.getExternalFilesDir(null) : c.getFilesDir(), "received");
        d.mkdirs();
        return d;
    }

    static Uri receivedUri(File f) {
        return Uri.parse("content://" + AUTHORITY + "/recv/" + Uri.encode(f.getName()));
    }

    private File file(Uri u) throws FileNotFoundException {
        String n = u.getLastPathSegment();
        if (n == null || n.contains("/") || n.startsWith(".")) throw new FileNotFoundException();
        java.util.List<String> segs = u.getPathSegments();
        if (segs.size() == 2 && "recv".equals(segs.get(0))) return new File(received(getContext()), n);
        if (segs.size() != 1) throw new FileNotFoundException();
        return new File(dir(getContext()), n);
    }

    private static boolean isReceived(Uri u) {
        return u.getPathSegments().size() == 2 && "recv".equals(u.getPathSegments().get(0));
    }

    @Override public boolean onCreate() { return true; }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        // Received files are only read through here; the camera writes its shot.
        if (isReceived(uri) && mode.contains("w")) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.parseMode(mode.contains("w") ? "rwt" : "r"));
    }

    @Override
    public Cursor query(Uri uri, String[] cols, String sel, String[] args, String order) {
        File f;
        try { f = file(uri); } catch (FileNotFoundException e) { return null; }
        if (cols == null) cols = new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++)
            row[i] = OpenableColumns.DISPLAY_NAME.equals(cols[i]) ? f.getName() : OpenableColumns.SIZE.equals(cols[i]) ? f.length() : null;
        c.addRow(row);
        return c;
    }

    @Override public String getType(Uri uri) {
        return isReceived(uri) ? Inbox.mime(String.valueOf(uri.getLastPathSegment()), false) : "image/jpeg";
    }
    @Override public Uri insert(Uri uri, ContentValues v) { return null; }
    @Override public int delete(Uri uri, String s, String[] a) { return 0; }
    @Override public int update(Uri uri, ContentValues v, String s, String[] a) { return 0; }
}
