package app.splitscreen;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
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

    // Cookie and consent boxes of the common providers. Hidden in web page windows, in every
    // frame, so the page shows without them. Nothing is accepted or refused: the box only goes.
    private static final String CONSENT = "#onetrust-consent-sdk,#onetrust-banner-sdk,.onetrust-pc-dark-filter,"
            + "#CybotCookiebotDialog,#CybotCookiebotDialogBodyUnderlay,#usercentrics-root,#usercentrics-cmp-ui,"
            + "#didomi-host,.didomi-popup-backdrop,#qc-cmp2-container,.qc-cmp2-container,"
            + "#truste-consent-track,.truste_overlay,.truste_box_overlay,[id^=sp_message_container_],"
            + ".fc-consent-root,#cmpbox,#cmpbox2,.cmpboxBG,#iubenda-cs-banner,#cookie-law-info-bar,"
            + ".cky-consent-container,.cky-overlay,.cc-window,.cc-banner,#cookiescript_injected,"
            + "#moove_gdpr_cookie_info_bar,.osano-cm-window,#consent_blackbar,#_evidon_banner,.evidon-banner,"
            + "#gdpr-consent-tool-wrapper,#cmp-app-container,#BorlabsCookieBox,#cookie-notice,#cookieChoiceInfo";

    // Turns up-and-down scrolling back on, only where a page turned it off. The window scrolls
    // (html); the body gets "visible" (the browser makes that "auto" when the site hides
    // side-to-side scrolling). Side-to-side stays as the site set it, so menus kept off-screen
    // do not widen the page.
    private static final String UNLOCK =
            "[[document.documentElement,'auto'],[document.body,'visible']].forEach(function(p){"
            + "if(p[0]&&getComputedStyle(p[0]).overflowY==='hidden')p[0].style.setProperty('overflow-y',p[1],'important');});";

    // Runs in every frame of a web page window before the page's own code. It hides CONSENT.
    // While such a box is on the page (checked for 30 s), scrolling stays on: these boxes
    // often turn it off until you answer.
    private static final String CLEAN_JS =
            "(function(){if(window.__ssClean)return;window.__ssClean=1;"
            + "var SEL=" + JSONQuote(CONSENT) + ";"
            + "var st=document.createElement('style');"
            + "st.textContent=SEL+'{display:none!important;visibility:hidden!important}';"
            + "(document.head||document.documentElement).appendChild(st);"
            + "var n=0,t=setInterval(function(){if(++n>30)clearInterval(t);"
            + "if(!document.body||!document.querySelector(SEL))return;"
            + UNLOCK + "},1000);"
            + "})();";

    // Players and anything that plays or draws. Close pop-up never removes a box that is or
    // holds one: a floating video in a frame, a radio bar, a map.
    private static final String KEEP = "video,audio,canvas,embed,object,iframe[allowfullscreen],"
            + "iframe[allow*=fullscreen],iframe[allow*=autoplay],[class*=player],[id*=player]";

    // The Close pop-up button on the PC control page. Removes what covers the page: fixed boxes
    // of some size that hold no player (KEEP), and their dark backgrounds. It keeps a bar along
    // the top edge (often the site's own menu) and a box that holds most of the page (a page
    // built inside 1 full-screen box). Scrolling is turned back on.
    private static final String CLOSE_POPUP_JS =
            "(function(){var vw=innerWidth,vh=innerHeight,gone=0,KEEP=" + JSONQuote(KEEP) + ";"
            + "var all=document.querySelectorAll('body *'),half=all.length/2;"
            + "for(var i=0;i<all.length;i++){var e=all[i];if(!e.isConnected)continue;"
            + "var cs=getComputedStyle(e);if(cs.position!=='fixed'||cs.display==='none')continue;"
            + "if(e.matches(KEEP)||e.querySelector(KEEP)||e.shadowRoot)continue;"
            + "if(e.getElementsByTagName('*').length>half)continue;"
            + "var r=e.getBoundingClientRect();"
            + "var w=Math.max(0,Math.min(r.right,vw)-Math.max(r.left,0)),h=Math.max(0,Math.min(r.bottom,vh)-Math.max(r.top,0));"
            + "if(w*h<vw*vh*0.03)continue;"
            + "if(r.top<=0&&(r.height<vh*0.15||r.height<=80))continue;"
            + "e.remove();gone++;}"
            + "if(gone){" + UNLOCK + "}"
            + "return gone;})()";

    // Video full screen. The marked video (or player frame) covers the whole window; its parents
    // lose what would trap it in a smaller box (transforms, clipping, a low stacking order).
    private static final String FILL_CSS =
            "[data-ss-fill]{position:fixed!important;left:0!important;top:0!important;right:auto!important;bottom:auto!important;"
            + "width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;"
            + "min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;"
            + "transform:none!important;z-index:2147483647!important;object-fit:contain!important;background:#000!important;"
            + "visibility:visible!important;opacity:1!important;display:block!important}"
            + "[data-ss-fillp]{transform:none!important;filter:none!important;backdrop-filter:none!important;perspective:none!important;"
            + "contain:none!important;will-change:auto!important;clip-path:none!important;overflow:visible!important;"
            + "z-index:2147483647!important;opacity:1!important;visibility:visible!important}"
            + "html,body{overflow:hidden!important}";

    // Hosts of video players that sites put in a frame, and their own subdomains.
    private static final String PLAYER_HOSTS = "youtube.com youtube-nocookie.com vimeo.com dailymotion.com"
            + " twitch.tv jwplayer.com jwplatform.com jwpcdn.com brightcove.net brightcove.com wistia.com wistia.net"
            + " streamable.com rumble.com kick.com vk.com ok.ru bilibili.com";

    // Picks the video. Sizes are parts of the window (so they compare the same before and after
    // the window grows), for the marked one as it was before it was filled. Only what the page
    // shows counts (not hidden, not see-through).
    // 1. The biggest playing video at least half as big as the biggest video, else the biggest
    //    video. A small looping ad or logo does not win over the main player.
    // 2. The marked video stays unless another one plays: then that one takes over if it is at
    //    least 2 times as big (the marked one plays) or half as big (the marked one is paused).
    // 3. Frames: only video-shaped ones (width 1.2 to 2.5 times the height: not banner or
    //    half-page ads, not side bars). A player from another site, 300 x 150 or bigger (from a
    //    player host, PLAYER_HOSTS, or a host named player., embed., video. ...). Only the host
    //    counts, not the rest of the address (ad addresses carry the page's address). With no
    //    video of a tenth of the window or more: else a frame of a quarter of the window or more.
    // A marked element the page hides (inside a box set to display:none) counts as gone.
    // 4. A video wins over the frame only if it is at least half as big (a small looping video or
    //    an ad player in the page does not replace a big player frame). A frame 2 times as big
    //    takes over from the marked video or frame (a player that loads late).
    // Looks again every second, as players load their video late, swap it, or move it.
    // Off: everything is put back.
    private static String fillJs(boolean on) {
        return "(function(on){clearInterval(window.__ssFillT);"
                + "function clear(){var s=document.getElementById('__ssFill');if(s)s.remove();"
                + "document.querySelectorAll('[data-ss-fill],[data-ss-fillp]').forEach(function(e){"
                + "e.removeAttribute('data-ss-fill');e.removeAttribute('data-ss-fillp');});}"
                + "if(!on){clear();window.__ssFillE=null;return;}"
                + "function vp(){return innerWidth*innerHeight||1;}"
                + "function area(e){var r=e.getBoundingClientRect();return r.width*r.height/vp();}"
                + "function size(e){return e&&e===window.__ssFillE&&e.hasAttribute('data-ss-fill')?window.__ssFillA||0:e?area(e):0;}"
                + "function shown(e){if(e===window.__ssFillE&&e.getClientRects().length)return true;var c=getComputedStyle(e);"
                + "return c.display!=='none'&&c.visibility!=='hidden'&&+c.opacity>0&&area(e)>0;}"
                + "function big(list,ok){var b=null,bs=0;for(var i=0;i<list.length;i++){var e=list[i],a=size(e);"
                + "if(a>bs&&shown(e)&&ok(e)){bs=a;b=e;}}return b;}"
                + "function plays(e){return !e.paused&&!e.ended;}"
                + "function any(){return true;}"
                + "function playerHost(e){var s=e.getAttribute('src')||'',h='';"
                + "if(!s||/^(about|javascript|data|blob):/i.test(s))return false;"
                + "try{h=new URL(s,location.href).hostname;}catch(x){}"
                + "if(!h||h===location.hostname)return false;"
                + "return " + JSONQuote(PLAYER_HOSTS) + ".split(' ').some(function(p){return h===p||h.slice(-p.length-1)==='.'+p;})"
                + "||/^(player|players|embed|video|videos)\\./.test(h);}"
                + "function wide(e){if(e===window.__ssFillE)return true;var r=e.getBoundingClientRect(),q=r.width/(r.height||1);return q>=1.2&&q<=2.5;}"
                + "function frame(hasVideo){var f=document.querySelectorAll('iframe');"
                + "return big(f,function(e){return wide(e)&&playerHost(e)&&size(e)*vp()>=300*150;})"
                + "||(hasVideo?null:big(f,function(e){return wide(e)&&size(e)>=0.25;}));}"
                + "function pick(){var cur=window.__ssFillE,v=document.querySelectorAll('video');"
                + "var top=big(v,any),playing=big(v,function(e){return plays(e)&&size(e)>=size(top)*0.5;}),video=playing||top;"
                + "var f=frame(!!video&&size(video)>=0.1);"
                + "if(cur&&cur.isConnected&&cur.getClientRects().length){"
                + "if(cur.tagName==='VIDEO'){if(f&&size(f)>=size(cur)*2)return f;"
                + "if(!playing||playing===cur)return cur;"
                + "if(size(playing)<size(cur)*(plays(cur)?2:0.5))return cur;return playing;}"
                + "if(video&&size(video)>=size(cur)*0.5)return video;"
                + "return f&&f!==cur&&size(f)>=size(cur)*2?f:cur;}"
                + "if(video&&(!f||size(video)>=size(f)*0.5))return video;"
                + "return f;}"
                + "function apply(){var e=pick();"
                + "if(!e){var c=window.__ssFillE;if(c&&(!c.isConnected||!c.getClientRects().length)){clear();window.__ssFillE=null;}return;}"
                + "var p=e.parentElement;"
                + "if(e===window.__ssFillE&&e.hasAttribute('data-ss-fill')&&document.getElementById('__ssFill')"
                + "&&(!p||p===document.documentElement||p.hasAttribute('data-ss-fillp')))return;"
                + "var a=size(e);clear();window.__ssFillE=e;window.__ssFillA=a;"
                + "var st=document.createElement('style');st.id='__ssFill';st.textContent=" + JSONQuote(FILL_CSS) + ";"
                + "(document.head||document.documentElement).appendChild(st);e.setAttribute('data-ss-fill','');"
                + "for(var p=e.parentElement;p&&p!==document.documentElement;p=p.parentElement)p.setAttribute('data-ss-fillp','');}"
                + "apply();window.__ssFillT=setInterval(apply,1000);})(" + on + ")";
    }

    private final WebView web;
    private final boolean player;   // true for YouTube / Vimeo: sound can be controlled
    private final boolean page;     // true for a web page (not a player or an image)
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
        // A page may not open new windows or tabs. With multiple windows on, window.open asks
        // onCreateWindow (which says no) instead of loading over the page in this window.
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        web.setWebChromeClient(new WebChromeClient() {
            // A link the viewer clicked that would open a new tab (target=_blank) opens in this
            // window instead. Only a real link: for a link around an image the address comes
            // from requestFocusNodeHref (the hit test would give the image's own address).
            // Anything else that tries to open a window (a button, a script, an ad) is refused.
            @Override public boolean onCreateWindow(WebView v, boolean dialog, boolean user, android.os.Message m) {
                if (!user || !page) return false;
                WebView.HitTestResult hit = v.getHitTestResult();
                int type = hit == null ? WebView.HitTestResult.UNKNOWN_TYPE : hit.getType();
                if (type == WebView.HitTestResult.SRC_ANCHOR_TYPE) {
                    openHere(hit.getExtra());
                } else if (type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) {
                    v.requestFocusNodeHref(new Handler(Looper.getMainLooper(), msg -> {
                        openHere(msg.getData().getString("url"));
                        return true;
                    }).obtainMessage());
                }
                return false;
            }
            // Alert, confirm and prompt boxes would cover the whole TV and wait for a press.
            // They are answered at once: OK for an alert, Cancel for the others.
            @Override public boolean onJsAlert(WebView v, String u, String msg, android.webkit.JsResult r) {
                r.confirm(); return true;
            }
            @Override public boolean onJsConfirm(WebView v, String u, String msg, android.webkit.JsResult r) {
                r.cancel(); return true;
            }
            @Override public boolean onJsPrompt(WebView v, String u, String msg, String def, android.webkit.JsPromptResult r) {
                r.cancel(); return true;
            }
            @Override public boolean onJsBeforeUnload(WebView v, String u, String msg, android.webkit.JsResult r) {
                r.confirm(); return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String u) {
                status = "page loaded";
                if (player) setAudible(audible);   // the page was not ready for earlier calls
                if (page && fill) web.evaluateJavascript(fillJs(true), null);   // a new page in the window
            }
            // A click in a YouTube / Vimeo window must not replace the player page: the app
            // would lose mute control (and the YouTube format limit) for that window.
            // Web page windows follow links, but not app links such as intent: or market:,
            // which would only show an error page. Frames inside a page are never blocked:
            // they may load data:, blob: or about: pages as part of the site.
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (!r.isForMainFrame()) return false;
                if (!isWebUrl(r.getUrl().toString())) return true;
                return player;
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) status = "error: " + e.getDescription();
            }
        });
        setContent(web);

        Matcher yt = YT.matcher(url), vm = VIMEO.matcher(url);
        boolean isPage = false;
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
            youtube = false; player = false; isPage = true;
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(web, CLEAN_JS, Collections.singleton("*"));
            } else {
                Log.w("SplitScreen", "WebView too old: cookie boxes are not hidden");
            }
            web.loadUrl(url);
        }
        page = isPage;
    }

    /** Only http and https pages load in a window: not intent:, market:, file: or javascript:. */
    private static boolean isWebUrl(String u) {
        return u != null && u.matches("(?i)https?://.*");
    }

    /** Opens a clicked new-tab link in this window (web pages only). */
    private void openHere(String link) {
        if (page && isWebUrl(link)) web.loadUrl(link);
    }

    @Override void closePopup() {
        if (!page) return;
        web.evaluateJavascript(CLOSE_POPUP_JS, null);
    }

    private boolean fill;

    @Override void setFill(boolean on) {
        if (!page || on == fill) return;
        fill = on;
        web.evaluateJavascript(fillJs(on), null);
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
