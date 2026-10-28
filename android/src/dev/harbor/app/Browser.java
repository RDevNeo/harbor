package dev.harbor.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/** The built-in browser, as the desktop's browser pane: a URL bar, back, forward, reload, and
 *  the page drawn by Servo (Engine) into a SurfaceView, with touch, the soft keyboard and
 *  rotation. No WebView or other browser engine is involved.
 *
 *  It runs in its own process (`:browser` in the manifest): the engine's memory goes away with
 *  the screen (the process ends when it closes), and a crash there never takes the chats down.
 *  Links in chats open here (`open`); "Open in my browser" hands the page to the phone's own. */
public class Browser extends Activity implements Engine.Client {
    static final String EXTRA_URL = "url";

    private EditText address;
    private TextView backBtn, fwdBtn, reloadBtn;
    private ProgressBar progress;
    private Page page;
    private String url = "";
    private boolean loading, canBack, canForward, attached;

    /** Opens `url` in the built-in browser, or in the phone's own when this phone can't run it. */
    static void open(Context c, String url) {
        if (!Engine.available(c)) { external(c, url); return; }
        Intent i = new Intent(c, Browser.class).putExtra(EXTRA_URL, url);
        if (!(c instanceof Activity)) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { c.startActivity(i); } catch (Exception e) { external(c, url); }
    }

    static void external(Context c, String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            if (!(c instanceof Activity)) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Exception e) { Ui.copy(c, url); }
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Ui.init(this);
        Ui.bars(this);
        url = getIntent().getStringExtra(EXTRA_URL);
        if (url == null) url = "";

