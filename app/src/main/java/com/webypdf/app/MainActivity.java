package com.webypdf.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * WebyPDF – hosts the bundled web app (assets/www) in a WebView.
 *
 * - Files are served from the APK through shouldInterceptRequest on a virtual https origin, so ES modules,
 *   Web Workers, WebAssembly and localStorage all work exactly like on the website, fully offline.
 * - "Download" buttons call the native bridge (window.WebyAndroid) which saves into Downloads/WebyPDF.
 * - The system file picker is wired up for the web app's file inputs.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final String DOWNLOAD_SUBDIR = "WebyPDF";
    private static final int REQ_FILE = 1001;
    private static final int REQ_STORAGE = 1002;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF150D3A);
        setContentView(webView);

        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.addJavascriptInterface(new Bridge(), "WebyAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serveAsset(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Only our own virtual origin may load; nothing else is ever opened.
                return !HOST.equals(request.getUrl().getHost());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (Build.VERSION.SDK_INT >= 23 && Build.VERSION.SDK_INT < 29
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
        }

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(START_URL);
        }
    }

    /* ------------------------------------------------------------------ *
     *  Serve bundled files
     * ------------------------------------------------------------------ */
    private WebResourceResponse serveAsset(Uri uri) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        headers.put("Access-Control-Allow-Origin", "*");

        if (!HOST.equals(uri.getHost())) {
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", headers,
                    new ByteArrayInputStream(new byte[0]));
        }
        String path = uri.getPath();
        if (path == null || path.equals("/") || path.isEmpty()) {
            path = "/index.html";
        }
        path = path.substring(1);
        if (path.contains("..")) {
            return notFound(headers);
        }
        try {
            InputStream in = getAssets().open("www/" + path);
            String mime = mimeFor(path);
            boolean text = mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("xml")
                    || mime.endsWith("manifest+json");
            return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", headers, in);
        } catch (IOException e) {
            return notFound(headers);
        }
    }

    private static WebResourceResponse notFound(Map<String, String> headers) {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers,
                new ByteArrayInputStream("Not found".getBytes(StandardCharsets.UTF_8)));
    }

    private static String mimeFor(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    /* ------------------------------------------------------------------ *
     *  Native bridge: save files into Downloads/WebyPDF
     * ------------------------------------------------------------------ */
    private static final class Session {
        OutputStream out;
        Uri uri;      // Android 10+ (MediaStore)
        File file;    // Android 9 and older
        String name;
    }

    private final class Bridge {
        private final Map<String, Session> sessions = new ConcurrentHashMap<>();

        /** Starts a new download. Returns a session id, or "" on failure. */
        @JavascriptInterface
        public String begin(String rawName, String mime) {
            try {
                String name = sanitize(rawName);
                if (mime == null || mime.isEmpty()) {
                    mime = "application/octet-stream";
                }
                Session s = new Session();
                s.name = name;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + DOWNLOAD_SUBDIR);
                    v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    ContentResolver r = getContentResolver();
                    s.uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (s.uri == null) return "";
                    s.out = r.openOutputStream(s.uri);
                    if (s.out == null) return "";
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), DOWNLOAD_SUBDIR);
                    if (!dir.exists() && !dir.mkdirs()) return "";
                    s.file = uniqueFile(dir, name);
                    s.name = s.file.getName();
                    s.out = new FileOutputStream(s.file);
                }
                String id = UUID.randomUUID().toString();
                sessions.put(id, s);
                return id;
            } catch (Exception e) {
                return "";
            }
        }

        /** Appends one base64 chunk. Returns false on failure. */
        @JavascriptInterface
        public boolean chunk(String id, String base64) {
            Session s = sessions.get(id);
            if (s == null) return false;
            try {
                s.out.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                abort(id);
                return false;
            }
        }

        /** Finishes the file. Returns a human-readable location, or "" on failure. */
        @JavascriptInterface
        public String end(String id) {
            Session s = sessions.remove(id);
            if (s == null) return "";
            try {
                s.out.flush();
                s.out.close();
                if (s.uri != null) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    getContentResolver().update(s.uri, v, null, null);
                } else if (s.file != null) {
                    MediaScannerConnection.scanFile(MainActivity.this, new String[]{s.file.getAbsolutePath()}, null, null);
                }
                return "Downloads/" + DOWNLOAD_SUBDIR + "/" + s.name;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void abort(String id) {
            Session s = sessions.remove(id);
            if (s == null) return;
            try {
                if (s.out != null) s.out.close();
            } catch (IOException ignored) {
                // nothing to do
            }
            try {
                if (s.uri != null) getContentResolver().delete(s.uri, null, null);
                if (s.file != null) //noinspection ResultOfMethodCallIgnored
                    s.file.delete();
            } catch (Exception ignored) {
                // nothing to do
            }
        }
    }

    private static String sanitize(String raw) {
        String n = raw == null ? "" : raw.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (n.isEmpty() || n.equals(".") || n.equals("..")) n = "webypdf-file.pdf";
        if (n.length() > 120) {
            int dot = n.lastIndexOf('.');
            String ext = dot > 0 && n.length() - dot <= 8 ? n.substring(dot) : "";
            n = n.substring(0, 120 - ext.length()) + ext;
        }
        return n;
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    /* ------------------------------------------------------------------ *
     *  Activity plumbing
     * ------------------------------------------------------------------ */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("WebyAndroid");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
