package app.splitscreen;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.util.regex.Pattern;

/** One window on the wall: a frame with content, a number tag and a selection border. */
abstract class Tile {
    static final Pattern HLS = Pattern.compile("\\.m3u8", Pattern.CASE_INSENSITIVE);
    static final Pattern MEDIA = Pattern.compile(
            "\\.(mp4|webm|ogv|mov|m4v|mkv|ts|mp3|m4a|aac|ogg|wav|flac)(\\?|#|$)", Pattern.CASE_INSENSITIVE);

    final String id;
    final String key;          // url + reload counter: a change rebuilds the tile
    final FrameLayout root;
    private final TextView tag;
    volatile String status = "loading";

    Tile(Context ctx, String id, String key) {
        this.id = id;
        this.key = key;
        root = new FrameLayout(ctx);
        root.setBackgroundColor(Color.BLACK);
        root.setFocusable(false);
        tag = new TextView(ctx);
        tag.setTextColor(Color.WHITE);
        tag.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        tag.setPadding(16, 4, 16, 4);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xA6000000);
        bg.setCornerRadius(10);
        tag.setBackground(bg);
        tag.setVisibility(View.GONE);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START);
        lp.setMargins(12, 10, 0, 0);
        root.addView(tag, lp);
    }

    /** Adds the content view under the tag. */
    void setContent(View v) {
        root.addView(v, 0, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    void setLabel(String text, boolean show) {
        tag.setText(text);
        tag.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    void setSelected(boolean on) {
        if (on) {
            GradientDrawable border = new GradientDrawable();
            border.setColor(Color.TRANSPARENT);
            border.setStroke(8, 0xFF4F8CFF);
            root.setForeground(border);
        } else {
            root.setForeground(null);
        }
    }

    /** Sound on or off for this window. Only 1 window is audible at a time. */
    abstract void setAudible(boolean on);

    /** Visible windows play. Hidden ones (behind "Full") pause video to save decoders. */
    abstract void setVisible(boolean visible);

    /** Free the player or web view. */
    abstract void release();

    /** The Close pop-up button on the PC. Only web page windows do anything. */
    void closePopup() {}

    /** The last Close pop-up count seen for this window. -1: none seen yet. */
    int popupSeen = -1;

    /** Picks a tile type for a URL. */
    static Tile create(Context ctx, String id, String key, String url, String serverBase) {
        String full = url.startsWith("/") ? serverBase + url : url;
        boolean hls = HLS.matcher(full).find();
        if (hls || MEDIA.matcher(full).find()) {
            return new StreamTile(ctx, id, key, full, hls, url.startsWith("/"), serverBase);
        }
        return new WebTile(ctx, id, key, full);
    }
}
