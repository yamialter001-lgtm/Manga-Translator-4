package com.personal.mangatranslator;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions;
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * ปลั๊กอินเนทีฟของ Manga Translator
 *  - recognize: OCR ในเครื่องด้วย Google ML Kit (ja / ko / zh / ละติน)
 *  - writeChunk / saveFile: เขียนไฟล์ขนาดใหญ่ทีละส่วน แล้วบันทึกลง Download หรือ Pictures
 */
@CapacitorPlugin(name = "MangaNative")
public class MangaNativePlugin extends Plugin {

    private TextRecognizer recognizerFor(String lang) {
        if ("ja".equals(lang)) {
            return TextRecognition.getClient(new JapaneseTextRecognizerOptions.Builder().build());
        }
        if ("ko".equals(lang)) {
            return TextRecognition.getClient(new KoreanTextRecognizerOptions.Builder().build());
        }
        if ("zh-TW".equals(lang) || "zh-CN".equals(lang) || "zh".equals(lang)) {
            return TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        }
        return TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    }

    @PluginMethod
    public void recognize(final PluginCall call) {
        String b64 = call.getString("image");
        String lang = call.getString("lang", "ja");
        if (b64 == null || b64.isEmpty()) {
            call.reject("ไม่มีข้อมูลภาพ");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(b64, Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("base64 ไม่ถูกต้อง");
            return;
        }
        final Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (bmp == null) {
            call.reject("ถอดรหัสภาพไม่สำเร็จ");
            return;
        }
        final TextRecognizer recognizer = recognizerFor(lang);
        InputImage image = InputImage.fromBitmap(bmp, 0);
        recognizer
            .process(image)
            .addOnSuccessListener(text -> {
                JSArray blocks = new JSArray();
                for (Text.TextBlock b : text.getTextBlocks()) {
                    Rect r = b.getBoundingBox();
                    if (r == null) continue;
                    JSObject o = new JSObject();
                    o.put("text", b.getText());
                    JSArray box = new JSArray();
                    box.put(r.left);
                    box.put(r.top);
                    box.put(r.right);
                    box.put(r.bottom);
                    o.put("box", box);
                    blocks.put(o);
                }
                JSObject res = new JSObject();
                res.put("width", bmp.getWidth());
                res.put("height", bmp.getHeight());
                res.put("blocks", blocks);
                recognizer.close();
                bmp.recycle();
                call.resolve(res);
            })
            .addOnFailureListener(e -> {
                recognizer.close();
                bmp.recycle();
                call.reject("OCR ล้มเหลว: " + e.getMessage());
            });
    }

    private File exportDir() {
        File dir = new File(getContext().getCacheDir(), "export");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    @PluginMethod
    public void writeChunk(PluginCall call) {
        try {
            String name = new File(call.getString("name", "out.bin")).getName();
            String data = call.getString("data", "");
            Boolean append = call.getBoolean("append", true);
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            File f = new File(exportDir(), name);
            try (FileOutputStream os = new FileOutputStream(f, Boolean.TRUE.equals(append))) {
                os.write(bytes);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("เขียนไฟล์ไม่สำเร็จ: " + e.getMessage());
        }
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        try {
            String name = new File(call.getString("name", "out.bin")).getName();
            String mime = call.getString("mime", "application/octet-stream");
            File src = new File(exportDir(), name);
            if (!src.exists()) {
                call.reject("ไม่พบไฟล์ชั่วคราว");
                return;
            }
            String saved;
            if (Build.VERSION.SDK_INT >= 29) {
                boolean image = mime.startsWith("image/");
                String rel = (image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS) + "/MangaTranslator";
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
                Uri collection = image
                    ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    : MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                ContentResolver cr = getContext().getContentResolver();
                Uri uri = cr.insert(collection, v);
                if (uri == null) throw new IOException("สร้างไฟล์ใน MediaStore ไม่ได้");
                try (OutputStream os = cr.openOutputStream(uri); InputStream is = new FileInputStream(src)) {
                    if (os == null) throw new IOException("เปิดไฟล์ปลายทางไม่ได้");
                    copy(is, os);
                }
                saved = rel + "/" + name;
            } else {
                File dir = new File(getContext().getExternalFilesDir(null), "exports");
                if (!dir.exists()) dir.mkdirs();
                File dst = new File(dir, name);
                try (OutputStream os = new FileOutputStream(dst); InputStream is = new FileInputStream(src)) {
                    copy(is, os);
                }
                saved = dst.getAbsolutePath();
            }
            src.delete();
            JSObject res = new JSObject();
            res.put("location", saved);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("บันทึกไฟล์ไม่สำเร็จ: " + e.getMessage());
        }
    }

    private static void copy(InputStream is, OutputStream os) throws IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
        os.flush();
    }
}
