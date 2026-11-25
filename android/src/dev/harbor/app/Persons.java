package dev.harbor.app;

import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;

/** Hub's Persons tab: Person Hub's people, chats and details, natively (PersonsTab / PersonsState),
 *  under the tab bar. Its data is the PC's: the routes under /v1/persons/… (ts/tabs/persons/engine.ts),
 *  on Tabs.hub(this). While a chat or a person's details fill the screen the tab bar steps aside. */
public class Persons extends Base {
    private LinearLayout around;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        hub = Tabs.hub(this);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        View content = new PersonsTab().view(this, hub);
        around = Tabs.around(this, content, Tabs.PERSONS);
        page = around;
        setContentView(page);
        PersonsTab.listen(this::bars);
        bars();
    }

    /** The tab bar (and its line) hidden while a chat or details fill the screen. */
    private void bars() {
        if (around == null) return;
        int vis = PersonsTab.deep() ? View.GONE : View.VISIBLE;
        for (int i = 1; i < around.getChildCount(); i++) around.getChildAt(i).setVisibility(vis);
    }

    @Override
    public void onBackPressed() {
        if (PersonsTab.back()) return;
        super.onBackPressed();
    }
}
