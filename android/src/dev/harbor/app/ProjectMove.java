package dev.harbor.app;

import android.os.Handler;
import android.os.Looper;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** A project's "Move to PC…" (`POST /v1/projects/move`): the PCs it could go to (greyed, with
 *  why, when it can't go there), the confirmation the PC writes (where it goes, what's copied,
 *  also files like .env, what stays), then a sheet that follows the move until it says how it
 *  ended. The project's own PC does it all; the PC the phone talks to asks it on when the
 *  project is another PC's. */
final class ProjectMove {
    private ProjectMove() {}

    private static JSONObject call(Hub hub, String pid, JSONObject body) throws Exception {
        try {
            return hub.call("POST", "/v1/projects/move", body.put("project", pid));
        } catch (Hub.ApiError e) {
            if (e.code == 404 && !e.getMessage().contains("project")) throw new Hub.ApiError(404, "This PC runs an older Harbor that can't move projects: update it first.");
            throw e;
        }
    }

    static void show(Base a, Hub hub, String pid, String name, Runnable after) {
        Ui.bg(a, () -> {
            JSONObject st = call(hub, pid, new JSONObject().put("step", "status"));
            if ("running".equals(st.optString("state"))) return st;
            return call(hub, pid, new JSONObject().put("step", "targets"));
        }, r -> {
            if (r.has("state")) { follow(a, hub, pid, name, null, after); return; }
            JSONArray ts = r.optJSONArray("targets");
            String why = r.isNull("why") ? "" : r.optString("why", "");
            List<Sheet.Option> o = new ArrayList<>();
            for (int i = 0; ts != null && i < ts.length(); i++) {
                JSONObject t = ts.optJSONObject(i);
                if (t == null) continue;
                String no = t.isNull("why") ? "" : t.optString("why", "");
                o.add(new Sheet.Option(t.optString("id"), t.optString("name", t.optString("id")), no.isEmpty() ? "Goes there with its chats" : no, no.isEmpty()));
            }
            if (o.isEmpty()) { Ui.toast(a, why.isEmpty() ? "No other PCs yet: invite their owner to your workspace (Settings › Workspace on a PC)" : "Can't move it: " + why); return; }
            String note = why.isEmpty()
                    ? "Its folder and its chats go to the PC you pick and go on there. Harbor shows what it copies before it starts."
                    : "Can't move now: " + why;
            Sheet.pick(a, "Move " + name + " to PC", note, o, null, pc -> plan(a, hub, pid, name, pc, after));
        });
    }

    private static void plan(Base a, Hub hub, String pid, String name, String pc, Runnable after) {
        Ui.toast(a, "Reading " + name + "…");
        Ui.bg(a, () -> call(hub, pid, new JSONObject().put("step", "plan").put("to", pc)), p ->
                Ui.dialog(a).setTitle(p.optString("title", "Move " + name + "?"))
                        .setMessage(p.optString("text"))
                        .setNegativeButton("Cancel", null)
                        .setPositiveButton(p.optString("ok", "Move"), (d, w) -> Ui.bg(a,
                                () -> call(hub, pid, new JSONObject().put("step", "start").put("to", pc)),
                                r -> {
                                    after.run();
                                    // Asked of the PC the move runs on: the project may leave this PC's list meanwhile.
                                    JSONObject at = r.optJSONObject("ask");
                                    follow(a, hub, pid, name, at, after);
                                }))
                        .show());
    }

    /** The move's sheet: what it does now and how far, then how it ended. Closing it doesn't stop the move. */
    static void follow(Base a, Hub hub, String pid, String name, JSONObject at, Runnable after) {
        Sheet s = new Sheet(a, "Moving " + name);
        LinearLayout card = s.card();
        TextView stage = Ui.text(a, "Asking…", 15, Ui.FG);
        stage.setPadding(Ui.dp(14), Ui.dp(14), Ui.dp(14), Ui.dp(6));
        card.addView(stage, Ui.fill());
        ProgressBar bar = new ProgressBar(a, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setIndeterminate(true);
        bar.setPadding(Ui.dp(14), 0, Ui.dp(14), Ui.dp(14));
        card.addView(bar, Ui.fill());
        TextView note = Ui.text(a, "It goes on by itself if you close this: the project's menu says how far it is.", 13, Ui.G700);
        note.setPadding(Ui.dp(6), 0, Ui.dp(6), Ui.dp(6));
        s.body.addView(note);
        s.show();
        Handler h = new Handler(Looper.getMainLooper());
        boolean[] open = {true};
        s.dialog.setOnDismissListener(d -> open[0] = false);
        Runnable[] tick = new Runnable[1];
        tick[0] = () -> {
            if (!open[0] || a.isFinishing() || a.isDestroyed()) return;
            Ui.bg(a, () -> {
                JSONObject q = new JSONObject().put("step", "status");
                if (at != null && !at.optString("pc").isEmpty()) {
                    q.put("pc", at.optString("pc"));
                    return call(hub, at.optString("project", pid), q);
                }
                return call(hub, pid, q);
            }, st -> {
                if (!open[0]) return;
                String state = st.optString("state");
                String to = st.optString("to_name", "the PC");
                if ("running".equals(state)) {
                    stage.setText(to.isEmpty() ? st.optString("stage") : "To " + to + ": " + st.optString("stage"));
                    if (st.isNull("percent")) bar.setIndeterminate(true);
                    else { bar.setIndeterminate(false); bar.setProgress(st.optInt("percent")); }
                    h.postDelayed(tick[0], 1000);
                    return;
                }
                if ("none".equals(state)) { s.dismiss(); return; }
                bar.setIndeterminate(false);
                bar.setProgress("done".equals(state) ? 100 : bar.getProgress());
                String title = "done".equals(state) ? "Moved " + name + " to " + to
                        : "partial".equals(state) ? name + " partly moved to " + to : "Couldn't move " + name;
                stage.setText(title);
                note.setText(st.optString("result"));
                after.run();
            });
        };
        h.postDelayed(tick[0], 400);
    }
}
