package dev.harbor.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** Installs the APK the hub serves (GET /app.apk) over this app, through a PackageInstaller
 *  session. Needs "Install unknown apps" for Harbor once. Android 12+ updates an app that
 *  installs itself without asking; older ones (or the first time) show the system dialog.
 *  The same key must sign every build, or Android refuses the update. Gets the result too. */
public class Update extends BroadcastReceiver {
    static volatile boolean busy;

    interface Progress { void at(long done, long total); }

    /** Blocking: downloads and commits the session. Run off the UI thread. */
    static void install(Context c, Hub hub, Progress progress) throws Exception {
        if (busy) throw new IOException("already updating");
        Tailnet.Http http = hub.open("GET", "/app.apk", 60_000, false);
        try {
            int code = http.code();
            if (code != 200) throw new IOException("the PC has no app to send (HTTP " + code + ")");
            long size = http.length();
            if (size <= 0) throw new IOException("the PC sent no size for the app");
            PackageInstaller pi = c.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            p.setAppPackageName(c.getPackageName());
            if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            int id = pi.createSession(p);
            try (PackageInstaller.Session s = pi.openSession(id); InputStream in = http.in()) {
                try (OutputStream out = s.openWrite("app.apk", 0, size)) {
                    byte[] buf = new byte[1 << 16];
                    long done = 0;
                    while (done < size) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, size - done));
                        if (n < 0) throw new IOException("the download stopped early");
                        out.write(buf, 0, n);
                        done += n;
                        if (progress != null) progress.at(done, size);
                    }
                    s.fsync(out);
                }
                busy = true;
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                s.commit(PendingIntent.getBroadcast(c, id, new Intent(c, Update.class).setAction("status"), flags).getIntentSender());
            } catch (Exception e) {
                busy = false;
                pi.abandonSession(id);
                throw e;
            }
        } finally {
            http.close();
        }
    }

    @Override
    public void onReceive(Context c, Intent i) {
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Android 8–11, or the first update of a browser-installed copy: the system asks.
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                try { c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return; } catch (Exception ignored) { }
            }
            busy = false;
        } else {
            busy = false;
            if (st != PackageInstaller.STATUS_SUCCESS) {
                String why = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                Toast.makeText(c, "Harbor couldn't update: " + (why == null ? "status " + st : why), Toast.LENGTH_LONG).show();
            }
        }
    }
}
