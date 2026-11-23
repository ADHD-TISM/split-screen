package app.splitscreen;

/** Window positions. Same rules as placements() in public/tv.html. */
final class Layouts {
    /** A cell as fractions of the screen, plus a flag for small windows drawn on top. */
    static final class Cell {
        final float x, y, w, h;
        final boolean small;
        Cell(float x, float y, float w, float h, boolean small) {
            this.x = x; this.y = y; this.w = w; this.h = h; this.small = small;
        }
    }

    /** Result: one cell per window (null = hidden), and the column count for D-pad up/down. */
    static final class Result {
        final Cell[] cells;
        final int cols;
        Result(Cell[] cells, int cols) { this.cells = cells; this.cols = cols; }
    }

    private Layouts() {}

    static Result place(int n, String layout) {
        Cell[] cells = new Cell[n];
        if ("featured".equals(layout) && n > 1) {
            int side = Math.min(n - 1, 4);
            cells[0] = new Cell(0, 0, 0.75f, 1, false);
            for (int i = 1; i < n; i++) {
                if (i <= side) cells[i] = new Cell(0.75f, (i - 1) / (float) side, 0.25f, 1f / side, false);
            }
            return new Result(cells, 4);
        }
        if ("pip".equals(layout) && n > 1) {
            cells[0] = new Cell(0, 0, 1, 1, false);
            for (int i = 1; i < n && i <= 3; i++) {
                cells[i] = new Cell(0.75f, (4 - i) / 4f, 0.25f, 0.25f, true);
            }
            return new Result(cells, 4);
        }
        int c, r;
        switch (layout == null ? "" : layout) {
            case "1x1": c = 1; r = 1; break;
            case "2x1": c = 2; r = 1; break;
            case "1x2": c = 1; r = 2; break;
            case "2x2": c = 2; r = 2; break;
            case "3x2": c = 3; r = 2; break;
            case "3x3": c = 3; r = 3; break;
            case "4x4": c = 4; r = 4; break;
            default: // auto
                if (n <= 1) { c = 1; r = 1; }
                else if (n == 2) { c = 2; r = 1; }
                else if (n <= 4) { c = 2; r = 2; }
                else if (n <= 6) { c = 3; r = 2; }
                else if (n <= 9) { c = 3; r = 3; }
                else { c = 4; r = 4; }
        }
        for (int i = 0; i < n && i < c * r; i++) {
            cells[i] = new Cell((i % c) / (float) c, (i / c) / (float) r, 1f / c, 1f / r, false);
        }
        return new Result(cells, c);
    }
}
