package dev.harbor.app;

import android.app.AlertDialog;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Link with… (the PC's): the same human known as two or more people (Evellin on Discord, again on WhatsApp)
 *  becomes one person, every channel's messages in one chat. A searchable picker of everyone else; Unlink splits
 *  one back out (POST /v1/persons/person/{id}/link {ids}, …/unlink {id}). */
final class PersonsLink {
    private PersonsLink() { }

    private static String first(String name) {
        String n = Normalizer.normalize(name.trim(), Normalizer.Form.NFD).replaceAll("\\p{M}", "").toLowerCase(Locale.ROOT);
        String[] w = n.split("[^\\p{L}\\p{N}]+");
        return w.length > 0 ? w[0] : "";
    }

    static void pick(PersonsState p, String id) {
        JSONObject me = p.person(id);
        if (me == null || p.st == null) return;
        String name = PersonsUi.s(me, "name");
        Set<String> picked = new LinkedHashSet<>();
        LinearLayout box = Ui.col(p.a);
        box.setPadding(Ui.dp(20), Ui.dp(4), Ui.dp(20), 0);
        TextView note = Ui.text(p.a, "Pick the people who are the same person on another channel. They become one: every channel's messages in one chat. Unlink splits them back out.", 13, Ui.G700);
        box.addView(note, Ui.margins(Ui.fill(), 0, 0, 0, 8));
        EditText search = Ui.input(p.a, "Search people", false);
        box.addView(search, Ui.fill());
        LinearLayout list = Ui.col(p.a);
        ScrollView sv = new ScrollView(p.a);
        sv.addView(list, new ScrollView.LayoutParams(-1, -2));
        box.addView(sv, Ui.margins(new LinearLayout.LayoutParams(-1, Ui.dp(320)), 0, 8, 0, 0));
        TextView count = Ui.text(p.a, "Nobody picked yet.", 13, Ui.G700);
        box.addView(count, Ui.margins(Ui.fill(), 0, 6, 0, 0));
        String mine = first(name);
        Runnable[] draw = new Runnable[1];
        draw[0] = () -> {
            list.removeAllViews();
            String q = search.getText().toString().trim().toLowerCase(Locale.ROOT);
            List<JSONObject> people = new ArrayList<>();
            for (JSONObject o : PersonsHome.objs(PersonsUi.arr(p.st, "people"))) {
                String oid = PersonsUi.s(o, "id");
                if (oid.equals(id)) continue;
                String hay = (PersonsUi.s(o, "name") + " " + PersonsUi.s(o, "search")).toLowerCase(Locale.ROOT);
                boolean hit = true;
                for (String w : q.split("\\s+")) if (!w.isEmpty() && !hay.contains(w)) hit = false;
                if (hit || picked.contains(oid)) people.add(o);
            }
            people.sort((x, y) -> {
                int rx = picked.contains(PersonsUi.s(x, "id")) ? 0 : first(PersonsUi.s(x, "name")).equals(mine) ? 1 : 2;
                int ry = picked.contains(PersonsUi.s(y, "id")) ? 0 : first(PersonsUi.s(y, "name")).equals(mine) ? 1 : 2;
                if (rx != ry) return rx - ry;
                return PersonsUi.s(x, "name").compareToIgnoreCase(PersonsUi.s(y, "name"));
            });
            for (JSONObject o : people.subList(0, Math.min(200, people.size()))) {
                String oid = PersonsUi.s(o, "id");
                boolean on = picked.contains(oid);
                LinearLayout r = Ui.row(p.a);
                r.setGravity(Gravity.CENTER_VERTICAL);
                r.setPadding(Ui.dp(8), Ui.dp(8), Ui.dp(8), Ui.dp(8));
                r.setBackground(Ui.press(on ? Ui.G100 : 0, 0, 12));
                r.addView(PersonsUi.avatar(p.a, p.hub, o, 32, ""), new LinearLayout.LayoutParams(Ui.dp(32), Ui.dp(32)));
                LinearLayout t = Ui.col(p.a);
                t.addView(Ui.subtitle(Ui.bold(p.a, PersonsUi.s(o, "name"), 15, Ui.FG)));
                JSONObject row = PersonsUi.info(o, "");
                String ch = PersonsUi.s(row, "channel");
                if (!ch.isEmpty()) t.addView(Ui.subtitle(Ui.text(p.a, PersonsUi.kindLabel(ch), 12, Ui.G600)));
                r.addView(t, Ui.margins(Ui.weight(), 10, 0, 8, 0));
                TextView check = Ui.icon(p.a, on ? Ui.I_CHECK : "", 14, Ui.BG);
                check.setGravity(Gravity.CENTER);
                check.setBackground(Ui.round(on ? Ui.FG : 0, on ? 0 : Ui.G500, 6));
                r.addView(check, new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)));
                r.setOnClickListener(v -> {
                    if (!picked.remove(oid)) picked.add(oid);
                    draw[0].run();
                });
                r.setContentDescription((on ? "Picked: " : "Pick ") + PersonsUi.s(o, "name"));
                list.addView(r, Ui.fill());
            }
            if (people.isEmpty()) list.addView(Ui.text(p.a, "Nobody matches.", 14, Ui.G600), Ui.margins(Ui.fill(), 8, 12, 8, 12));
            List<String> names = new ArrayList<>();
            for (String x : picked) names.add(PersonsUi.s(p.person(x), "name"));
            count.setText(names.isEmpty() ? "Nobody picked yet." : names.size() + " picked: " + String.join(", ", names));
        };
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { draw[0].run(); }
        });
        draw[0].run();
        AlertDialog d = Ui.dialog(p.a).setTitle("Link " + name + " with…").setView(box)
                .setPositiveButton("Link", null)
                .setNegativeButton("Cancel", null).create();
        d.setOnShowListener(x -> d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            if (picked.isEmpty()) { Ui.toast(p.a, "Pick at least one person"); return; }
            JSONArray ids = new JSONArray();
            for (String s : picked) ids.put(s);
            JSONObject body = PersonsUi.put(new JSONObject(), "ids", ids);
            Ui.bg(p.a, () -> p.hub.call("POST", "/v1/persons/person/" + PersonsUi.enc(id) + "/link", body), r -> {
                if (!r.optBoolean("ok", false)) { Ui.toast(p.a, r.optString("error", "Not linked")); return; }
                d.dismiss();
                Ui.toast(p.a, "Linked into " + name);
                p.refresh();
            });
        }));
        d.show();
    }

    static void unlink(PersonsState p, String id, String linkedId, String linkedName, Runnable then) {
        Ui.dialog(p.a).setTitle("Unlink " + linkedName + "?")
                .setMessage(linkedName + " goes back to being their own person, with their channels, notes, stores and lists as they were when linked.")
                .setPositiveButton("Unlink", (d, w) -> {
                    JSONObject body = PersonsUi.put(new JSONObject(), "id", linkedId);
                    Ui.bg(p.a, () -> p.hub.call("POST", "/v1/persons/person/" + PersonsUi.enc(id) + "/unlink", body), r -> {
                        if (!r.optBoolean("ok", false)) { Ui.toast(p.a, r.optString("error", "Not unlinked")); return; }
                        Ui.toast(p.a, linkedName + " is on their own again");
                        p.refresh();
                        if (then != null) then.run();
                    });
                })
                .setNegativeButton("Cancel", null).show();
    }

    /** The people linked into a person ({id, name}), from the state. */
    static List<JSONObject> linked(JSONObject person) {
        return PersonsHome.objs(PersonsUi.arr(person, "linked"));
    }

}
