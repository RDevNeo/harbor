package dev.harbor.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.function.Consumer;

/** Pairing with three factors on the phone's side (Hub.pair3): asks for the unlock, then shows
 *  the 6-digit code the PC shows too, and waits while the person at the PC compares and confirms. */
final class Pair {
    private Pair() { }

    private static boolean offering;

    /** The PC asks this pairing (from before three factors) to upgrade: say why, once at a time. */
    static void offerUpgrade(Activity a, Hub h) {
        if (offering || a.isFinishing()) return;
        offering = true;
        Ui.dialog(a).setTitle("Upgrade the pairing with " + h.label())
                .setMessage("Your PC now asks for three factors before it lets this phone in: this phone's key, a secret confirmed "
                        + "with a code on the PC, and this phone's screen lock or fingerprint.\n\nTap Upgrade, then check that the PC "
                        + "(Harbor › Settings › Phones) shows the same 6-digit code as this phone, and click Confirm there.")
                .setNegativeButton("Later", (d, w) -> offering = false)
                .setOnCancelListener(d -> offering = false)
                .setPositiveButton("Upgrade", (d, w) -> run(a, h, true, () -> {
                    offering = false;
                    Ui.toast(a, h.nolock ? "Paired with two factors (no screen lock)" : "Paired with three factors");
                    if (a instanceof Base) ((Base) a).refresh();
                }, e -> {
                    offering = false;
                    Ui.dialog(a).setTitle("Not upgraded").setMessage(Hub.why(e)).setPositiveButton("OK", null).show();
                }))
                .show();
    }

    private static boolean offeringLock;

    /** This phone's presence key is gone (Hub.NeedsLock): its screen lock was removed, or changed
     *  so Android erased the key. Without a lock the pairing can go on with two factors; with a
     *  new one it re-confirms the new key. Either way the person at the PC confirms the code
     *  (so the phone's key and secret alone never drop the third factor). */
    static void offerLock(Activity a, Hub h) {
        if (offeringLock || a.isFinishing()) return;
        offeringLock = true;
        boolean lock = Presence.secureLock();
        AlertDialog.Builder d = Ui.dialog(a).setOnCancelListener(x -> offeringLock = false)
                .setNegativeButton("Later", (x, w) -> offeringLock = false);
        Runnable go = () -> run(a, h, MODE_REKEY, () -> {
            offeringLock = false;
            Ui.toast(a, h.nolock ? "Going on with two factors" : "Paired with three factors");
            if (a instanceof Base) ((Base) a).refresh();
        }, e -> {
            offeringLock = false;
            Ui.dialog(a).setTitle("Not confirmed").setMessage(Hub.why(e)).setPositiveButton("OK", null).show();
        });
        if (lock) {
            d.setTitle("Re-confirm the pairing with " + h.label())
                    .setMessage("This phone's screen lock changed, so Android erased the key Harbor used as the third factor.\n\n"
                            + "Tap Re-confirm, then check that the PC (Harbor › Settings › Phones) shows the same 6-digit code, and click Confirm there.")
                    .setPositiveButton("Re-confirm", (x, w) -> go.run());
        } else {
            d.setTitle("No screen lock")
                    .setMessage("This phone's screen lock was removed. Harbor used it as the third factor to reach " + h.label() + ".\n\n"
                            + "Set a screen lock again to keep three factors, or go on with two (this phone's key and the pairing secret): "
                            + "tap Use two factors and confirm the code on the PC (Harbor › Settings › Phones).")
                    .setPositiveButton("Use two factors", (x, w) -> go.run())
                    .setNeutralButton("Set a lock", (x, w) -> {
                        offeringLock = false;
                        openLockSettings(a);
                    });
        }
        d.show();
    }

    /** Android's screen lock settings. */
    static void openLockSettings(Activity a) {
        try {
            a.startActivity(new Intent(android.provider.Settings.ACTION_SECURITY_SETTINGS));
        } catch (Exception e) {
            a.startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS));
        }
    }

    static final int MODE_PAIR = 0, MODE_UPGRADE = 1, MODE_REKEY = 2;

    /** Runs the ceremony with a dialog for the code. done / failed on the UI thread. */
    static void run(Activity a, Hub h, boolean upgrade, Runnable done, Consumer<Exception> failed) {
        run(a, h, upgrade ? MODE_UPGRADE : MODE_PAIR, done, failed);
    }

    static void run(Activity a, Hub h, int mode, Runnable done, Consumer<Exception> failed) {
        LinearLayout box = Ui.col(a);
        box.setPadding(Ui.dp(24), Ui.dp(8), Ui.dp(24), Ui.dp(8));
        TextView msg = Ui.text(a, "Connecting to " + h.label() + "…", 15, Ui.G700);
        TextView code = Ui.text(a, "", 40, Ui.FG);
        code.setGravity(Gravity.CENTER);
        code.setLetterSpacing(0.1f);
        box.addView(msg, Ui.fill());
        box.addView(code, Ui.margins(Ui.fill(), 0, 16, 0, 8));
        boolean[] cancel = { false };
        String title = mode == MODE_REKEY ? "Re-confirm the pairing" : mode == MODE_UPGRADE ? "Upgrade the pairing" : "Pair with " + h.label();
        AlertDialog d = Ui.dialog(a).setTitle(title).setView(box)
                .setCancelable(false).setNegativeButton("Cancel", (x, w) -> cancel[0] = true).show();
        Ui.pool.execute(() -> {
            try {
                h.pair3(c -> Ui.main.post(() -> {
                    msg.setText("Check that " + h.label() + " shows this same code (Harbor › Settings › Phones), then click Confirm there."
                            + (Presence.secureLock() ? "" : "\n\nThis phone has no screen lock, so it pairs with two factors. Setting a lock later adds the third."));
                    code.setText(c.substring(0, 3) + " " + c.substring(3));
                }), () -> cancel[0], mode == MODE_REKEY);
                Ui.main.post(() -> { if (d.isShowing()) d.dismiss(); done.run(); });
            } catch (Exception e) {
                Ui.main.post(() -> {
                    if (d.isShowing()) d.dismiss();
                    if (!cancel[0]) failed.accept(e);
                });
            }
        });
    }
}
