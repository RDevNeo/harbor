package dev.harbor.app;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** A voice message from another app (the local API's audio attachment: WebM/Opus, MP4/AAC or
 *  Ogg/Opus, as a WebView's MediaRecorder makes them) decoded on the phone by Android's own
 *  decoders into what the PC's /v1/transcribe takes, a 16 kHz mono 16-bit WAV (LocalFiles.Wav16k):
 *  the same request the composer's mic makes. The PC needs no change. */
final class LocalVoice {
    private LocalVoice() { }

    /** The decoding may take this long (a 2-minute clip decodes in about a second). */
    static final long DECODE_TIME = 30_000;

    /** The recording in file as a WAV for /v1/transcribe; LocalHttp.Bad when it can't be: 415
     *  bad_attachment (no audio Android can decode), 413 audio_too_long. */
    static LocalFiles.Wav16k decode(File file) throws IOException {
        MediaExtractor ex = new MediaExtractor();
        MediaCodec codec = null;
        try {
            try {
                ex.setDataSource(file.getPath());
            } catch (IOException | RuntimeException e) {
                throw new LocalHttp.Bad(415, "bad_attachment", "Harbor can't read the voice message: " + e.getMessage());
            }
            int track = -1;
            MediaFormat f = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat t = ex.getTrackFormat(i);
                String m = t.getString(MediaFormat.KEY_MIME);
                if (m != null && m.startsWith("audio/")) { track = i; f = t; break; }
            }
            if (track < 0) throw new LocalHttp.Bad(415, "bad_attachment", "The voice message has no sound track");
            if (f.containsKey(MediaFormat.KEY_DURATION) && f.getLong(MediaFormat.KEY_DURATION) > (LocalFiles.MAX_AUDIO_SECONDS + 2) * 1_000_000L)
                throw new LocalHttp.Bad(413, "audio_too_long", "A voice message may be about " + (LocalFiles.MAX_AUDIO_SECONDS / 60) + " minutes long");
            ex.selectTrack(track);
            String mime = f.getString(MediaFormat.KEY_MIME);
            try {
                codec = MediaCodec.createDecoderByType(mime);
                codec.configure(f, null, null, 0);
                codec.start();
            } catch (IOException | RuntimeException e) {
                throw new LocalHttp.Bad(415, "bad_attachment", "This phone can't decode the voice message (" + mime + ")");
            }
            LocalFiles.Wav16k w = new LocalFiles.Wav16k();
            w.format(f.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? f.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 48_000,
                    f.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? f.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 1);
            int encoding = AudioFormat.ENCODING_PCM_16BIT;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inDone = false;
            float[] floats = new float[8190]; // whole frames of 1, 2, 3, 5, 6 or 7 channels
            long end = System.currentTimeMillis() + DECODE_TIME;
            while (true) {
                if (System.currentTimeMillis() > end) throw new LocalHttp.Bad(415, "bad_attachment", "The voice message took too long to decode");
                if (!inDone) {
                    int in = codec.dequeueInputBuffer(10_000);
                    if (in >= 0) {
                        ByteBuffer b = codec.getInputBuffer(in);
                        int n = b == null ? -1 : ex.readSampleData(b, 0);
                        if (n < 0) {
                            codec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            codec.queueInputBuffer(in, 0, n, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }
                int out = codec.dequeueOutputBuffer(info, 10_000);
                if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = codec.getOutputFormat();
                    w.format(of.getInteger(MediaFormat.KEY_SAMPLE_RATE), of.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
                    if (of.containsKey(MediaFormat.KEY_PCM_ENCODING)) encoding = of.getInteger(MediaFormat.KEY_PCM_ENCODING);
                    continue;
                }
                if (out < 0) continue;
                ByteBuffer b = codec.getOutputBuffer(out);
                if (b != null && info.size > 0) {
                    b.position(info.offset).limit(info.offset + info.size);
                    b = b.slice().order(ByteOrder.nativeOrder());
                    if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
                        java.nio.FloatBuffer fb = b.asFloatBuffer();
                        while (fb.hasRemaining()) {
                            int n = Math.min(floats.length, fb.remaining());
                            fb.get(floats, 0, n);
                            w.push(floats, n);
                        }
                    } else {
                        java.nio.ShortBuffer sb = b.asShortBuffer();
                        while (sb.hasRemaining()) {
                            int n = Math.min(floats.length, sb.remaining());
                            for (int i = 0; i < n; i++) floats[i] = sb.get() / 32768f;
                            w.push(floats, n);
                        }
                    }
                }
                codec.releaseOutputBuffer(out, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
            }
            if (w.out == 0) throw new LocalHttp.Bad(415, "bad_attachment", "The voice message has no sound in it");
            return w;
        } finally {
            if (codec != null) {
                try { codec.stop(); } catch (RuntimeException ignored) { }
                codec.release();
            }
            ex.release();
        }
    }
}
