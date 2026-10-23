package dev.harbor.app;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.List;
import java.util.UUID;

/** The paired PCs, and pairing a new one: a QR code (through a scanner app, or the camera app
 *  opening the harbor://pair link straight into here), a pasted link, or host/port/token typed. */
public class Hubs extends Base {
    private static final int SCAN = 1;
    private LinearLayout list;
    private android.app.AlertDialog pairDialog;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout root = frame("Harbor", false);
        action(Ui.I_PLUS, v -> pair());
        ScrollView sv = new ScrollView(this);
        list = Ui.col(this);
        list.setPadding(0, Ui.dp(8), 0, Ui.dp(24));
        sv.addView(list);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));

        if (b == null && !handleLink(getIntent())) {
            // A cold start goes straight back to the PC used last.
            String last = Hub.last(this);
            List<Hub> all = Hub.all(this);
            if (last == null && all.size() == 1) last = all.get(0).id;
            if (last != null && Hub.get(this, last) != null) open(last);
        }
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        handleLink(i);
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    private boolean handleLink(Intent i) {
        if (i == null || !Intent.ACTION_VIEW.equals(i.getAction()) || i.getData() == null) return false;
        Hub h = Hub.parse(i.getDataString());
        if (h == null) { Ui.toast(this, "That isn't a Harbor pairing link"); return true; }
        confirmPair(h);
        return true;
    }

    private void open(String id) {
        Hub.setLast(this, id);
        startActivity(new Intent(this, Chats.class).putExtra("hub", id));
    }

    private void render() {
        list.removeAllViews();
        List<Hub> hubs = Hub.all(this);
        if (hubs.isEmpty()) {
            list.addView(hint("Pair a PC running Harbor.\n\nOn the PC: Settings › Phones, turn on Phone access and click Pair a phone. "
                    + "Scan the QR code with the camera, or tap + here to scan, paste the link or type the address."));
            TextView p = Ui.button(this, "Pair a PC", true, v -> pair());
            list.addView(p, Ui.margins(Ui.fill(), 24, 0, 24, 0));
            return;
        }
        list.addView(Ui.section(this, "PCs"));
        for (Hub h : hubs) list.addView(hubRow(h));
    }

    private View hubRow(Hub h) {
        LinearLayout r = Ui.row(this);
        r.setPadding(Ui.dp(16), Ui.dp(12), Ui.dp(12), Ui.dp(12));
        r.setBackground(Ui.press(0, 0, 0));
        View dot = Ui.dot(this, Ui.G500, 8);
        r.addView(dot);
        LinearLayout t = Ui.col(this);
        t.addView(Ui.subtitle(Ui.bold(this, h.label(), 16, Ui.FG)));
        TextView sub = Ui.subtitle(Ui.text(this, h.host + ":" + h.port, 13, Ui.G700));
        t.addView(sub);
        r.addView(t, Ui.margins(Ui.weight(), 12, 0, 8, 0));
        r.addView(Ui.icon(this, Ui.I_RIGHT, 18, Ui.G600));
        r.setOnClickListener(v -> open(h.id));
        r.setOnLongClickListener(v -> {
            startActivity(new Intent(this, Settings.class).putExtra("hub", h.id));
            return true;
        });
        Ui.pool.execute(() -> {
            String s; int color;
            try {
                JSONObject st = h.state();
                s = "Harbor " + st.optString("version") + " · " + h.host;
                color = Ui.GREEN;
            } catch (Exception e) {
                s = Hub.why(e);
                color = Ui.RED;
            }
            final String fs = s; final int fc = color;
            Ui.main.post(() -> {
                sub.setText(fs);
                dot.setBackground(Ui.round(fc, 0, 4));
            });
        });
        return r;
    }

    // ---- pairing ----

    private void pair() {
        LinearLayout f = Ui.col(this);
        f.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        f.addView(Ui.text(this, "On the PC: Harbor › Settings › Phones › Pair a phone.", 14, Ui.G900));
        TextView scan = Ui.button(this, "Scan QR code", true, v -> scan());
        f.addView(scan, Ui.margins(Ui.fill(), 0, 14, 0, 0));

        f.addView(Ui.text(this, "or paste the pairing link", 13, Ui.G700), Ui.margins(Ui.fill(), 0, 18, 0, 6));
        EditText link = Ui.input(this, "harbor://pair?…", false);
        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        ClipData clip = cm.getPrimaryClip();
        if (clip != null && clip.getItemCount() > 0 && clip.getItemAt(0).getText() != null
                && Hub.parse(clip.getItemAt(0).getText().toString()) != null)
            link.setText(clip.getItemAt(0).getText());
        f.addView(link, Ui.fill());

        f.addView(Ui.text(this, "or type it", 13, Ui.G700), Ui.margins(Ui.fill(), 0, 18, 0, 6));
        EditText host = Ui.input(this, "Host (e.g. desk.example.ts.net)", false);
        LinearLayout hp = Ui.row(this);
        hp.addView(host, Ui.weight());
        EditText port = Ui.input(this, "Port", false);
        port.setInputType(InputType.TYPE_CLASS_NUMBER);
        hp.addView(port, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(90), -2), 8, 0, 0, 0));
        f.addView(hp, Ui.fill());
        EditText token = Ui.input(this, "Token", false);
        f.addView(token, Ui.margins(Ui.fill(), 0, 8, 0, 0));

        ScrollView sv = new ScrollView(this);
        sv.addView(f);
        pairDialog = Ui.dialog(this).setTitle("Pair a PC").setView(sv)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Pair", (d, w) -> {
                    Hub h = Hub.parse(link.getText().toString());
                    if (h == null && host.length() > 0 && token.length() > 0) {
                        int p;
                        try { p = Integer.parseInt(port.getText().toString().trim()); } catch (Exception e) { p = 0; }
                        if (p > 0) h = new Hub(UUID.randomUUID().toString(), host.getText().toString().trim(),
                                host.getText().toString().trim(), p, token.getText().toString().trim());
                    }
                    if (h == null) Ui.toast(this, "Paste the harbor://pair link, or fill host, port and token");
                    else tryPair(h);
                }).show();
    }

    private void scan() {
        try {
            startActivityForResult(new Intent("com.google.zxing.client.android.SCAN")
                    .putExtra("SCAN_MODE", "QR_CODE_MODE").putExtra("PROMPT_MESSAGE", "Scan Harbor's pairing code"), SCAN);
        } catch (ActivityNotFoundException e) {
            Ui.dialog(this).setTitle("No QR scanner app")
                    .setMessage("Point the phone's camera app (or Google Lens) at the QR code on the PC: "
                            + "it opens the harbor://pair link straight in Harbor.\n\nOr copy the link and paste it here.")
                    .setPositiveButton("OK", null).show();
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != SCAN || res != RESULT_OK || data == null) return;
        Hub h = Hub.parse(data.getStringExtra("SCAN_RESULT"));
        if (h == null) { Ui.toast(this, "That QR code isn't a Harbor pairing code"); return; }
        if (pairDialog != null) pairDialog.dismiss();
        tryPair(h);
    }

    private void confirmPair(Hub h) {
        Ui.dialog(this).setTitle("Pair with " + h.label() + "?")
                .setMessage(h.host + ":" + h.port + "\n\nThis phone will be able to read and drive this PC's chats.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Pair", (d, w) -> tryPair(h)).show();
    }

    /** Checks the token against the PC before keeping it. */
    private void tryPair(Hub h) {
        Ui.toast(this, "Connecting to " + h.host + "…");
        Ui.bg(this, () -> {
            JSONObject st;
            try {
                st = h.state();
            } catch (java.io.IOException e) {
                // MagicDNS off on the phone: the link's tailnet IP still reaches the PC.
                if (e instanceof Hub.ApiError || h.ip == null || h.ip.isEmpty() || h.ip.equals(h.host)) throw e;
                h.host = h.ip;
                st = h.state();
            }
            String n = st.optString("hub_name", "");
            if (!n.isEmpty()) h.name = n;
            return st;
        }, st -> {
            Hub saved = Hub.put(this, h);
            Hub.states.put(saved.id, st);
            render();
            open(saved.id);
        });
    }
}
