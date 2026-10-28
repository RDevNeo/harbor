package dev.harbor.app;

import android.app.ActivityManager;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.util.Log;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineStream;
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig;
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig;
import com.k2fsa.sherpa.onnx.SileroVadModelConfig;
import com.k2fsa.sherpa.onnx.Vad;
import com.k2fsa.sherpa.onnx.VadModelConfig;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;

/** Dictation on the phone itself, with sherpa-onnx (third_party/sherpa-onnx): Silero VAD cuts the
 *  recording into phrases (Voice), and when the PC can't transcribe one, an offline model here
 *  does. The model follows the phone's memory (Parakeet TDT 0.6B v3 from 6 GB, Whisper small from
 *  4 GB, Whisper base below), is downloaded on Wi-Fi after the first dictation (ModelJob, resumed
 *  across runs, every file checked against its SHA-256), loaded only while a dictation needs it
 *  and freed after. Phones whose ABI the APK has no library for (it ships arm64-v8a) record whole
 *  dictations for the PC instead. */
final class Asr {
    static final String TAG = "HarborVoice";

    /** An offline model: its files on Hugging Face, pinned by commit, size and SHA-256. */
    static final class Model {
        final String id, name, repo, rev;
        final boolean whisper;
        final String[][] files;

        Model(String id, String name, boolean whisper, String repo, String rev, String[][] files) {
            this.id = id; this.name = name; this.whisper = whisper; this.repo = repo; this.rev = rev; this.files = files;
        }

        long bytes() { long n = 0; for (String[] f : files) n += Long.parseLong(f[1]); return n; }

        String mb() { return Math.round(bytes() / 1e6) + " MB"; }
    }

