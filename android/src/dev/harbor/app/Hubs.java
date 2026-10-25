package dev.harbor.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** The paired PCs, and pairing a new one: Harbor's own camera scanner (QrScan), the phone's
 *  camera app opening the harbor://pair link straight into here, a pasted link, or
 *  address/port/token/PC key typed. */
public class Hubs extends Base {
    private static final int SCAN = 1;
    private LinearLayout list;
    private Sheet pairSheet;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        page = Ui.col(this);
        page.setBackgroundColor(Ui.BG);
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        list = Ui.col(this);
        list.setPadding(Ui.dp(20), Ui.dp(24), Ui.dp(20), Ui.dp(24));
        sv.addView(list);
        page.addView(sv, new LinearLayout.LayoutParams(-1, -1));
        setContentView(page);

        if (b == null && !handleLink(getIntent())) {
            if (getIntent().getBooleanExtra("pair", false)) { pair(); return; }
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
        if (!handleLink(i) && i.getBooleanExtra("pair", false)) pair();
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
        list.addView(Ui.title(this, "Harbor", 44), Ui.margins(Ui.fill(), 4, 24, 4, 8));
        List<Hub> hubs = Hub.all(this);
        if (hubs.isEmpty()) {
            TextView t = Ui.text(this, "Your Harbor chats on your phone. Pair it with a PC running Harbor: on the PC, open "
                    + "Settings › Phones, turn on Phone access and click Pair a phone.", 17, Ui.G700);
            list.addView(t, Ui.margins(Ui.fill(), 4, 8, 4, 28));
            list.addView(Ui.button(this, "Scan pairing code", true, v -> scan()), Ui.fill());
            list.addView(Ui.button(this, "Paste or type it", false, v -> pair()), Ui.margins(Ui.fill(), 0, 10, 0, 0));
            return;
        }
        list.addView(Ui.text(this, "Your PCs", 15, Ui.G700), Ui.margins(Ui.fill(), 6, 20, 6, 8));
        LinearLayout c = Ui.card(this);
        boolean first = true;
        for (Hub h : hubs) {
            if (!first) c.addView(Ui.gap(this));
            first = false;
            c.addView(hubRow(h), Ui.fill());
        }
        list.addView(c, Ui.fill());
        list.addView(Ui.button(this, "Pair another PC", false, v -> pair()), Ui.margins(Ui.fill(), 0, 16, 0, 0));
    }

