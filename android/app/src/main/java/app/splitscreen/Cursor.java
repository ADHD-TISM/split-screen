package app.splitscreen;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.widget.FrameLayout;

/**
 * A mouse cursor driven by the remote. The Fire TV remote has buttons only (no motion
 * sensor), so the arrows move the cursor: slowly at first, faster the longer they are held.
 * OK taps the screen at the cursor tip. Rewind / fast-forward drag the page to scroll.
 * Only 1 synthetic gesture runs at a time; a new press cancels the one still running.
 */
final class Cursor {
    private static final long HIDE_MS = 10000;      // hide after 10 s without a press
    private static final long FRAME_MS = 16;
    // Held-arrow speed in px per second, measured in time (not per frame), so it stays the
    // same when the TV is busy and frames come late. Full speed crosses a 1920 px screen in
    // under 1 s.
    private static final float MIN_SPEED = 400f;    // when a hold starts
    private static final float MAX_SPEED = 2400f;   // after RAMP_MS of holding
    private static final long RAMP_MS = 600;
    private static final long MAX_STEP_MS = 100;    // cap one step after a long stall
    private static final long HOLD_DELAY_MS = 180;  // shorter presses are taps: nudge only
    private static final float NUDGE_PX = 6f;       // a single short press
    private static final long TAP_MS = 60;
    private static final float SCROLL_FRACTION = 0.6f;   // of the window's height
    private static final int SCROLL_STEPS = 10;
    private static final long SCROLL_HOLD_MS = 60;  // hold still before lifting: no fling

    private final ViewGroup root;
    private final ViewGroup wall;   // holds the windows; its frame matches root
    private final Arrow arrow;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final int minDragPx;
    private boolean on, left, right, up, down;
    private long holdStart, lastTick;
    private float x = -1, y = -1;

    // The synthetic gesture in flight, if any. Its queued events carry this token.
    private final Object gesture = new Object();
    private boolean gestureOpen;
    private long gestureDown;
    private float gestureX, gestureY;

