// KERF for Android — the same single-file app as the web and desktop builds, in a private WebView.
// Bundled files are served from the APK on a virtual https origin; every other request is refused.
// Saving uses the system "Save to…" picker; opening files uses the system picker. No accounts, no tracking.
// SPDX-License-Identifier: AGPL-3.0-or-later
package ca.akaind.kerf;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST + "/";
    static final int REQ_SAVE = 41, REQ_OPEN = 42;
    static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html"); MIME.put("js", "text/javascript"); MIME.put("mjs", "text/javascript"); MIME.put("css", "text/css");
        MIME.put("json", "application/json"); MIME.put("wasm", "application/wasm"); MIME.put("gz", "application/gzip"); MIME.put("zip", "application/zip");
        MIME.put("ttf", "font/ttf"); MIME.put("txt", "text/plain"); MIME.put("svg", "image/svg+xml"); MIME.put("png", "image/png");
    }

    private WebView web;
    private FrameLayout frame;
    private ValueCallback<Uri[]> fileCallback;
    private byte[] pendingBytes;
    private String pendingName;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        frame = new FrameLayout(this);
        web = new WebView(this);
        frame.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        frame.setBackgroundColor(getColor(R.color.ground));
        web.setBackgroundColor(getColor(R.color.ground));
        setContentView(frame);
        fitSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);            // IndexedDB autosave of the open document
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSafeBrowsingEnabled(false);          // nothing is ever loaded from the web, so nothing to check
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        web.addJavascriptInterface(new Bridge(), "KerfNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost())) return refuse(); // the privacy wall
                String path = u.getPath() == null ? "" : u.getPath().replaceFirst("^/+", "");
                if (path.isEmpty()) path = "index.html";
                if (path.contains("..")) return refuse();
                try {
                    InputStream in = getAssets().open("web/" + path);
                    String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
                    String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
                    WebResourceResponse r = new WebResourceResponse(mime, mime.startsWith("text/") ? "utf-8" : null, in);
                    Map<String, String> h = new HashMap<>(); h.put("Cache-Control", "no-cache"); h.put("Access-Control-Allow-Origin", ORIGIN.substring(0, ORIGIN.length() - 1));
                    r.setResponseHeaders(h);
                    return r;
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
                }
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                openOutside(u); // links (licences, source, AKA IND) open in the person's browser
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*"); // .kerf, .step, .3dm, .dxf have no reliable MIME types; KERF checks the file itself
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try { startActivityForResult(i, REQ_OPEN); } catch (ActivityNotFoundException e) { fileCallback = null; return false; }
                return true;
            }
        });

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, new OnBackInvokedCallback() {
                @Override public void onBackInvoked() { handleBack(); }
            });
        }
        if (state == null || web.restoreState(state) == null) web.loadUrl(ORIGIN + "index.html");
    }

    private static WebResourceResponse refuse() {
        return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    private void openOutside(Uri u) {
        String sch = u.getScheme() == null ? "" : u.getScheme();
        if (!sch.equals("https") && !sch.equals("http") && !sch.equals("mailto")) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
    }

    /** Keep the app clear of the status and navigation bars (edge-to-edge on Android 15+). */
    private void fitSystemBars() {
        frame.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(b.left, b.top, b.right, b.bottom);
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        applyBarAppearance();
    }
    private void applyBarAppearance() {
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(night ? 0 : light, light);
            }
        }
        frame.setBackgroundColor(night ? Color.parseColor("#121212") : Color.parseColor("#F3EEE4"));
    }

    @Override
    public void onConfigurationChanged(Configuration c) { super.onConfigurationChanged(c); applyBarAppearance(); }

    /** Back closes the top dialog in KERF if there is one; otherwise KERF stays in memory and the task goes to the background. */
    private void handleBack() {
        web.evaluateJavascript("(window.__kerfBack ? window.__kerfBack() : false)", (v) -> { if (!"true".equals(v)) moveTaskToBack(true); });
    }
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { handleBack(); }

    @Override
    protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override
    protected void onPause() { super.onPause(); web.onPause(); }
    @Override
    protected void onResume() { super.onResume(); web.onResume(); }
    @Override
    protected void onDestroy() { if (web != null) { web.destroy(); web = null; } super.onDestroy(); }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_OPEN) {
            if (fileCallback == null) return;
            Uri[] out = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) { int n = data.getClipData().getItemCount(); out = new Uri[n]; for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri(); }
                else if (data.getData() != null) out = new Uri[] { data.getData() };
            }
            fileCallback.onReceiveValue(out); fileCallback = null;
        } else if (req == REQ_SAVE) {
            final byte[] bytes = pendingBytes; final String name = pendingName; pendingBytes = null; pendingName = null;
            if (res != RESULT_OK || data == null || data.getData() == null || bytes == null) { notifySaved(false, name); return; }
            final Uri uri = data.getData();
            new Thread(() -> {
                boolean ok = false;
                try (OutputStream os = getContentResolver().openOutputStream(uri, "wt")) { if (os != null) { os.write(bytes); ok = true; } }
                catch (Exception e) { ok = false; }
                final boolean done = ok; main.post(() -> notifySaved(done, name));
            }).start();
        }
    }
    private void notifySaved(boolean ok, String name) {
        if (web == null) return;
        String n = name == null ? "" : name.replace("\\", "\\\\").replace("'", "\\'");
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('kerf-native-saved',{detail:{ok:" + ok + ",name:'" + n + "'}}))", null);
    }

    /** The only things the page can ask of Android. */
    final class Bridge {
        @JavascriptInterface
        public boolean saveFile(String name, String mime, String base64) {
            final byte[] bytes;
            try { bytes = Base64.decode(base64, Base64.DEFAULT); } catch (IllegalArgumentException e) { return false; }
            main.post(() -> {
                pendingBytes = bytes; pendingName = name;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(i, REQ_SAVE); }
                catch (ActivityNotFoundException e) { pendingBytes = null; Toast.makeText(MainActivity.this, "No app can save files here", Toast.LENGTH_LONG).show(); notifySaved(false, name); }
            });
            return true;
        }
        @JavascriptInterface
        public String platform() { return "android " + Build.VERSION.RELEASE + " · API " + Build.VERSION.SDK_INT; }
    }
}
