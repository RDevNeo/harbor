package dev.harbor.app;

import android.app.Activity;
import android.app.AlertDialog;
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
                    Ui.toast(a, "Paired with three factors");
                    if (a instanceof Base) ((Base) a).refresh();
                }, e -> {
                    offering = false;
                    Ui.dialog(a).setTitle("Not upgraded").setMessage(Hub.why(e)).setPositiveButton("OK", null).show();
                }))
                .show();
    }

    /** Runs the ceremony with a dialog for the code. done / failed on the UI thread. */
    static void run(Activity a, Hub h, boolean upgrade, Runnable done, Consumer<Exception> failed) {
        LinearLayout box = Ui.col(a);
        box.setPadding(Ui.dp(24), Ui.dp(8), Ui.dp(24), Ui.dp(8));
        TextView msg = Ui.text(a, "Connecting to " + h.label() + "…", 15, Ui.G700);
        TextView code = Ui.text(a, "", 40, Ui.FG);
        code.setGravity(Gravity.CENTER);
        code.setLetterSpacing(0.1f);
        box.addView(msg, Ui.fill());
        box.addView(code, Ui.margins(Ui.fill(), 0, 16, 0, 8));
        boolean[] cancel = { false };
        AlertDialog d = Ui.dialog(a).setTitle(upgrade ? "Upgrade the pairing" : "Pair with " + h.label()).setView(box)
                .setCancelable(false).setNegativeButton("Cancel", (x, w) -> cancel[0] = true).show();
        Ui.pool.execute(() -> {
            try {
                h.pair3(c -> Ui.main.post(() -> {
                    msg.setText("Check that " + h.label() + " shows this same code (Harbor › Settings › Phones), then click Confirm there.");
                    code.setText(c.substring(0, 3) + " " + c.substring(3));
                }), () -> cancel[0]);
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
