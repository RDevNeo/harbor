package dev.harbor.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.List;

/** Hub's own world: the phone knows its PCs by pairing, never through Harbor's account service.
 *  Harbor's directory, workspaces and PCs are never asked for or reached, and a Hub PC takes only
 *  the phones paired with it, so the two apps never see each other's chats (android/PROTOCOL.md,
 *  "Hub pairing").
 *
 *  Hub on the PC shows a QR code holding a link
 *  {@code hub://pair?fp=<sha256 hex of its key's SPKI>&addrs=<host:port>,…&name=<PC>&id=<mesh id>&code=<one-time code>};
 *  the phone's camera opens it in Hubs (or it's pasted there). The phone then calls the PC, pinned
 *  to that key with its own Keystore key ({@code POST /v1/pair {"code", "name"}}); the PC keeps the
 *  phone's key from then on. Each paired PC is one entry of the start screen (id {@code pc:<fp>});
 *  the PCs it meshes with that the answer lists are its other endpoints.
 *  The link itself: PairLink. */
final class Pair {
    /** Hub has no account sign-in: everything gated on Account's sign-in is open, and nothing
     *  goes to Harbor's account service (Account checks this). */
    static final boolean ON = true;
    static final String SCHEME = "hub";
    /** Hub's phone API port on the PC when a link's address names none (Harbor's is 47930, 47940 is the PC's MCP bridge; so
     *  both run on one PC). */
    static final int PORT = 47950;
    /** The id prefix of a paired PC's entry. */
    static final String ID = "pc:";

    /** Pairs with the PC of link l: calls it pinned to its key, and keeps it on this phone when it
     *  takes the code. Blocking (not on the UI thread). Returns the entry's id. */
    static String pair(Context c, PairLink l) throws IOException {
        Hub h = new Hub(ID + l.fp, PairLink.label(l), "", 0, "");
        h.fp = l.fp;
        h.pid = l.id.isEmpty() ? "fp:" + l.fp.substring(0, 16) : l.id;
        h.pcName = PairLink.label(l);
        h.addrs.addAll(l.addrs);
        Object[] hp = Addr.hostPort(l.addrs.get(0), PORT);
        h.host = (String) hp[0];
        h.port = (Integer) hp[1];
        JSONObject r;
        try {
            r = h.call("POST", "/v1/pair", new JSONObject().put("code", l.code).put("name", Hub.deviceName()), 20_000);
        } catch (JSONException e) {
            throw new IOException(e);
        }
        String n = r.optString("name").trim();
        if (!n.isEmpty()) { h.name = n; h.pcName = n; }
        peers(h, r.optJSONArray("peers"));
        List<Hub> all = Hub.all(c);
        all.removeIf(x -> x.id.equals(h.id));
        all.add(h);
        Hub.save(c, all);
        return h.id;
    }

    /** The other Hub PCs the paired one meshes with ({fp, id, name, addrs}): endpoints of the
     *  same entry (they share its chats and its paired phones). */
    private static void peers(Hub h, JSONArray a) {
        if (a == null) return;
        for (int i = 0; i < a.length(); i++) {
            JSONObject p = a.optJSONObject(i);
            String f = p == null ? null : PairLink.fp(p.optString("fp"));
            if (f == null || f.equals(h.fp)) continue;
            Hub.Ep e = new Hub.Ep(p.optString("id").isEmpty() ? "fp:" + f.substring(0, 16) : p.optString("id"), p.optString("name"), "", "", 0, "");
            e.fp = f;
            JSONArray ad = p.optJSONArray("addrs");
            for (int k = 0; ad != null && k < ad.length(); k++) {
                String x = ad.optString(k, "").trim();
                if (!x.isEmpty() && !e.addrs.contains(x)) e.addrs.add(x);
            }
            if (e.addrs.isEmpty()) continue;
            Object[] hp = Addr.hostPort(e.addrs.get(0), PORT);
            e.host = (String) hp[0];
            e.port = (Integer) hp[1];
            h.eps.add(e);
        }
    }

    /** Forgets a paired PC on this phone, telling it first when it answers (POST /v1/unpair:
     *  it stops taking this phone's key). */
    static void forget(Context c, String id) {
        Hub h = Hub.get(c, id);
        Hub.remove(c, id);
        if (h != null) Ui.pool.execute(() -> { try { h.call("POST", "/v1/unpair", new JSONObject(), 8_000); } catch (Exception ignored) { } });
    }
}
