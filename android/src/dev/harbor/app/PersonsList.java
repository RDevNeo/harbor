package dev.harbor.app;

import android.app.Activity;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** All people (Person Hub's middle list on the phone): back, the title and how many, a search box,
 *  then everyone by their last message. A tap opens their chat over every section. */
final class PersonsList {
    final PersonsState p;
    final Activity a;
    final LinearLayout view;
    private final TextView sub;
    private final EditText search;
    private final List<JSONObject> shown = new ArrayList<>();
    private final BaseAdapter adapter;
    private final TextView empty;

    PersonsList(PersonsState p) {
        this.p = p;
        a = p.a;
        view = Ui.col(a);
        view.setBackgroundColor(Ui.BG);
        view.setClickable(true); // nothing under it takes the taps
        LinearLayout bar = Ui.row(a);
        bar.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        bar.setMinimumHeight(Ui.dp(56));
        bar.addView(Ui.iconButton(a, Ui.I_LEFT, Ui.FG, v -> p.back()));
        LinearLayout t = Ui.col(a);
        t.addView(Ui.bold(a, "All people", 17, Ui.FG));
        sub = Ui.text(a, "", 13, Ui.G700);
        t.addView(sub);
        bar.addView(t, Ui.margins(Ui.weight(), 6, 0, 0, 0));
        view.addView(bar, Ui.fill());
        search = Ui.input(a, "Search people", false);
        search.setTextSize(15);
        search.setPadding(Ui.dp(14), Ui.dp(10), Ui.dp(14), Ui.dp(10));
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { render(); }
        });
        view.addView(search, Ui.margins(Ui.fill(), 12, 2, 12, 6));
        empty = Ui.text(a, "", 14, Ui.G700);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(Ui.dp(28), Ui.dp(32), Ui.dp(28), Ui.dp(32));
        empty.setVisibility(View.GONE);
        view.addView(empty, Ui.fill());
        ListView lv = PersonsHome.list(a);
        adapter = new BaseAdapter() {
            @Override public int getCount() { return shown.size(); }
            @Override public Object getItem(int i) { return shown.get(i); }
            @Override public long getItemId(int i) { return i; }
            @Override public boolean isEnabled(int i) { return false; }
            @Override public View getView(int i, View convert, ViewGroup parent) {
                JSONObject q = shown.get(i);
                LinearLayout r = PersonsUi.row(a, p.hub, q, "", false);
                String id = PersonsUi.s(q, "id");
                r.setOnClickListener(v -> p.openChat(id, ""));
                r.setOnLongClickListener(v -> { PersonsHome.menu(p, q, "", false); return true; });
                LinearLayout w = Ui.col(a);
                w.setPadding(Ui.dp(8), 0, Ui.dp(8), 0);
                w.addView(r, Ui.fill());
                return w;
            }
        };
        lv.setAdapter(adapter);
        view.addView(lv, new LinearLayout.LayoutParams(-1, 0, 1));
        render();
    }

    void render() {
        shown.clear();
        String q = search.getText().toString().trim().toLowerCase(Locale.ROOT);
        List<JSONObject> all = p.st == null ? new ArrayList<>() : PersonsHome.objs(PersonsUi.arr(p.st, "people"));
        for (JSONObject x : all) {
            if (q.isEmpty() || PersonsUi.s(x, "name").toLowerCase(Locale.ROOT).contains(q)
                    || PersonsUi.s(x, "initials").toLowerCase(Locale.ROOT).equals(q) || PersonsUi.s(x, "id").equals(q)) shown.add(x);
        }
        Collections.sort(shown, PersonsHome.recent(""));
        int n = all.size();
        sub.setText(q.isEmpty() ? n + (n == 1 ? " person" : " people") : shown.size() + " of " + n + " match “" + q + "”");
        empty.setText(n == 0 ? "No one yet. Add people in Hub on the PC (Persons)." : "No one matches “" + q + "”.");
        empty.setVisibility(shown.isEmpty() && p.st != null ? View.VISIBLE : View.GONE);
        adapter.notifyDataSetChanged();
    }
}
