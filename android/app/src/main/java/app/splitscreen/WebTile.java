package app.splitscreen;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.text.TextUtils;
import android.util.Log;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.Collections;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Web pages, images, YouTube and Vimeo. Shown in a WebView. */
final class WebTile extends Tile {
    private static final Pattern IMAGE = Pattern.compile("\\.(jpe?g|png|gif|webp|avif|svg)(\\?|#|$)", Pattern.CASE_INSENSITIVE);
    private static final Pattern YT = Pattern.compile(
            "(?:youtube(?:-nocookie)?\\.com/(?:watch\\?(?:.*&)?v=|embed/|shorts/|live/|v/)|youtu\\.be/)([A-Za-z0-9_-]{6,})");
    private static final Pattern VIMEO = Pattern.compile("vimeo\\.com/(?:video/)?(\\d{5,})");
    // A named https origin. YouTube refuses to play on pages without one. Nothing is loaded
    // from it. It keeps the old name on purpose: tvwall.app is not registered, while
    // splitscreen.app belongs to someone else and would be sent to YouTube as the site.
    private static final String BASE = "https://tvwall.app/";
    // The player frame's origin. YT_LIMIT_JS only runs in frames from this origin.
    private static final String YT_ORIGIN = "https://www.youtube.com";

    // Runs inside the YouTube player before its own code. YouTube asks the browser which
    // formats it can play; this says no to AV1, VP9 and VP8, to more than 30 fps, and to
    // video taller than the window (1080p at most). YouTube then streams H.264, which
    // every TV decodes in hardware. Several windows at once then play without stutter.
    // Known limits: the height is read when YouTube checks formats, so a window made
    // bigger later keeps its lower quality until it reloads (the reload button). A video
    // with no H.264 version shows YouTube's own error. 60 fps uploads play at 30 fps.
    private static final String YT_LIMIT_JS =
            "(function(){"
            + "var STEPS=[144,240,360,480,720,1080];"
            + "function maxH(){var h=(window.innerHeight||1080)*(window.devicePixelRatio||1);"
            + "for(var i=0;i<STEPS.length;i++)if(STEPS[i]>=h*0.9)return STEPS[i];return 1080;}"
            + "function bad(t,h,f){t=String(t||'').toLowerCase();"
            + "if(/av01|vp0?9|vp8/.test(t))return true;"
            + "var mh=/height=(\\d+)/.exec(t),mf=/framerate=(\\d+)/.exec(t);"
            + "h=h||(mh&&+mh[1]);f=f||(mf&&+mf[1]);"
            + "return (h&&h>maxH())||(f&&f>30);}"
            + "var MS=window.MediaSource;"
            + "if(MS&&MS.isTypeSupported){var o=MS.isTypeSupported.bind(MS);"
            + "MS.isTypeSupported=function(t){return bad(t)?false:o(t);};}"
            + "var cp=HTMLMediaElement.prototype.canPlayType;"
            + "HTMLMediaElement.prototype.canPlayType=function(t){return bad(t)?'':cp.call(this,t);};"
            + "var mc=navigator.mediaCapabilities;"
            + "if(mc&&mc.decodingInfo){var d=mc.decodingInfo.bind(mc);"
            + "mc.decodingInfo=function(c){var v=c&&c.video;"
            + "if(v&&bad(v.contentType,v.height,v.framerate))"
            + "return Promise.resolve({supported:false,smooth:false,powerEfficient:false});"
            + "return d(c);};}"
            + "})();";

    private final WebView web;
    private final boolean player;   // true for YouTube / Vimeo: sound can be controlled
    private final boolean youtube;

    @SuppressLint("SetJavaScriptEnabled")
    WebTile(Context ctx, String id, String key, String url) {
        super(ctx, id, key);
        web = new WebView(ctx);
        web.setBackgroundColor(Color.BLACK);
        web.setFocusable(false);
        web.setFocusableInTouchMode(false);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String u) {
                status = "page loaded";
                if (player) setAudible(audible);   // the page was not ready for earlier calls
            }
            // A click in a YouTube / Vimeo window must not replace the player page: the app
            // would lose mute control (and the YouTube format limit) for that window.
            // Web page windows follow links, but not app links such as intent: or market:,
            // which would only show an error page. Frames inside a page are never blocked:
            // they may load data:, blob: or about: pages as part of the site.
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (!r.isForMainFrame()) return false;
                String scheme = r.getUrl().getScheme();
                if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return true;
                return player;
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) status = "error: " + e.getDescription();
            }
        });
        setContent(web);

        Matcher yt = YT.matcher(url), vm = VIMEO.matcher(url);
        if (yt.find()) {
            youtube = true; player = true;
            boolean limited = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
            if (limited) {
                WebViewCompat.addDocumentStartJavaScript(web, YT_LIMIT_JS, Collections.singleton(YT_ORIGIN));
            } else {
                Log.w("SplitScreen", "WebView too old: YouTube format limit is off, windows may stutter");
            }
            String vid = yt.group(1);
            String q = "autoplay=1&mute=1&playsinline=1&enablejsapi=1&rel=0&controls=0&loop=1&playlist=" + vid
                    + "&origin=" + Uri.encode(BASE.substring(0, BASE.length() - 1));
            frame(YT_ORIGIN + "/embed/" + vid + "?" + q);
        } else if (vm.find()) {
            youtube = false; player = true;
            frame("https://player.vimeo.com/video/" + vm.group(1) + "?autoplay=1&muted=1&loop=1&api=1");
        } else if (IMAGE.matcher(url).find()) {
            youtube = false; player = false;
            web.loadDataWithBaseURL(BASE, "<html><body style='margin:0;background:#000;height:100vh;display:flex'>"
                    + "<img src='" + TextUtils.htmlEncode(url) + "' style='margin:auto;max-width:100%;max-height:100%'"
                    + " onload=\"document.title='ok'\"></body></html>", "text/html", "utf-8", null);
        } else {
            youtube = false; player = false;
            web.loadUrl(url);
        }
    }

    private void frame(String src) {
        // The viewport tag makes 1 CSS pixel = 1 dp. Without it the page is laid out 980 px
        // wide and zoomed out, and YT_LIMIT_JS would see the wrong window height.
        web.loadDataWithBaseURL(BASE, "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
                + "<body style='margin:0;background:#000;overflow:hidden'>"
                + "<iframe id='f' src='" + TextUtils.htmlEncode(src) + "' style='border:0;width:100vw;height:100vh'"
                + " allow='autoplay; encrypted-media; fullscreen'></iframe></body></html>", "text/html", "utf-8", null);
    }

    private boolean audible;

    @Override void setAudible(boolean on) {
        audible = on;
        if (!player) return;
        String msg = youtube
                ? "{\"event\":\"command\",\"func\":\"" + (on ? "unMute" : "mute") + "\",\"args\":[]}"
                : "{\"method\":\"setMuted\",\"value\":" + !on + "}";
        // Send now and again after the player has loaded.
        String js = "(function(){var m=" + JSONQuote(msg) + ";function s(){var f=document.getElementById('f');"
                + "if(f)f.contentWindow.postMessage(m,'*');}s();setTimeout(s,1500);setTimeout(s,4000);})()";
        web.evaluateJavascript(js, null);
    }

    private static String JSONQuote(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }

    @Override void setVisible(boolean visible) {
        if (visible) web.onResume(); else web.onPause();
    }

    @Override void release() {
        web.stopLoading();
        web.loadUrl("about:blank");
        web.destroy();
    }
}