    Cursor(ViewGroup root, ViewGroup wall) {
        this.root = root;
        this.wall = wall;
        minDragPx = 4 * ViewConfiguration.get(root.getContext()).getScaledTouchSlop();
        arrow = new Arrow(root.getContext());
        arrow.setVisibility(View.GONE);
        arrow.setClickable(false);
        arrow.setFocusable(false);
        arrow.setZ(1000);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Arrow.SIZE, Arrow.SIZE);
        lp.gravity = Gravity.TOP | Gravity.LEFT;   // translation is measured from the top-left
        root.addView(arrow, lp);
    }

    boolean isOn() { return on; }

    void setOn(boolean value) {
        on = value;
        releaseKeys();
        cancelGesture();
        h.removeCallbacks(hide);
        if (on) {
            if (x < 0) { x = root.getWidth() / 2f; y = root.getHeight() / 2f; }
            place();
            show();
        } else {
            arrow.setVisibility(View.GONE);
        }
    }

    /** Stops movement. Call when the window loses focus, in case a key-up never arrives. */
    void releaseKeys() {
        left = right = up = down = false;
        h.removeCallbacks(tick);
    }

    /** Returns true if the key was used by the cursor. */
    boolean onKeyDown(int code, KeyEvent e) {
        if (!on) return false;
        boolean first = e.getRepeatCount() == 0;
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_LEFT:  return hold(e, 'L');
            case KeyEvent.KEYCODE_DPAD_RIGHT: return hold(e, 'R');
            case KeyEvent.KEYCODE_DPAD_UP:    return hold(e, 'U');
            case KeyEvent.KEYCODE_DPAD_DOWN:  return hold(e, 'D');
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
                if (first && revealed()) click();
                return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                if ((first || e.getRepeatCount() % 6 == 0) && revealed()) scroll(+1);   // finger down = page up
                return true;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                if ((first || e.getRepeatCount() % 6 == 0) && revealed()) scroll(-1);
                return true;
            default:
                return false;
        }
    }

    boolean onKeyUp(int code) {
        if (!on) return false;
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_LEFT:  left = false; return true;
            case KeyEvent.KEYCODE_DPAD_RIGHT: right = false; return true;
            case KeyEvent.KEYCODE_DPAD_UP:    up = false; return true;
            case KeyEvent.KEYCODE_DPAD_DOWN:  down = false; return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                return true;
            default: return false;
        }
    }

    /** If the cursor was hidden, this press only shows it (the user may not know where it is). */
    private boolean revealed() {
        boolean wasVisible = arrow.getVisibility() == View.VISIBLE;
        show();
        return wasVisible;
    }

    private boolean hold(KeyEvent e, char dir) {
        h.removeCallbacks(glide);   // the remote moves the arrow now, not the PC mouse
        gliding = false;
        show();
        if (e.getRepeatCount() > 0) return true;   // the ticker already moves it
        boolean wasIdle = !(left || right || up || down);
        switch (dir) {
            case 'L': left = true; x -= NUDGE_PX; break;
            case 'R': right = true; x += NUDGE_PX; break;
            case 'U': up = true; y -= NUDGE_PX; break;
            default:  down = true; y += NUDGE_PX; break;
        }
        place();
        long now = SystemClock.uptimeMillis();
        if (wasIdle) {
            // A tap moves exactly NUDGE_PX. Gliding starts only once the press is a hold.
            holdStart = lastTick = now + HOLD_DELAY_MS;
            h.removeCallbacks(tick);
            h.postDelayed(tick, HOLD_DELAY_MS);
        } else if (now >= holdStart) {
            // A direction added mid-hold starts slow again, so small corrections stay possible.
            holdStart = now;
        }
        return true;
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!on || !(left || right || up || down)) return;
            long now = SystemClock.uptimeMillis();
            long dt = Math.max(0, Math.min(MAX_STEP_MS, now - lastTick));
            lastTick = now;
            float t = Math.max(0f, Math.min(1f, (now - holdStart) / (float) RAMP_MS));
            float v = (MIN_SPEED + (MAX_SPEED - MIN_SPEED) * t) * dt / 1000f;
            if ((left || right) && (up || down)) v *= 0.7071f;   // diagonal: same speed as straight
            if (left) x -= v;
            if (right) x += v;
            if (up) y -= v;
            if (down) y += v;
            place();
            show();
            h.postDelayed(this, FRAME_MS);
        }
    };

    private final Runnable hide = this::hideArrow;

    private void hideArrow() { arrow.setVisibility(View.GONE); }

    private void show() {
        arrow.setVisibility(View.VISIBLE);
        h.removeCallbacks(hide);
        h.postDelayed(hide, HIDE_MS);
    }

    private void place() {
        x = Math.max(0, Math.min(root.getWidth() - 1, x));
        y = Math.max(0, Math.min(root.getHeight() - 1, y));
        // The drawn tip sits at (Arrow.TIP, Arrow.TIP) inside the view.
        arrow.setTranslationX(x - Arrow.TIP);
        arrow.setTranslationY(y - Arrow.TIP);
    }

    // ---------- from the PC preview ----------

    /**
     * The PC mouse over the preview: the arrow follows it, and hides after HIDE_MS (10 s)
     * without a move. Nothing is clicked.
     */
    void pointAt(float px, float py) {
        // Glide there over a few frames instead of jumping: the PC sends about 20 moves a
        // second, so the arrow moves smoothly between them.
        // Clamped like place(), so the glide always reaches its target and ends.
        glideX = Math.max(0, Math.min(root.getWidth() - 1, px));
        glideY = Math.max(0, Math.min(root.getHeight() - 1, py));
        show();
        if (!gliding) { gliding = true; h.post(glide); }
    }

    private float glideX, glideY;
    private boolean gliding;
    private final Runnable glide = new Runnable() {
        @Override public void run() {
            x += (glideX - x) * 0.45f;
            y += (glideY - y) * 0.45f;
            if (Math.abs(glideX - x) < 1f && Math.abs(glideY - y) < 1f) { x = glideX; y = glideY; gliding = false; }
            place();
            if (gliding) h.postDelayed(this, FRAME_MS);
        }
    };

    /** A click sent from the preview on the PC. The arrow goes there at once and shows the click. */
    void tapAt(float px, float py) {
        h.removeCallbacks(glide);
        gliding = false;
        x = px; y = py;
        place();
        show();
        click();
    }

    /**
     * A scroll sent from the preview on the PC: dy window heights, + = down (like a wheel).
     * The finger drags the other way, from (px, py). The arrow does not move.
     */
    void scrollAt(float px, float py, float dy) {
        if (dy == 0 || Float.isNaN(dy)) return;   // a drag of 0 would be a tap
        cancelGesture();
        View target = windowAt(px, py);
        if (target == null) return;
        scrollBy(px, py, -dy * target.getHeight());
    }

    /** A finger drag of dist pixels (+ = down, so the page goes up) from (px, py). */
    void scrollBy(float px, float py, float dist) {
        if (dist == 0 || Float.isNaN(dist)) return;
        cancelGesture();
        if (windowAt(px, py) == null) return;
        if (Math.abs(dist) < minDragPx) dist = Math.signum(dist) * minDragPx;
        drag(px, py, py + dist);
    }

    // ---------- synthetic gestures ----------

    private void click() {
        cancelGesture();
        arrow.pulse();
        long t = SystemClock.uptimeMillis();
        touch(MotionEvent.ACTION_DOWN, t, t, x, y);
        later(TAP_MS, () -> touch(MotionEvent.ACTION_UP, gestureDown, SystemClock.uptimeMillis(), gestureX, gestureY));
    }

    /**
     * dir +1 drags the finger down (page moves up), -1 drags it up. The drag starts at the
     * cursor, so it goes to the window under the cursor. The end point is not clamped: the
     * window that got the DOWN keeps getting the MOVEs, even outside its edges, as with a
     * real finger. The distance is 60% of that window's height.
     */
    private void scroll(int dir) {
        cancelGesture();
        View target = windowAt(x, y);
        if (target == null) return;   // in a gap between windows: nothing to scroll
        float dist = Math.max(minDragPx, target.getHeight() * SCROLL_FRACTION);
        drag(x, y, y + dir * dist);
    }

    /** A finger drag from (px, start) to (px, y1) in SCROLL_STEPS steps, then held and lifted. */
    private void drag(final float px, final float start, final float y1) {
        final long t = SystemClock.uptimeMillis();
        touch(MotionEvent.ACTION_DOWN, t, t, px, start);
        for (int i = 1; i <= SCROLL_STEPS; i++) {
            final float yy = start + (y1 - start) * i / SCROLL_STEPS;
            later(i * FRAME_MS, () -> touch(MotionEvent.ACTION_MOVE, t, SystemClock.uptimeMillis(), px, yy));
        }
        // Hold still at the end, then lift: the page stops where the finger stopped.
        later(SCROLL_STEPS * FRAME_MS + SCROLL_HOLD_MS,
                () -> touch(MotionEvent.ACTION_MOVE, t, SystemClock.uptimeMillis(), px, y1));
        later(SCROLL_STEPS * FRAME_MS + SCROLL_HOLD_MS + FRAME_MS,
                () -> touch(MotionEvent.ACTION_UP, t, SystemClock.uptimeMillis(), px, y1));
    }

    /** The top-most visible window under (px, py), or null. Same order as touch dispatch. */
    private View windowAt(float px, float py) {
        View best = null;
        for (int i = 0; i < wall.getChildCount(); i++) {
            View c = wall.getChildAt(i);
            if (c.getVisibility() != View.VISIBLE) continue;
            if (px < c.getLeft() || px >= c.getRight() || py < c.getTop() || py >= c.getBottom()) continue;
            if (best == null || c.getZ() >= best.getZ()) best = c;
        }
        return best;
    }

    private void later(long delayMs, Runnable r) {
        h.postAtTime(r, gesture, SystemClock.uptimeMillis() + delayMs);
    }

    /** Drops queued events of the running gesture and cancels it in the view that has it. */
    private void cancelGesture() {
        h.removeCallbacksAndMessages(gesture);
        if (gestureOpen) touch(MotionEvent.ACTION_CANCEL, gestureDown, SystemClock.uptimeMillis(), gestureX, gestureY);
    }

    private void touch(int action, long downTime, long time, float px, float py) {
        MotionEvent.PointerProperties[] props = { new MotionEvent.PointerProperties() };
        props[0].id = 0;
        props[0].toolType = MotionEvent.TOOL_TYPE_FINGER;
        MotionEvent.PointerCoords[] coords = { new MotionEvent.PointerCoords() };
        coords[0].x = px;
        coords[0].y = py;
        coords[0].pressure = 1f;
        coords[0].size = 1f;
        MotionEvent ev = MotionEvent.obtain(downTime, time, action, 1, props, coords,
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        if (action == MotionEvent.ACTION_DOWN) { gestureOpen = true; gestureDown = downTime; }
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) gestureOpen = false;
        gestureX = px;
        gestureY = py;
        root.dispatchTouchEvent(ev);
        ev.recycle();
    }

    /** White arrow with a black outline. Its tip, at (TIP, TIP), is the click point. */
    private static final class Arrow extends View {
        static final int SIZE = 56;
        static final int TIP = 14;   // room around the tip for the click ring
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private long pulseUntil;

        Arrow(Context c) {
            super(c);
            fill.setColor(0xFFFFFFFF);
            edge.setColor(0xFF000000);
            edge.setStyle(Paint.Style.STROKE);
            edge.setStrokeWidth(3f);
            edge.setStrokeJoin(Paint.Join.ROUND);
            ring.setColor(0xFF4F8CFF);
            ring.setStyle(Paint.Style.STROKE);
            ring.setStrokeWidth(4f);
            int o = TIP;
            path.moveTo(o, o);
            path.lineTo(o, o + 32);
            path.lineTo(o + 9, o + 24);
            path.lineTo(o + 16, o + 38);
            path.lineTo(o + 22, o + 35);
            path.lineTo(o + 15, o + 21);
            path.lineTo(o + 27, o + 21);
            path.close();
        }

        void pulse() {
            pulseUntil = SystemClock.uptimeMillis() + 250;
            invalidate();
            postDelayed(this::invalidate, 260);
        }

        @Override protected void onDraw(Canvas c) {
            if (SystemClock.uptimeMillis() < pulseUntil) c.drawCircle(TIP, TIP, 12, ring);
            c.drawPath(path, fill);
            c.drawPath(path, edge);
        }
    }
}
