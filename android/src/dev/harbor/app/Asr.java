package dev.harbor.app;

import android.app.job.JobScheduler;
import android.content.Context;
import android.util.Log;

import com.k2fsa.sherpa.onnx.SileroVadModelConfig;
import com.k2fsa.sherpa.onnx.Vad;
import com.k2fsa.sherpa.onnx.VadModelConfig;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** The phone's part of dictation, with sherpa-onnx (third_party/sherpa-onnx): Silero VAD, which
 *  ships in the APK, cuts the recording into phrases (Voice) so each goes to the PC while you
 *  talk. Nothing is transcribed or downloaded here: the PCs transcribe every phrase (since 0.147;
 *  a model an older app downloaded is deleted, {@link #dropModel}). Phones whose ABI the APK has
 *  no library for (it ships arm64-v8a and armeabi-v7a) record whole dictations for the PC. */
final class Asr {
    static final String TAG = "HarborVoice";

    private Asr() { }

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

    // ---- the offline model of apps before 0.147 ----

    /** Its download job's id (ModelJob, gone). */
    private static final int OLD_JOB = 4417;

    /** Deletes the offline model (Whisper or Parakeet, up to ~670 MB) and its download job, left by
     *  an app before 0.147. Cheap when there's none: one directory check. Off the UI thread. */
    static void dropModel(Context c) {
        File d = new File(c.getFilesDir(), "asr");
        if (!d.exists() && !Ui.prefs(c).contains("asr_want")) return;
        try {
            JobScheduler js = c.getSystemService(JobScheduler.class);
            if (js != null) js.cancel(OLD_JOB);
        } catch (Exception ignored) { }
        delete(d);
        Ui.prefs(c).edit().remove("asr_want").remove("voice_dict").remove("voice_commands").remove("voice_lang2").apply();
        Log.i(TAG, "removed the offline dictation model");
    }

    private static void delete(File f) {
        File[] in = f.listFiles();
        if (in != null) for (File x : in) delete(x);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
