package dev.harbor.app;

import android.os.Bundle;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Hub's Persons tab (owned by the Persons port; this is the placeholder it replaces). Its data is
 *  the PC's: the routes under /v1/persons/… (ts/tabs/persons/engine.ts), on Tabs.hub(this). */
public class Persons extends Base {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        hub = Tabs.hub(this);
        LinearLayout col = Ui.col(this);
        col.setGravity(Gravity.CENTER);
        TextView t = Ui.text(this, "Persons", 18, Ui.G700);
        t.setGravity(Gravity.CENTER);
        col.addView(t, Ui.fill());
        page = Tabs.around(this, col, Tabs.PERSONS);
        setContentView(page);
    }
}