    private View hubRow(Hub h) {
        View dot = Ui.dot(this, Ui.G500, 10);
        LinearLayout r = Ui.cardRow(this, Ui.I_MONITOR, h.label(), h.host + ":" + h.port, Ui.FG, v -> open(h.id));
        r.addView(dot, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(10), Ui.dp(10)), 8, 0, 8, 0));
        r.addView(Ui.chevron(this));
        TextView sub = (TextView) ((LinearLayout) r.getChildAt(1)).getChildAt(1);
        r.setOnLongClickListener(v -> {
            startActivity(new Intent(this, Settings.class).putExtra("hub", h.id));
            return true;
        });
        Ui.pool.execute(() -> {
            String s; int color;
            try {
                JSONObject st = h.state();
                String via = h.viaName();
                s = "Harbor " + st.optString("version") + " · " + (via.isEmpty() ? h.host : "via " + via);
                color = Ui.GREEN;
            } catch (Exception e) {
                s = Hub.why(e);
                color = Ui.RED;
            }
            final String fs = s; final int fc = color;
            Ui.main.post(() -> {
                sub.setText(fs);
                dot.setBackground(Ui.round(fc, 0, 5));
            });
        });
        return r;
    }

    // ---- pairing ----

    /** Scan with Harbor's camera, else paste the link or type the address. */
    private void pair() {
        Sheet s = new Sheet(this, "Pair a PC");
        TextView how = Ui.text(this, "On the PC: Harbor › Settings › Phones › Pair a phone.", 15, Ui.G700);
        how.setPadding(Ui.dp(6), 0, Ui.dp(6), Ui.dp(12));
        s.body.addView(how);
        LinearLayout c = s.card();
        LinearLayout sc = Ui.cardRow(this, Ui.disc(this, new Ui.Draw(Ui.Draw.CAMERA, Ui.FG), 44), "Scan pairing code", "with this phone's camera", Ui.FG,
                v -> { s.dismiss(); scan(); });
        sc.addView(Ui.chevron(this));
        c.addView(sc, Ui.fill());

        LinearLayout c2 = s.card();
        EditText link = Ui.input(this, "harbor://pair?…", false);
        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        ClipData clip = cm.getPrimaryClip();
        if (clip != null && clip.getItemCount() > 0 && clip.getItemAt(0).getText() != null
                && Hub.parse(clip.getItemAt(0).getText().toString()) != null)
            link.setText(clip.getItemAt(0).getText());
        LinearLayout pad = Ui.col(this);
        pad.setPadding(Ui.dp(16), Ui.dp(14), Ui.dp(16), Ui.dp(16));
        pad.addView(Ui.text(this, "Or paste the pairing link", 15, Ui.G700), Ui.margins(Ui.fill(), 2, 0, 0, 8));
        pad.addView(link, Ui.fill());
        pad.addView(Ui.text(this, "or type it", 15, Ui.G700), Ui.margins(Ui.fill(), 2, 16, 0, 8));
        EditText host = Ui.input(this, "Address (e.g. 10.0.0.12)", false);
        LinearLayout hp = Ui.row(this);
        hp.addView(host, Ui.weight());
        EditText port = Ui.input(this, "Port", false);
        port.setInputType(InputType.TYPE_CLASS_NUMBER);
        hp.addView(port, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(96), -2), 8, 0, 0, 0));
        pad.addView(hp, Ui.fill());
        EditText token = Ui.input(this, "Token", false);
        pad.addView(token, Ui.margins(Ui.fill(), 0, 8, 0, 0));
        EditText key = Ui.input(this, "PC key", false);
        pad.addView(key, Ui.margins(Ui.fill(), 0, 8, 0, 0));
        pad.addView(Ui.button(this, "Pair", true, v -> {
            Hub h = Hub.parse(link.getText().toString());
            String fp = Addr.fp(key.getText().toString());
            if (h == null && host.length() > 0 && token.length() > 0 && fp != null) {
                int p;
                try { p = Integer.parseInt(port.getText().toString().trim()); } catch (Exception e) { p = 0; }
                if (p > 0) {
                    h = new Hub(UUID.randomUUID().toString(), host.getText().toString().trim(),
                            host.getText().toString().trim(), p, token.getText().toString().trim());
                    h.fp = fp;
                }
            }
            if (h == null) { Ui.toast(this, "Paste the harbor://pair link, or fill address, port, token and the PC key (64 characters)"); return; }
            s.dismiss();
            tryPair(h);
        }), Ui.margins(Ui.fill(), 0, 16, 0, 0));
        c2.addView(pad, Ui.fill());
        if (s.dialog.getWindow() != null)
            s.dialog.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        pairSheet = s.show();
    }

    private void scan() { startActivityForResult(new Intent(this, QrScan.class), SCAN); }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != SCAN || res != RESULT_OK || data == null) return;
        Hub h = Hub.parse(data.getDataString());
        if (h == null) { Ui.toast(this, "That QR code isn't a Harbor pairing code"); return; }
        if (pairSheet != null) pairSheet.dismiss();
        tryPair(h);
    }

    private void confirmPair(Hub h) {
        // A link can name itself after a PC that is already paired: say when the address differs.
        String warn = "";
        for (Hub o : Hub.all(this))
            if (o.label().equalsIgnoreCase(h.label()) && !(o.host.equalsIgnoreCase(h.host) && o.port == h.port))
                warn = "\n\nCareful: your paired " + o.label() + " is at " + o.host + ":" + o.port + ", not here. Only pair if you just clicked Pair a phone on that PC.";
        // Every address the phone will try, not only the link's host.
        List<String> at = new ArrayList<>();
        at.add(h.host + ":" + h.port);
        if (h.ip != null && !h.ip.isEmpty()) at.add(h.ip + ":" + h.port);
        for (String a : h.addrs) if (!at.contains(a)) at.add(a);
        Ui.dialog(this).setTitle("Pair with " + h.label() + "?")
                .setMessage(TextUtils.join("\n", at) + "\n\nThis phone will be able to read and drive this PC's chats." + warn)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Pair", (d, w) -> tryPair(h)).show();
    }

    /** Pairs with three factors (the code confirmed on the PC), then keeps the pairing. A PC
     *  with Harbor before 0.22 doesn't know them: paired as before, with its token and key. */
    private void tryPair(Hub h) {
        Pair.run(this, h, false, () -> keep(h), e -> {
            if (e instanceof Hub.ApiError && ((Hub.ApiError) e).code == 404) { keep(h); return; }
            Ui.dialog(this).setTitle("Not paired").setMessage(Hub.why(e)).setPositiveButton("OK", null).show();
        });
    }

    /** Checks the pairing against the PC before keeping it. */
    private void keep(Hub h) {
        Ui.toast(this, "Connecting to " + h.host + "…");
        Ui.bg(this, () -> {
            // Every address of the link is tried, each only with the PC's key.
            return h.state();
        }, st -> {
            // The PC's own name, unless another paired PC already goes by it.
            String n = st.optString("hub_name", "");
            boolean taken = false;
            for (Hub o : Hub.all(this))
                if (o.label().equalsIgnoreCase(n) && !(!o.fp.isEmpty() && o.fp.equals(h.fp)) && !(o.host.equalsIgnoreCase(h.host) && o.port == h.port))
                    taken = true;
            if (!n.isEmpty() && !taken) h.name = n;
            Hub saved = Hub.put(this, h);
            Hub.states.put(saved.id, st);
            render();
            open(saved.id);
        });
    }
}
