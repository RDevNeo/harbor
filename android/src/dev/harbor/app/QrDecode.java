package dev.harbor.app;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.LuminanceSource;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.ReaderException;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.util.EnumMap;
import java.util.Map;

/** QR decoding of one camera frame's luminance (the Y plane of YUV), through the vendored ZXing
 *  subset (android/third_party/zxing). Plain Java, no Android: QrTest runs it on the JVM. */
final class QrDecode {
    private final QRCodeReader reader = new QRCodeReader();
    private final Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);

    QrDecode() { hints.put(DecodeHintType.CHARACTER_SET, "UTF-8"); }

    /** The text of a QR code in the centred `cw`×`ch` part (clamped to the frame) of a `w`×`h`
     *  luminance plane whose rows are `stride` bytes apart, or null. */
    String decode(byte[] y, int stride, int w, int h, int cw, int ch) {
        cw = Math.max(1, Math.min(cw, w));
        ch = Math.max(1, Math.min(ch, h));
        LuminanceSource src = new PlanarYUVLuminanceSource(y, stride, h, (w - cw) / 2, (h - ch) / 2, cw, ch, false);
        try {
            return reader.decode(new BinaryBitmap(new HybridBinarizer(src)), hints).getText();
        } catch (ReaderException e) {
            return null;
        } finally {
            reader.reset();
        }
    }
}