    static final Model PARAKEET = new Model("parakeet-tdt-0.6b-v3", "Parakeet TDT 0.6B v3", false,
            "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "2bda32ec70b097a55adaa07d9a7173915b43cc78", new String[][]{
            {"encoder.int8.onnx", "652184281", "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"},
            {"decoder.int8.onnx", "11845275", "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"},
            {"joiner.int8.onnx", "6355277", "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"},
            {"tokens.txt", "93939", "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"}});
    static final Model WHISPER_SMALL = new Model("whisper-small", "Whisper small", true,
            "csukuangfj/sherpa-onnx-whisper-small", "8f3c18b358db4d1f2fc1eae49d75cd20989e4309", new String[][]{
            {"small-encoder.int8.onnx", "112442483", "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9"},
            {"small-decoder.int8.onnx", "262226114", "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee"},
            {"small-tokens.txt", "816730", "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126"}});
    static final Model WHISPER_BASE = new Model("whisper-base", "Whisper base", true,
            "csukuangfj/sherpa-onnx-whisper-base", "bb53ee204431c90d314c1cc08d28d23e5b7927cc", new String[][]{
            {"base-encoder.int8.onnx", "29120534", "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11"},
            {"base-decoder.int8.onnx", "130672026", "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d"},
            {"base-tokens.txt", "816730", "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126"}});

    /** By the phone's memory (a "6 GB" phone reports ~5.5 GB, a "4 GB" one ~3.6 GB). */
    static Model pick(Context c) {
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        c.getSystemService(ActivityManager.class).getMemoryInfo(mi);
        if (mi.totalMem >= 5_000_000_000L) return PARAKEET;
        if (mi.totalMem >= 3_200_000_000L) return WHISPER_SMALL;
        return WHISPER_BASE;
    }

    // ---- the native library ----

    private static Boolean lib;

    /** The ABIs android/build.sh packs the library for (ANDROID_ABIS). */
    static final String[] ABIS = {"arm64-v8a", "armeabi-v7a"};

    /** False when this APK has no sherpa-onnx library for the phone's ABI. An x86 device (the
     *  emulator, ChromeOS) runs the ARM one through the native bridge (libndk_translation),
     *  where loading it dies in native code (SIGSEGV, #97) where no catch can help: so it's
     *  only loaded when the phone's own ABI is one the APK ships. */
    static synchronized boolean available() {
        if (lib == null && !java.util.Arrays.asList(ABIS).contains(android.os.Build.SUPPORTED_ABIS[0])) {
            Log.w(TAG, "no sherpa-onnx library for " + android.os.Build.SUPPORTED_ABIS[0] + " (not loading the ARM one through translation)");
            lib = false;
        }
        if (lib == null) {
            try { System.loadLibrary("sherpa-onnx-jni"); lib = true; }
            catch (Throwable t) { Log.w(TAG, "no sherpa-onnx library: " + t); lib = false; }
        }
        return lib;
    }

    /** Silero VAD (an asset, copied out once): phrases of speech, cut at ~0.6 s pauses. */
    static Vad vad(Context c) throws IOException {
        File f = new File(c.getFilesDir(), "silero_vad.onnx");
        if (!f.isFile()) {
            File part = new File(f.getPath() + ".part");
            try (InputStream in = c.getAssets().open("silero_vad.onnx"); OutputStream o = new FileOutputStream(part)) {
                byte[] b = new byte[1 << 16];
                for (int n; (n = in.read(b)) > 0; ) o.write(b, 0, n);
            }
            if (!part.renameTo(f)) throw new IOException("couldn't keep the voice detector");
        }
        return new Vad(VadModelConfig.builder()
                .setSileroVadModelConfig(SileroVadModelConfig.builder().setModel(f.getPath()).setThreshold(0.5f)
                        .setMinSilenceDuration(0.6f).setMinSpeechDuration(0.25f).setWindowSize(512).setMaxSpeechDuration(20f).build())
                .setSampleRate(16000).setNumThreads(1).setDebug(false).build());
    }

    // ---- the model on this phone ----

    static File dir(Context c, Model m) { return new File(c.getFilesDir(), "asr/" + m.id); }

    /** Every file of the phone's model is here and was checked. */
    static boolean ready(Context c) {
        Model m = pick(c);
        File d = dir(c, m);
        for (String[] f : m.files) if (!new File(d, f[0] + ".ok").isFile() || new File(d, f[0]).length() != Long.parseLong(f[1])) return false;
        return true;
    }

    /** While ModelJob downloads: 0-100; -1 otherwise. */
    static volatile int progress = -1;
    static volatile String failure;

    static boolean wanted(Context c) { return Ui.prefs(c).getBoolean("asr_want", false); }

    /** The settings row: "Ready", "Downloading 42%", "Waits for Wi-Fi", "Not downloaded". */
    static String state(Context c) {
        if (!available()) return "Not available on this phone";
        if (ready(c)) return "Ready";
        if (progress >= 0) return "Downloading " + progress + "%";
        if (wanted(c)) return failure != null ? "Download failed, retrying on Wi-Fi: " + failure : "Downloads on Wi-Fi";
        return "Not downloaded";
    }

    /** Asks for the model (after the first dictation, or Settings › Download): on Wi-Fi. */
    static void want(Context c) {
        if (!available() || ready(c)) return;
        Ui.prefs(c).edit().putBoolean("asr_want", true).apply();
        schedule(c);
    }

    static final int JOB = 4417;

    static void schedule(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null || js.getPendingJob(JOB) != null) return;
        js.schedule(new JobInfo.Builder(JOB, new ComponentName(c, ModelJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                .setPersisted(true)
                .build());
    }

    /** Settings › Remove: frees the space (and stops a download). */
    static void remove(Context c) {
        Ui.prefs(c).edit().putBoolean("asr_want", false).apply();
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js != null) js.cancel(JOB);
        free();
        delete(new File(c.getFilesDir(), "asr"));
        progress = -1;
        failure = null;
    }

    private static void delete(File f) {
        File[] in = f.listFiles();
        if (in != null) for (File x : in) delete(x);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** ModelJob's work: fetches what's missing (resuming a partial file), checks each file's
     *  SHA-256. False when stopped before the end (the job runs again). */
    static boolean download(Context c, AtomicBoolean stop) throws IOException {
        Model m = pick(c);
        File d = dir(c, m);
        if (!d.isDirectory() && !d.mkdirs()) throw new IOException("no room for the model");
        // Another model (the phone's memory class changed?) isn't needed anymore.
        File[] others = new File(c.getFilesDir(), "asr").listFiles();
        if (others != null) for (File o : others) if (!o.getName().equals(m.id)) delete(o);
        long total = m.bytes(), done = 0;
        for (String[] f : m.files) {
            File out = new File(d, f[0]), ok = new File(d, f[0] + ".ok"), part = new File(d, f[0] + ".part");
            long size = Long.parseLong(f[1]);
            if (ok.isFile() && out.length() == size) { done += size; continue; }
            long have = part.isFile() ? part.length() : 0;
            if (have > size) { part.delete(); have = 0; }
            if (have < size) {
                HttpURLConnection h = (HttpURLConnection) new URL("https://huggingface.co/" + m.repo + "/resolve/" + m.rev + "/" + f[0]).openConnection();
                h.setConnectTimeout(20_000);
                h.setReadTimeout(60_000);
                if (have > 0) h.setRequestProperty("Range", "bytes=" + have + "-");
                int code = h.getResponseCode();
                if (code == 200) have = 0;
                else if (code != 206) throw new IOException("the model's server answered " + code);
                try (InputStream in = h.getInputStream(); OutputStream o = new FileOutputStream(part, have > 0)) {
                    byte[] b = new byte[1 << 16];
                    for (int n; (n = in.read(b)) > 0; ) {
                        o.write(b, 0, n);
                        have += n;
                        progress = (int) ((done + have) * 100 / total);
                        if (stop.get()) return false;
                    }
                } finally {
                    h.disconnect();
                }
                if (have != size) throw new IOException("the download ended early");
            }
            if (!f[2].equals(sha256(part))) { part.delete(); throw new IOException("a model file didn't check out"); }
            out.delete();
            if (!part.renameTo(out) || !ok.createNewFile() && !ok.isFile()) throw new IOException("couldn't keep the model");
            done += size;
        }
        progress = -1;
        failure = null;
        Log.i(TAG, "offline model ready: " + m.name);
        return true;
    }

    private static String sha256(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] b = new byte[1 << 16];
            for (int n; (n = in.read(b)) > 0; ) md.update(b, 0, n);
            StringBuilder s = new StringBuilder();
            for (byte x : md.digest()) s.append(String.format("%02x", x));
            return s.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    // ---- transcribing ----

    private static OfflineRecognizer rec;

    /** Text for a phrase (16 kHz samples); loads the model on first use. Null when it can't. */
    static synchronized String transcribe(Context c, float[] samples, String lang) {
        if (!available() || !ready(c)) return null;
        try {
            if (rec == null) {
                long t = System.currentTimeMillis();
                rec = new OfflineRecognizer(config(c, pick(c), lang));
                Log.i(TAG, "offline model loaded in " + (System.currentTimeMillis() - t) + " ms");
            }
            OfflineStream s = rec.createStream();
            try {
                s.acceptWaveform(samples, 16000);
                rec.decode(s);
                return rec.getResult(s).getText().trim();
            } finally {
                s.release();
            }
        } catch (Throwable t) {
            Log.w(TAG, "offline transcription failed: " + t);
            return null;
        }
    }

    /** After a dictation: the model leaves memory. */
    static synchronized void free() {
        if (rec != null) { rec.release(); rec = null; Log.i(TAG, "offline model freed"); }
    }

    private static OfflineRecognizerConfig config(Context c, Model m, String lang) {
        String d = dir(c, m).getPath() + "/";
        int threads = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2));
        OfflineModelConfig.Builder mc = OfflineModelConfig.builder().setNumThreads(threads).setDebug(false).setProvider("cpu");
        if (m.whisper) {
            String p = m.files[0][0].substring(0, m.files[0][0].indexOf('-'));
            mc.setWhisper(OfflineWhisperModelConfig.builder().setEncoder(d + p + "-encoder.int8.onnx").setDecoder(d + p + "-decoder.int8.onnx")
                    .setLanguage("auto".equals(lang) || lang == null ? "" : lang).setTask("transcribe").build())
                    .setTokens(d + p + "-tokens.txt").setModelType("whisper");
        } else {
            mc.setTransducer(OfflineTransducerModelConfig.builder().setEncoder(d + "encoder.int8.onnx")
                    .setDecoder(d + "decoder.int8.onnx").setJoiner(d + "joiner.int8.onnx").build())
                    .setTokens(d + "tokens.txt").setModelType("nemo_transducer");
        }
        return OfflineRecognizerConfig.builder()
                .setFeatureConfig(FeatureConfig.builder().setSampleRate(16000).setFeatureDim(80).build())
                .setOfflineModelConfig(mc.build()).setDecodingMethod("greedy_search").build();
    }
}
