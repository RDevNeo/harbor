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

    /** The text of a QR code in the centre square of side `side` (clamped to the frame) of a
     *  `w`×`h` luminance plane whose rows are `stride` bytes apart, or null. `inverted` reads
     *  light-on-dark codes. */
    String decode(byte[] y, int stride, int w, int h, int side, boolean inverted) {
        side = Math.max(1, Math.min(side, Math.min(w, h)));
        LuminanceSource src = new PlanarYUVLuminanceSource(y, stride, h, (w - side) / 2, (h - side) / 2,
                side, side, false);
        if (inverted) src = src.invert();
        try {
            return reader.decode(new BinaryBitmap(new HybridBinarizer(src)), hints).getText();
        } catch (ReaderException e) {
            return null;
        } finally {
            reader.reset();
        }
    }
}