        LinearLayout col = Ui.col(this);
        col.setBackgroundColor(Ui.BG);
        LinearLayout bar = Ui.row(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(Ui.dp(4), Ui.dp(6), Ui.dp(4), Ui.dp(6));
        TextView close = Ui.iconButton(this, Ui.I_X, Ui.FG, v -> finish());
        close.setContentDescription("Close");
        bar.addView(close);
        backBtn = Ui.iconButton(this, Ui.I_LEFT, Ui.FG, v -> nav(0));
        backBtn.setContentDescription("Back");
        bar.addView(backBtn);
        fwdBtn = Ui.iconButton(this, Ui.I_RIGHT, Ui.FG, v -> nav(1));
        fwdBtn.setContentDescription("Forward");
        bar.addView(fwdBtn);
        address = Ui.input(this, "Search or type a URL", false);
        address.setTextSize(15);
        address.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8));
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setSelectAllOnFocus(true);
        address.setOnEditorActionListener((v, id, ev) -> {
            String u = address.getText().toString().trim();
            if (u.isEmpty()) return true;
            hideKeyboard(address);
            address.clearFocus();
            page.requestFocus();
            Engine.post(() -> Engine.load(u));
            return true;
        });
        bar.addView(address, Ui.margins(Ui.weight(), 4, 0, 4, 0));
        reloadBtn = Ui.iconButton(this, Ui.I_ROTATE, Ui.FG, v -> { if (loading) return; nav(2); });
        reloadBtn.setContentDescription("Reload");
        bar.addView(reloadBtn);
        TextView ext = Ui.iconButton(this, Ui.I_EXTERNAL, Ui.FG, v -> { if (Render.web(url)) external(this, url); });
        ext.setContentDescription("Open in my browser");
        bar.addView(ext);
        col.addView(bar, Ui.fill());

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        progress.setVisibility(View.INVISIBLE);
        col.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(3)));

        FrameLayout body = new FrameLayout(this);
        body.setBackgroundColor(0xffffffff);
        col.addView(body, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(col);

        if (!Engine.load()) {
            TextView t = Ui.text(this, Engine.why(), 15, Ui.G700);
            t.setGravity(Gravity.CENTER);
            t.setPadding(Ui.dp(28), Ui.dp(32), Ui.dp(28), Ui.dp(16));
            LinearLayout msg = Ui.col(this);
            msg.setGravity(Gravity.CENTER_HORIZONTAL);
            msg.setBackgroundColor(Ui.BG);
            msg.addView(t, Ui.fill());
            if (Render.web(url)) msg.addView(Ui.button(this, "Open in my browser", true, v -> { external(this, url); finish(); }), Ui.wrap());
            body.addView(msg, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            address.setText(url);
            address.setEnabled(false);
            return;
        }
        Engine.start(this, this);
        page = new Page(this);
        body.addView(page, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        address.setText(url);
        history(false, false);
        if (url.isEmpty()) address.requestFocus();
        else page.requestFocus();
    }

    private void nav(int what) { Engine.post(() -> Engine.nav(what)); }

    @Override
    public void onBackPressed() {
        if (canBack) nav(0);
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        // The engine lives in this process only: closing the browser frees all of it.
        if (isFinishing()) Ui.main.postDelayed(() -> android.os.Process.killProcess(android.os.Process.myPid()), 300);
    }

    // ---- Engine.Client (main thread)

    @Override public void url(String u) {
        url = u;
        if (!address.hasFocus()) address.setText(u);
    }

    @Override public void title(String t) { setTitle(t == null || t.isEmpty() ? "Browser" : t); }

    @Override public void loading(boolean on) {
        // A page starts loading (a link, a submitted form): the field that had the keyboard is gone.
        if (on && !loading && page != null && !address.hasFocus()) hideKeyboard(page);
        loading = on;
        progress.setVisibility(on ? View.VISIBLE : View.INVISIBLE);
        reloadBtn.setAlpha(on ? 0.35f : 1f);
    }

    @Override public void history(boolean back, boolean forward) {
        canBack = back;
        canForward = forward;
        backBtn.setEnabled(back);
        backBtn.setAlpha(back ? 1f : 0.35f);
        fwdBtn.setEnabled(forward);
        fwdBtn.setAlpha(forward ? 1f : 0.35f);
    }

    @Override public void ime(boolean show) {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm == null || page == null) return;
        if (show) {
            page.requestFocus();
            imm.restartInput(page);
            imm.showSoftInput(page, 0);
        } else {
            imm.hideSoftInputFromWindow(page.getWindowToken(), 0);
        }
    }

    private void hideKeyboard(View v) {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(v.getWindowToken(), 0);
    }

    /** The page: Servo draws into its Surface; touches and keys go to Servo as they are. */
    private final class Page extends SurfaceView implements SurfaceHolder.Callback {
        Page(Context c) {
            super(c);
            setFocusable(true);
            setFocusableInTouchMode(true);
            getHolder().addCallback(this);
        }

        @Override public void surfaceCreated(SurfaceHolder h) {}

        @Override public void surfaceChanged(SurfaceHolder h, int format, int w, int hgt) {
            android.view.Surface s = h.getSurface();
            String start = url;
            if (!attached) {
                // The first Surface: creates the page.
                attached = true;
                Engine.post(() -> Engine.attach(s, w, hgt, start));
            } else if (reattach) {
                // Back from the background (or after a rotation that replaced it): rebind.
                reattach = false;
                Engine.post(() -> Engine.attach(s, w, hgt, ""));
            } else {
                Engine.post(() -> Engine.resize(w, hgt));
            }
        }

        @Override public void surfaceDestroyed(SurfaceHolder h) {
            // Wait for the engine to let go of the Surface before Android destroys it.
            java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
            Engine.post(() -> { Engine.detach(); done.countDown(); });
            try { done.await(2, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
            reattach = true;
        }

        private boolean reattach;

        @Override public boolean onTouchEvent(MotionEvent e) {
            int a = e.getActionMasked();
            if (a == MotionEvent.ACTION_DOWN) requestFocus();
            switch (a) {
                case MotionEvent.ACTION_DOWN:
                case MotionEvent.ACTION_POINTER_DOWN:
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_POINTER_UP: {
                    int i = e.getActionIndex();
                    int kind = a == MotionEvent.ACTION_DOWN || a == MotionEvent.ACTION_POINTER_DOWN ? 0 : 2;
                    int id = e.getPointerId(i);
                    float x = e.getX(i), y = e.getY(i);
                    Engine.post(() -> Engine.touch(kind, id, x, y));
                    break;
                }
                case MotionEvent.ACTION_MOVE:
                    for (int i = 0; i < e.getPointerCount(); i++) {
                        int id = e.getPointerId(i);
                        float x = e.getX(i), y = e.getY(i);
                        Engine.post(() -> Engine.touch(1, id, x, y));
                    }
                    break;
                case MotionEvent.ACTION_CANCEL:
                    for (int i = 0; i < e.getPointerCount(); i++) {
                        int id = e.getPointerId(i);
                        float x = e.getX(i), y = e.getY(i);
                        Engine.post(() -> Engine.touch(3, id, x, y));
                    }
                    break;
                default:
                    return super.onTouchEvent(e);
            }
            return true;
        }

        @Override public boolean onCheckIsTextEditor() { return true; }

        @Override public InputConnection onCreateInputConnection(EditorInfo out) {
            // Characters come one by one (no composing): what a terminal does, and what the
            // page's text field expects from key events.
            out.inputType = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
            out.imeOptions = EditorInfo.IME_ACTION_GO | EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_FLAG_NO_FULLSCREEN;
            return new BaseInputConnection(this, false) {
                private String composing = "";

                @Override public boolean commitText(CharSequence text, int pos) {
                    composing = "";
                    String t = text.toString();
                    Engine.post(() -> Engine.imeText(t));
                    return true;
                }

                @Override public boolean setComposingText(CharSequence text, int pos) {
                    composing = text.toString();
                    return true;
                }

                @Override public boolean finishComposingText() {
                    if (!composing.isEmpty()) {
                        String t = composing;
                        composing = "";
                        Engine.post(() -> Engine.imeText(t));
                    }
                    return true;
                }

                @Override public boolean deleteSurroundingText(int before, int after) {
                    for (int i = 0; i < before; i++) keyTap(KeyEvent.KEYCODE_DEL);
                    for (int i = 0; i < after; i++) keyTap(KeyEvent.KEYCODE_FORWARD_DEL);
                    return true;
                }

                @Override public boolean sendKeyEvent(KeyEvent e) {
                    keyEvent(e);
                    return true;
                }

                @Override public boolean performEditorAction(int action) {
                    keyTap(KeyEvent.KEYCODE_ENTER);
                    return true;
                }
            };
        }

        @Override public boolean onKeyDown(int code, KeyEvent e) {
            if (code == KeyEvent.KEYCODE_BACK) return super.onKeyDown(code, e);
            keyEvent(e);
            return true;
        }

        @Override public boolean onKeyUp(int code, KeyEvent e) {
            if (code == KeyEvent.KEYCODE_BACK) return super.onKeyUp(code, e);
            keyEvent(e);
            return true;
        }

        private void keyEvent(KeyEvent e) {
            int code = e.getKeyCode(), uni = e.getUnicodeChar();
            boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
            if (e.getAction() == KeyEvent.ACTION_MULTIPLE) return;
            Engine.post(() -> Engine.key(code, uni, down));
        }

        private void keyTap(int code) {
            Engine.post(() -> { Engine.key(code, 0, true); Engine.key(code, 0, false); });
        }
    }
}
