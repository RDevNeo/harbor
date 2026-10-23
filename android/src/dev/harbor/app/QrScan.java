package dev.harbor.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Size;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.nio.ByteBuffer;
import java.util.Arrays;

/** The in-app QR scanner for pairing: a full-screen back-camera preview with a framing square,
 *  torch and close. Camera2 streams YUV frames to an ImageReader; a few a second have their Y
 *  plane decoded (QrDecode, vendored ZXing) on a background thread.
 *
 *  Contract: start it for a result. RESULT_OK carries the harbor://pair link as the Intent's
 *  data (and as the EXTRA_LINK string); anything else is RESULT_CANCELED. Other QR codes only
 *  show a hint. It asks for the CAMERA permission itself. */
public class QrScan extends Activity {
    static final String EXTRA_LINK = "link";
    private static final int PERM = 1;
    /** Decode at most this often (ms): a few fps keeps the phone cool and is plenty to aim. */
    private static final long EVERY = 200;
    /** The framing square's side, as a fraction of the screen's width. */
    private static final float FRAME = 0.7f;

    private float density;
    private Typeface sans, semi;
    private FrameLayout root;
    private TextureView preview;
    private Overlay overlay;
    private TextView hint, torchBtn;
    private View denied;

    private HandlerThread camThread, decThread;
    private Handler cam, dec;
    private volatile CameraDevice device;
    private CameraCaptureSession session;
    private CaptureRequest.Builder request;
    private ImageReader reader;
    private Size previewSize, frameSize;
    private int sensorOrientation;
    private boolean hasTorch, torch, opening;
    private volatile boolean paused = true;
    private volatile boolean busy, done;
    private long lastDecode;
    private int frames;
    private byte[] luma;
    private final QrDecode decoder = new QrDecode();
    private final Runnable hintBack = () -> hint.setText(AIM);
    private static final String AIM = "Point the camera at the QR code on the PC\n(Harbor › Settings › Phones › Pair a phone)";

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        density = getResources().getDisplayMetrics().density;
        try {
            sans = Typeface.createFromAsset(getAssets(), "fonts/Geist-Regular.ttf");
            semi = Typeface.createFromAsset(getAssets(), "fonts/Geist-SemiBold.ttf");
        } catch (RuntimeException e) {
            sans = Typeface.DEFAULT; semi = Typeface.DEFAULT_BOLD;
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        setResult(RESULT_CANCELED);
        camThread = new HandlerThread("qr-camera"); camThread.start(); cam = new Handler(camThread.getLooper());
        decThread = new HandlerThread("qr-decode"); decThread.start(); dec = new Handler(decThread.getLooper());

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        preview = new TextureView(this);
        root.addView(preview, new FrameLayout.LayoutParams(-1, -1));
        overlay = new Overlay(this);
        root.addView(overlay, new FrameLayout.LayoutParams(-1, -1));

        hint = text(AIM, 15, 0xffededed, false);
        hint.setGravity(Gravity.CENTER);
        hint.setShadowLayer(dp(4), 0, 0, 0xcc000000);
        FrameLayout.LayoutParams hl = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        hl.setMargins(dp(24), 0, dp(24), dp(56));
        root.addView(hint, hl);

        TextView close = roundButton(new Glyph(Glyph.X), "Close");
        close.setOnClickListener(v -> finish());
        FrameLayout.LayoutParams cl = new FrameLayout.LayoutParams(dp(48), dp(48), Gravity.TOP | Gravity.START);
        cl.setMargins(dp(16), dp(16), 0, 0);
        root.addView(close, cl);

        torchBtn = roundButton(new Glyph(Glyph.BOLT), "Torch");
        torchBtn.setOnClickListener(v -> setTorch(!torch));
        torchBtn.setVisibility(View.GONE);
        FrameLayout.LayoutParams tl = new FrameLayout.LayoutParams(dp(48), dp(48), Gravity.TOP | Gravity.END);
        tl.setMargins(0, dp(16), dp(16), 0);
        root.addView(torchBtn, tl);

        setContentView(root);
        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            public void onSurfaceTextureAvailable(SurfaceTexture s, int w, int h) { start(); }
            public void onSurfaceTextureSizeChanged(SurfaceTexture s, int w, int h) { fitPreview(); }
            public boolean onSurfaceTextureDestroyed(SurfaceTexture s) { return true; }
            public void onSurfaceTextureUpdated(SurfaceTexture s) {}
        });
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.CAMERA}, PERM);
    }

    @Override
    protected void onResume() {
        super.onResume();
        paused = false;
        busy = false;
        if (preview.isAvailable()) start();
    }

    @Override
    protected void onPause() {
        paused = true;
        stop();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        camThread.quitSafely();
        decThread.quitSafely();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req != PERM) return;
        if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) start();
        else showDenied();
    }

    // ---- camera ----

    /** Opens the back camera once the preview surface exists and CAMERA is granted. */
    private void start() {
        if (device != null || opening || paused || !preview.isAvailable()) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        if (denied != null) { root.removeView(denied); denied = null; }
        CameraManager cm = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
        try {
            String id = pickCamera(cm);
            if (id == null) { fail("This phone has no camera Harbor can use."); return; }
            CameraCharacteristics ch = cm.getCameraCharacteristics(id);
            StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Integer so = ch.get(CameraCharacteristics.SENSOR_ORIENTATION);
            sensorOrientation = so == null ? 90 : so;
            Boolean flash = ch.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            hasTorch = flash != null && flash;
            torchBtn.setVisibility(hasTorch ? View.VISIBLE : View.GONE);
            // Decode frames near 1280×720: a QR code on a monitor fills plenty of those pixels,
            // and ZXing stays fast. The preview gets the same aspect so the square lines up.
            frameSize = pick(map.getOutputSizes(ImageFormat.YUV_420_888), 1280 * 720, null);
            previewSize = pick(map.getOutputSizes(SurfaceTexture.class), 1920 * 1080, frameSize);
            reader = ImageReader.newInstance(frameSize.getWidth(), frameSize.getHeight(), ImageFormat.YUV_420_888, 2);
            reader.setOnImageAvailableListener(this::onFrame, cam);
            fitPreview();
            opening = true;
            cm.openCamera(id, new CameraDevice.StateCallback() {
                public void onOpened(CameraDevice d) {
                    opening = false;
                    if (paused) { d.close(); return; }
                    device = d;
                    session();
                }
                public void onDisconnected(CameraDevice d) { opening = false; d.close(); device = null; }
                public void onError(CameraDevice d, int err) {
                    opening = false; d.close(); device = null;
                    runOnUiThread(() -> fail("The camera is busy or unavailable (error " + err + "). Close other camera apps and try again."));
                }
            }, cam);
        } catch (CameraAccessException | RuntimeException e) {
            opening = false;
            fail("Couldn't open the camera: " + e.getMessage());
        }
    }

    private static String pickCamera(CameraManager cm) throws CameraAccessException {
        String any = null;
        for (String id : cm.getCameraIdList()) {
            Integer f = cm.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
            if (f != null && f == CameraCharacteristics.LENS_FACING_BACK) return id;
            if (any == null) any = id;
        }
        return any;
    }

    /** The size closest to `area` pixels, among those with `like`'s aspect when there are any. */
    private static Size pick(Size[] sizes, int area, Size like) {
        Size best = null;
        for (int pass = 0; pass < 2 && best == null; pass++)
            for (Size s : sizes) {
                if (pass == 0 && like != null && (long) s.getWidth() * like.getHeight() != (long) s.getHeight() * like.getWidth()) continue;
                if (best == null || Math.abs(s.getWidth() * s.getHeight() - area) < Math.abs(best.getWidth() * best.getHeight() - area))
                    best = s;
            }
        return best;
    }

    private void session() {
        try {
            SurfaceTexture st = preview.getSurfaceTexture();
            st.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            Surface out = new Surface(st);
            request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            request.addTarget(out);
            request.addTarget(reader.getSurface());
            request.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
            int[] af = device == null ? null : ((CameraManager) getSystemService(Context.CAMERA_SERVICE))
                    .getCameraCharacteristics(device.getId()).get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
            if (af != null && contains(af, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE))
                request.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            else if (af != null && contains(af, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO))
                request.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
            device.createCaptureSession(Arrays.asList(out, reader.getSurface()), new CameraCaptureSession.StateCallback() {
                public void onConfigured(CameraCaptureSession s) {
                    if (device == null) { s.close(); return; }
                    session = s;
                    repeat();
                }
                public void onConfigureFailed(CameraCaptureSession s) {
                    runOnUiThread(() -> fail("The camera couldn't start a preview."));
                }
            }, cam);
        } catch (CameraAccessException | RuntimeException e) {
            runOnUiThread(() -> fail("Couldn't start the camera: " + e.getMessage()));
        }
    }

    private static boolean contains(int[] a, int v) {
        for (int x : a) if (x == v) return true;
        return false;
    }

    private void repeat() {
        if (session == null || request == null) return;
        request.set(CaptureRequest.FLASH_MODE, torch ? CaptureRequest.FLASH_MODE_TORCH : CaptureRequest.FLASH_MODE_OFF);
        try {
            session.setRepeatingRequest(request.build(), null, cam);
        } catch (CameraAccessException | RuntimeException ignored) {
        }
    }

    private void setTorch(boolean on) {
        torch = on;
        torchBtn.setBackground(circle(on ? 0xffededed : 0x99000000));
        ((Glyph) torchBtn.getTag()).color = on ? Color.BLACK : 0xffededed;
        torchBtn.invalidate();
        torchBtn.setContentDescription(on ? "Turn the torch off" : "Turn the torch on");
        cam.post(this::repeat);
    }

    private void stop() {
        if (session != null) { try { session.close(); } catch (RuntimeException ignored) {} session = null; }
        if (device != null) { device.close(); device = null; }
        if (reader != null) { reader.close(); reader = null; }
        request = null;
        if (torch) { torch = false; torchBtn.setBackground(circle(0x99000000)); ((Glyph) torchBtn.getTag()).color = 0xffededed; }
    }

    /** Scales the preview to fill the screen (centre crop, no stretching). The activity is
     *  portrait-only, so a landscape sensor's buffer arrives rotated to upright; only its aspect
     *  needs fixing. */
    private void fitPreview() {
        if (previewSize == null) return;
        float vw = preview.getWidth(), vh = preview.getHeight();
        if (vw == 0 || vh == 0) return;
        boolean swap = sensorOrientation % 180 != 0;
        float bw = swap ? previewSize.getHeight() : previewSize.getWidth();
        float bh = swap ? previewSize.getWidth() : previewSize.getHeight();
        float s = Math.max(vw / bw, vh / bh);
        Matrix m = new Matrix();
        m.setScale(bw * s / vw, bh * s / vh, vw / 2, vh / 2);
        preview.setTransform(m);
    }

    // ---- decoding ----

    private void onFrame(ImageReader r) {
        Image img;
        try { img = r.acquireLatestImage(); } catch (RuntimeException e) { return; }
        if (img == null) return;
        try {
            long now = SystemClock.uptimeMillis();
            if (done || busy || now - lastDecode < EVERY) return;
            Image.Plane yp = img.getPlanes()[0];
            ByteBuffer buf = yp.getBuffer();
            int w = img.getWidth(), h = img.getHeight(), stride = yp.getRowStride();
            int n = buf.remaining();
            // The Y plane has a pixel stride of 1; its last row may stop short of the stride.
            if (luma == null || luma.length < stride * h) luma = new byte[stride * h];
            buf.get(luma, 0, Math.min(n, luma.length));
            lastDecode = now;
            busy = true;
            final byte[] y = luma;
            final boolean inv = (frames++ & 1) == 1;
            final int side = squareInFrame(w, h);
            dec.post(() -> {
                String text = decoder.decode(y, stride, w, h, side, inv);
                busy = false;
                if (text != null) runOnUiThread(() -> found(text.trim()));
            });
        } finally {
            img.close();
        }
    }

    /** The on-screen framing square's side in frame pixels, with some slack around it. */
    private int squareInFrame(int w, int h) {
        float vw = preview.getWidth(), vh = preview.getHeight();
        boolean swap = sensorOrientation % 180 != 0;
        float fw = swap ? h : w, fh = swap ? w : h;
        if (vw == 0 || vh == 0) return Math.min(w, h);
        float s = Math.max(vw / fw, vh / fh); // screen pixels per frame pixel (centre crop)
        return Math.round(vw * FRAME * 1.25f / s);
    }

    private void found(String text) {
        if (done) return;
        if (Hub.parse(text) == null) {
            hint.setText("Not a Harbor pairing code");
            hint.removeCallbacks(hintBack);
            hint.postDelayed(hintBack, 2000);
            return;
        }
        done = true;
        root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
        setResult(RESULT_OK, new Intent().setData(Uri.parse(text)).putExtra(EXTRA_LINK, text));
        finish();
    }

    // ---- no camera ----

    private void showDenied() {
        boolean canAsk = shouldShowRequestPermissionRationale(Manifest.permission.CAMERA);
        panel("Camera access is off",
                "Harbor needs the camera only to read the pairing QR code; nothing is recorded or sent anywhere."
                        + (canAsk ? "" : "\n\nTurn it on in Android's settings: Permissions › Camera › Allow only while using the app.")
                        + "\n\nOr close this and paste the pairing link instead.",
                canAsk ? "Allow camera" : "Open settings", v -> {
                    if (canAsk) requestPermissions(new String[]{Manifest.permission.CAMERA}, PERM);
                    else startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null)));
                });
    }

    private void fail(String msg) {
        stop();
        panel("Can't use the camera", msg + "\n\nOr close this and paste the pairing link instead.", "Try again", v -> start());
    }

    private void panel(String title, String body, String action, View.OnClickListener go) {
        if (denied != null) root.removeView(denied);
        LinearLayout p = new LinearLayout(this);
        p.setOrientation(LinearLayout.VERTICAL);
        p.setGravity(Gravity.CENTER);
        p.setPadding(dp(32), dp(32), dp(32), dp(32));
        p.setBackgroundColor(0xff0a0a0a);
        p.setClickable(true);
        TextView t = text(title, 20, 0xffededed, true);
        t.setGravity(Gravity.CENTER);
        p.addView(t);
        TextView b = text(body, 15, 0xffa0a0a0, false);
        b.setGravity(Gravity.CENTER);
        b.setPadding(0, dp(12), 0, dp(24));
        p.addView(b);
        TextView a = text(action, 15, Color.BLACK, true);
        a.setGravity(Gravity.CENTER);
        a.setPadding(dp(24), dp(12), dp(24), dp(12));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xffededed);
        bg.setCornerRadius(dp(8));
        a.setBackground(bg);
        a.setOnClickListener(go);
        p.addView(a, new LinearLayout.LayoutParams(-2, -2));
        // Below the close button, so Close keeps working.
        root.addView(p, 1, new FrameLayout.LayoutParams(-1, -1));
        denied = p;
    }

    @Override
    protected void onRestart() {
        super.onRestart();
        // Back from Android's settings with the permission now on.
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED && denied != null) {
            root.removeView(denied);
            denied = null;
        }
    }

    // ---- views ----

    private int dp(float v) { return Math.round(v * density); }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setTypeface(bold ? semi : sans);
        return t;
    }

    private GradientDrawable circle(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(color);
        return d;
    }

    private TextView roundButton(Glyph g, String desc) {
        TextView b = new TextView(this) {
            @Override protected void onDraw(Canvas c) { super.onDraw(c); g.draw(c, getWidth(), getHeight(), density); }
        };
        b.setTag(g);
        b.setBackground(circle(0x99000000));
        b.setContentDescription(desc);
        return b;
    }

    /** Close (×) and torch (bolt) icons, stroked like Lucide's. */
    private static final class Glyph {
        static final int X = 0, BOLT = 1;
        final int kind;
        int color = 0xffededed;
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        Glyph(int kind) { this.kind = kind; }

        void draw(Canvas c, int w, int h, float d) {
            p.setColor(color);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(2 * d);
            p.setStrokeCap(Paint.Cap.ROUND);
            p.setStrokeJoin(Paint.Join.ROUND);
            float cx = w / 2f, cy = h / 2f, u = d; // Lucide's 24-unit grid at 1dp a unit
            Path path = new Path();
            if (kind == X) {
                path.moveTo(cx - 6 * u, cy - 6 * u); path.lineTo(cx + 6 * u, cy + 6 * u);
                path.moveTo(cx + 6 * u, cy - 6 * u); path.lineTo(cx - 6 * u, cy + 6 * u);
            } else {
                path.moveTo(cx + 1 * u, cy - 10 * u); path.lineTo(cx - 7 * u, cy + 2 * u);
                path.lineTo(cx, cy + 2 * u); path.lineTo(cx - 1 * u, cy + 10 * u);
                path.lineTo(cx + 7 * u, cy - 2 * u); path.lineTo(cx, cy - 2 * u); path.close();
            }
            c.drawPath(path, p);
        }
    }

    /** Dims everything but the framing square and draws its corners. */
    private static final class Overlay extends View {
        private final Paint dim = new Paint(), line = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private final RectF r = new RectF();

        Overlay(Context c) {
            super(c);
            dim.setColor(0x99000000);
            line.setColor(0xffededed);
            line.setStyle(Paint.Style.STROKE);
            line.setStrokeCap(Paint.Cap.ROUND);
            line.setStrokeJoin(Paint.Join.ROUND);
        }

        @Override
        protected void onDraw(Canvas c) {
            float w = getWidth(), h = getHeight(), d = getResources().getDisplayMetrics().density;
            float side = w * FRAME, l = (w - side) / 2, t = (h - side) / 2;
            r.set(l, t, l + side, t + side);
            c.drawRect(0, 0, w, t, dim);
            c.drawRect(0, r.bottom, w, h, dim);
            c.drawRect(0, t, l, r.bottom, dim);
            c.drawRect(r.right, t, w, r.bottom, dim);
            line.setStrokeWidth(4 * d);
            float k = 28 * d;
            path.reset();
            path.moveTo(r.left, r.top + k); path.lineTo(r.left, r.top); path.lineTo(r.left + k, r.top);
            path.moveTo(r.right - k, r.top); path.lineTo(r.right, r.top); path.lineTo(r.right, r.top + k);
            path.moveTo(r.right, r.bottom - k); path.lineTo(r.right, r.bottom); path.lineTo(r.right - k, r.bottom);
            path.moveTo(r.left + k, r.bottom); path.lineTo(r.left, r.bottom); path.lineTo(r.left, r.bottom - k);
            c.drawPath(path, line);
        }
    }
}
