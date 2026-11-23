package app.splitscreen;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.util.UnstableApi;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Full-screen wall of windows. Gets the window list from the PC server and
 * follows every change. Remote: arrows select, OK = sound / full, MENU = PC address,
 * PLAY/PAUSE = cursor mode (see Cursor).
 */
@UnstableApi
public class MainActivity extends Activity {
    private static final String PREFS = "splitscreen";
    private static final String KEY_SERVER = "server";
    private static final int GAP_PX = 4;

    private final Handler main = new Handler(Looper.getMainLooper());
    private FrameLayout wall;
    private TextView message;

    private volatile boolean running;
    private volatile String server;            // "ip:port"
    private Thread worker;
    private WifiManager.MulticastLock multicastLock;

    private JSONObject state;
    private int version;
    private final Map<String, Tile> tiles = new HashMap<>();
    private final List<String> order = new ArrayList<>();   // visible ids, screen order
    private int cols = 1;

    // Choices made with the remote. A change on the PC clears them.
    private String localAudio, localSolo;
    private boolean hasLocalAudio, hasLocalSolo;
    private int selected = -1;
    private long lastBack;
    private Cursor cursor;
    private boolean swallowBack;   // true from a BACK that turned the cursor off until its key-up

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        wall = new FrameLayout(this);
        root.addView(wall, new FrameLayout.LayoutParams(-1, -1));
        message = new TextView(this);
        message.setTextColor(0xFFE8EAF0);
        message.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        message.setGravity(Gravity.CENTER);
        message.setPadding(60, 60, 60, 60);
        root.addView(message, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        cursor = new Cursor(root, wall);
        wall.addOnLayoutChangeListener((v, l, t, r, bt, ol, ot, or, ob) -> {
            if (r - l != or - ol || bt - t != ob - ot) render();
        });
        server = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, null);
        // For testing and scripts: adb shell am start -n app.splitscreen/.MainActivity -e server 192.168.1.50:8090
        String forced = getIntent().getStringExtra("server");
        if (forced != null && !forced.isEmpty()) server = forced;
    }

    @Override protected void onStart() {
        super.onStart();
        hideSystemBars();
        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi != null) {
            multicastLock = wifi.createMulticastLock("splitscreen");
            multicastLock.acquire();
        }
        running = true;
        worker = new Thread(this::syncLoop, "splitscreen-sync");
        worker.start();
        main.postDelayed(reporter, 5000);
    }

    @Override protected void onStop() {
        super.onStop();
        // Leaving the app stops all video, so the TV does not play in the background.
        running = false;
        cursor.setOn(false);
        if (worker != null) worker.interrupt();
        main.removeCallbacks(reporter);
        for (Tile t : tiles.values()) { wall.removeView(t.root); t.release(); }
        tiles.clear();
        version = 0;
        state = null;
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
    }

    @Override public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) hideSystemBars();
        else cursor.releaseKeys();   // a key-up may never arrive: stop cursor movement
        swallowBack = false;
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    // ---------- connection ----------

    // Shown after Split Screen was stopped on the PC (Quit in the tray, Stop Split Screen). It stays
    // until the PC sends the window list again, instead of "Reconnecting" messages.
    private static final String STOPPED_TEXT = "Split Screen was stopped on the PC.\n\n"
            + "Start SplitScreen.exe on the PC to show the windows again.\n\n"
            + "If the PC has a new address, press MENU (≡) to type it.";
    private boolean stoppedByPc;   // read and written on the main thread only

    private void say(String text) {
        main.post(() -> {
            String t = stoppedByPc ? STOPPED_TEXT : text;
            message.setText(t);
            message.setVisibility(t == null ? View.GONE : View.VISIBLE);
        });
    }

    private void syncLoop() {
        int failures = 0;
        while (running) {
            // 1. Find the PC: saved address first, then a network search.
            if (server == null || failures >= 3) {
                if (server != null && Server.ping(server)) {
                    failures = 0;
                } else {
                    say("Split Screen\n\nSearching for the PC…");
                    String found = Server.discover(4000);
                    if (found == null) {
                        say("Split Screen\n\nPC not found.\n\n1. On the PC, start SplitScreen.exe.\n"
                                + "2. Check that the TV and PC are on the same network.\n\n"
                                + "Press MENU (≡) to type the PC address.");
                        sleep(5000);
                        continue;
                    }
                    server = found;
                    failures = 0;
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, found).apply();
                }
            }
            // 2. Long poll: the server answers at once on a change, else after 25 s.
            try {
                String body = Server.get("http://" + server + "/api/state?tv=1&v=" + version, 35000);
                JSONObject next = new JSONObject(body);
                failures = 0;
                if (next.optInt("version") != version) {
                    main.post(() -> apply(next));
                } else {
                    main.post(this::showIdleIfEmpty);
                }
            } catch (Exception e) {
                if (!running) break;
                failures++;
                if (failures == 1) say(null);
                if (failures >= 2) say("Reconnecting to the PC…");
                sleep(2000);
            }
        }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }

    private void showIdleIfEmpty() {
        if (stoppedByPc) {
            message.setText(STOPPED_TEXT);
            message.setVisibility(View.VISIBLE);
            return;
        }
        boolean empty = state == null || state.optJSONArray("windows") == null || state.optJSONArray("windows").length() == 0;
        message.setText(empty ? "Split Screen\n\nConnected to the PC.\nAdd stream links on the control page." : null);
        message.setVisibility(empty ? View.VISIBLE : View.GONE);
    }

    private void apply(JSONObject next) {
        if (!running) return;
        // "stopped": the PC is shutting Split Screen down. Its window list is empty, so render()
        // releases every window (video stops). The next real list clears the flag.
        stoppedByPc = next.optBoolean("stopped", false);
        String oldAudio = state == null ? null : nullable(state, "audio");
        String oldSolo = state == null ? null : nullable(state, "solo");
        state = next;
        version = next.optInt("version");
        if (!eq(oldAudio, nullable(next, "audio"))) hasLocalAudio = false;
        if (!eq(oldSolo, nullable(next, "solo"))) hasLocalSolo = false;
        render();
    }

    private static String nullable(JSONObject o, String k) {
        return o.isNull(k) ? null : o.optString(k, null);
    }

    private static boolean eq(String a, String b) { return a == null ? b == null : a.equals(b); }

    private String audio() { return hasLocalAudio ? localAudio : (state == null ? null : nullable(state, "audio")); }

    private String solo() { return hasLocalSolo ? localSolo : (state == null ? null : nullable(state, "solo")); }

    // ---------- layout ----------

    private void render() {
        if (state == null || !running) return;
        showIdleIfEmpty();
        JSONArray wins = state.optJSONArray("windows");
        if (wins == null) wins = new JSONArray();
        String base = "http://" + server;

        // Remove windows that are gone or whose URL / reload counter changed.
        Set<String> keep = new HashSet<>();
        Map<String, String> keys = new HashMap<>();
        for (int i = 0; i < wins.length(); i++) {
            JSONObject w = wins.optJSONObject(i);
            keys.put(w.optString("id"), w.optString("url") + "#" + w.optInt("nonce"));
        }
        for (Map.Entry<String, Tile> e : new ArrayList<>(tiles.entrySet())) {
            String k = keys.get(e.getKey());
            if (k == null || !k.equals(e.getValue().key)) {
                wall.removeView(e.getValue().root);
                e.getValue().release();
                tiles.remove(e.getKey());
            } else {
                keep.add(e.getKey());
            }
        }

        String solo = solo(), audio = audio();
        String layout = state.optString("layout", "auto");
        boolean free = "free".equals(layout) && solo == null;
        List<JSONObject> shown = new ArrayList<>();
        for (int i = 0; i < wins.length(); i++) {
            JSONObject w = wins.optJSONObject(i);
            if (solo == null || solo.equals(w.optString("id"))) shown.add(w);
        }
        Layouts.Result pl = Layouts.place(shown.size(), solo != null ? "1x1" : layout);
        cols = free ? 1 : pl.cols;
        order.clear();

        int W = wall.getWidth(), H = wall.getHeight();
        if (W == 0 || H == 0) return;   // not laid out yet: render() runs again on layout
        boolean gaps = shown.size() > 1;

        for (int i = 0; i < wins.length(); i++) {
            JSONObject w = wins.optJSONObject(i);
            String id = w.optString("id");
            Tile t = tiles.get(id);
            if (t == null) {
                t = Tile.create(this, id, keys.get(id), w.optString("url"), base);
                tiles.put(id, t);
                wall.addView(t.root, new FrameLayout.LayoutParams(1, 1));
            }
            int idx = shown.indexOf(w);
            float x, y, fw, fh;
            boolean visible, small = false;
            int z = 0;
            if (idx >= 0 && free) {
                JSONObject r = w.optJSONObject("rect");
                x = r == null ? 0 : (float) r.optDouble("x"); y = r == null ? 0 : (float) r.optDouble("y");
                fw = r == null ? 1 : (float) r.optDouble("w"); fh = r == null ? 1 : (float) r.optDouble("h");
                z = w.optInt("z", 0);
                visible = true;
            } else if (idx >= 0 && pl.cells[idx] != null) {
                Layouts.Cell c = pl.cells[idx];
                x = c.x; y = c.y; fw = c.w; fh = c.h; small = c.small;
                z = small ? 10 : 0;
                visible = true;
            } else {
                x = y = 0; fw = fh = 0; visible = false;
            }
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) t.root.getLayoutParams();
            int g = gaps && !free ? GAP_PX / 2 : 0;
            lp.leftMargin = Math.round(x * W) + g;
            lp.topMargin = Math.round(y * H) + g;
            lp.width = Math.max(1, Math.round(fw * W) - 2 * g);
            lp.height = Math.max(1, Math.round(fh * H) - 2 * g);
            t.root.setLayoutParams(lp);
            t.root.setVisibility(visible ? View.VISIBLE : View.GONE);
            t.root.setZ(z);
            t.setVisible(visible);
            boolean aud = id.equals(audio);
            t.setAudible(aud && visible);
            t.setLabel((i + 1) + (aud ? "  🔊" : ""), selected >= 0);
            if (visible) order.add(id);
        }
        if (selected >= order.size()) selected = order.isEmpty() ? -1 : order.size() - 1;
        markSelected();
    }

    private void markSelected() {
        for (Tile t : tiles.values()) {
            t.setSelected(selected >= 0 && selected < order.size() && order.get(selected).equals(t.id));
        }
    }

    // ---------- status report to the PC ----------

    private final Runnable reporter = new Runnable() {
        @Override public void run() {
            if (!running) return;
            final String s = server;
            if (s != null) {
                JSONObject st = new JSONObject();
                try {
                    for (Tile t : tiles.values()) st.put(t.id, t.status);
                    final String body = new JSONObject().put("statuses", st).toString();
                    new Thread(() -> {
                        try { Server.postJson("http://" + s + "/api/report", body); } catch (Exception ignored) { }
                    }).start();
                } catch (Exception ignored) { }
            }
            main.postDelayed(this, 5000);
        }
    };

    // ---------- remote control ----------

    private final Runnable clearSelection = () -> { selected = -1; render(); };

    private void select(int i) {
        if (order.isEmpty()) return;
        selected = ((i % order.size()) + order.size()) % order.size();
        render();
        main.removeCallbacks(clearSelection);
        main.postDelayed(clearSelection, 6000);
    }

    @Override public boolean onKeyDown(int code, KeyEvent e) {
        // Play/Pause turns cursor mode on and off.
        if (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
            if (e.getRepeatCount() == 0) setCursor(!cursor.isOn());
            return true;
        }
        // After BACK turned the cursor off, ignore the rest of that press (its autorepeats),
        // or holding BACK would go on to leave full screen and close the app.
        if (code == KeyEvent.KEYCODE_BACK && swallowBack) return true;
        if (cursor.isOn()) {
            if (code == KeyEvent.KEYCODE_BACK) { swallowBack = true; setCursor(false); return true; }
            if (cursor.onKeyDown(code, e)) return true;
        }
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_RIGHT: select(selected < 0 ? 0 : selected + 1); return true;
            case KeyEvent.KEYCODE_DPAD_LEFT: select(selected < 0 ? 0 : selected - 1); return true;
            case KeyEvent.KEYCODE_DPAD_DOWN: select(selected < 0 ? 0 : selected + cols); return true;
            case KeyEvent.KEYCODE_DPAD_UP: select(selected < 0 ? 0 : selected - cols); return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
                onOk(); return true;
            case KeyEvent.KEYCODE_MENU:
                askServer(); return true;
            case KeyEvent.KEYCODE_BACK:
                return onBackKey();
            default:
                return super.onKeyDown(code, e);
        }
    }

    @Override public boolean onKeyUp(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) return true;
        if (code == KeyEvent.KEYCODE_BACK && swallowBack) { swallowBack = false; return true; }
        if (cursor.onKeyUp(code)) return true;
        return super.onKeyUp(code, e);
    }

    private void setCursor(boolean on) {
        cursor.setOn(on);
        if (on) { selected = -1; main.removeCallbacks(clearSelection); render(); }
        Toast.makeText(this, on
                ? "Cursor on. Arrows move, OK clicks, Rewind / Fast-forward scroll. Play/Pause or BACK to stop."
                : "Cursor off", on ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT).show();
    }

    // OK on a window: 1st press = sound from it, 2nd press = full screen / back to the wall.
    private void onOk() {
        if (selected < 0) { select(0); return; }
        String id = order.get(selected);
        if (!id.equals(audio())) { localAudio = id; hasLocalAudio = true; }
        else { localSolo = id.equals(solo()) ? null : id; hasLocalSolo = true; }
        render();
        select(Math.max(0, order.indexOf(id)));
    }

    private boolean onBackKey() {
        if (solo() != null) { localSolo = null; hasLocalSolo = true; render(); return true; }
        if (selected >= 0) { selected = -1; render(); return true; }
        long now = System.currentTimeMillis();
        if (now - lastBack < 2500) { finish(); return true; }
        lastBack = now;
        Toast.makeText(this, "Press BACK again to close Split Screen", Toast.LENGTH_SHORT).show();
        return true;
    }

    private void askServer() {
        EditText in = new EditText(this);
        in.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        in.setHint("192.168.1.50:8090");
        if (server != null) in.setText(server);
        new AlertDialog.Builder(this)
                .setTitle("PC address (shown on the control page)")
                .setView(in)
                .setPositiveButton("Connect", (d, w) -> {
                    String v = in.getText().toString().trim().replaceFirst("^https?://", "").replaceFirst("/.*$", "");
                    if (v.isEmpty()) return;
                    if (!v.contains(":")) v += ":8090";
                    server = v;
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, v).apply();
                    version = 0;
                    stoppedByPc = false;   // show connection messages for the new address
                    if (worker != null) worker.interrupt();
                })
                .setNeutralButton("Search again", (d, w) -> {
                    server = null;
                    stoppedByPc = false;
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_SERVER).apply();
                    if (worker != null) worker.interrupt();
                })
                .setNegativeButton("Cancel", null)
                .show();
    }
}
