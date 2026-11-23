// A QR code as a PNG (or an SVG, when the output ends in .svg), with the zxing library the display already uses (scripts/provision-qr.sh).
import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;
import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

public class Qr {
    public static void main(String[] a) throws Exception {
        String text = Files.readString(Path.of(a[0]));
        var m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, Map.of(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M, EncodeHintType.MARGIN, 4));
        int s = 8, w = m.getWidth(), h = m.getHeight();
        if (a[1].endsWith(".svg")) { // one path of unit squares, crisp at any size
            var d = new StringBuilder();
            for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) if (m.get(x, y)) d.append("M").append(x).append(' ').append(y).append("h1v1h-1z");
            Files.writeString(Path.of(a[1]), "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " + w + " " + h + "\" shape-rendering=\"crispEdges\" role=\"img\" aria-label=\"Setup code\"><rect width=\"100%\" height=\"100%\" fill=\"#fff\"/><path fill=\"#000\" d=\"" + d + "\"/></svg>\n");
            return;
        }
        var img = new BufferedImage(w * s, h * s, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h * s; y++) for (int x = 0; x < w * s; x++) img.setRGB(x, y, m.get(x / s, y / s) ? 0 : 0xffffff);
        javax.imageio.ImageIO.write(img, "png", new File(a[1]));
    }
}
