package app.splitscreen;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;

/**
 * Plays a live stream or video file with ExoPlayer and keeps it playing.
 * - Not played yet and it fails: switch between direct and the PC relay (/relay).
 * - Drops or freezes later: reconnect after 3 s, then up to every 30 s.
 */
@UnstableApi
final class StreamTile extends Tile {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final String url;
    private final boolean hls;
    private final boolean local;
    private final String serverBase;
    private final ExoPlayer player;

    private boolean viaPc, locked, everPlayed, released, visible = true, audible;
    private int fails;
    private long lastPos = -1;
    private int stillSeconds;

    StreamTile(Context ctx, String id, String key, String url, boolean hls, boolean local, String serverBase) {
        super(ctx, id, key);
        this.url = url;
        this.hls = hls;
        this.local = local;
        this.serverBase = serverBase;

        // Live walls need little buffer; this also saves memory with many windows.
        DefaultLoadControl load = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(4000, 20000, 1500, 2500)
                .build();
        player = new ExoPlayer.Builder(ctx).setLoadControl(load).build();
        player.setVolume(0f);
        player.setRepeatMode(hls ? Player.REPEAT_MODE_OFF : Player.REPEAT_MODE_ONE);
        player.setVideoScalingMode(C.VIDEO_SCALING_MODE_SCALE_TO_FIT);

        PlayerView view = (PlayerView) LayoutInflater.from(ctx).inflate(R.layout.tile_player, root, false);
        view.setPlayer(player);
        setContent(view);

        player.addListener(new Player.Listener() {
            @Override public void onIsPlayingChanged(boolean playing) {
                if (playing) {
                    fails = 0;
                    everPlayed = true;
                    if (!StreamTile.this.local) locked = true;
                    status = "playing" + mode();
                }
            }
            @Override public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_BUFFERING && everPlayed) status = "buffering" + mode();
                if (state == Player.STATE_ENDED && StreamTile.this.hls) retry("stream ended");
            }
            @Override public void onPlayerError(PlaybackException e) {
                if (e.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                    // Fell behind the live edge: jump back to live.
                    player.seekToDefaultPosition();
                    player.prepare();
                    return;
                }
                retry(reason(e));
            }
        });

        play();
        main.postDelayed(watchdog, 5000);
    }

    private String mode() { return viaPc ? " (via PC)" : ""; }

    private static String reason(PlaybackException e) {
        switch (e.errorCode) {
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED:
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT:
                return "offline";
            case PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS:
                return "blocked or not found";
            case PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED:
            case PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED:
                return "bad stream";
            case PlaybackException.ERROR_CODE_DECODER_INIT_FAILED:
            case PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED:
                return "no free video decoder";
            default:
                return "error " + e.getErrorCodeName().replace("ERROR_CODE_", "").toLowerCase();
        }
    }

    private void play() {
        if (released) return;
        status = "connecting" + mode();
        String src = viaPc ? serverBase + "/relay?u=" + Uri.encode(url) : url;
        MediaItem.Builder item = new MediaItem.Builder().setUri(src);
        if (hls) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        if (hls) item.setLiveConfiguration(new MediaItem.LiveConfiguration.Builder().setMaxPlaybackSpeed(1.04f).build());
        player.setMediaItem(item.build());
        player.prepare();
        player.setPlayWhenReady(visible);
    }

    private final Runnable replay = this::play;

    private void retry(String why) {
        if (released) return;
        main.removeCallbacks(replay);
        fails++;
        if (!locked && !local && fails <= 2) {
            viaPc = !viaPc;
            status = why + ", trying" + (viaPc ? " via PC" : " direct");
            main.postDelayed(replay, 300);
            return;
        }
        int wait = Math.min(30, 3 * fails);
        status = why + mode() + ", retry in " + wait + " s";
        main.postDelayed(replay, wait * 1000L);
    }

    // If the picture freezes for 20 s while it should play, reconnect.
    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            if (released) return;
            int st = player.getPlaybackState();
            boolean shouldPlay = visible && player.getPlayWhenReady() && (st == Player.STATE_READY || st == Player.STATE_BUFFERING);
            long pos = player.getCurrentPosition();
            if (shouldPlay && pos == lastPos) {
                stillSeconds += 5;
                if (stillSeconds >= 20) { stillSeconds = 0; retry("frozen"); }
            } else {
                stillSeconds = 0;
            }
            lastPos = pos;
            main.postDelayed(this, 5000);
        }
    };

    @Override void setAudible(boolean on) {
        audible = on;
        player.setVolume(on && visible ? 1f : 0f);
    }

    @Override void setVisible(boolean v) {
        if (visible == v) return;
        visible = v;
        player.setPlayWhenReady(v);
        player.setVolume(audible && v ? 1f : 0f);
        if (v && player.isCurrentMediaItemLive()) player.seekToDefaultPosition();   // back to live after being hidden
    }

    @Override void release() {
        released = true;
        main.removeCallbacksAndMessages(null);
        player.release();
    }
}
