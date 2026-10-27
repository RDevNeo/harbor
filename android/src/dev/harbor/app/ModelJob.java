package dev.harbor.app;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.util.Log;

import java.util.concurrent.atomic.AtomicBoolean;

/** Downloads dictation's offline model (Asr) while the phone is on Wi-Fi (an unmetered network).
 *  Android stops jobs after a few minutes or when Wi-Fi goes; the download resumes where it
 *  stopped on the next run. */
public class ModelJob extends JobService {
    private final AtomicBoolean stop = new AtomicBoolean();

    @Override
    public boolean onStartJob(JobParameters p) {
        stop.set(false);
        Ui.pool.execute(() -> {
            boolean again;
            try {
                again = !Asr.download(this, stop);
            } catch (Exception e) {
                Log.w(Asr.TAG, "model download: " + e);
                Asr.failure = e.getMessage();
                again = true;
            }
            Asr.progress = -1;
            jobFinished(p, again && Asr.wanted(this));
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters p) {
        stop.set(true);
        return Asr.wanted(this);
    }
}
