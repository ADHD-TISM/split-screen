package app.splitscreen;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import org.json.JSONObject;

/** Talks to the Split Screen server on the PC. All methods block: call them off the main thread. */
final class Server {
    static final int DISCOVERY_PORT = 47390;

    private Server() {}

    /**
     * Broadcasts on the local network and returns "ip:port" of the first PC that answers,
     * or null after timeoutMs.
     */
    static String discover(int timeoutMs) {
        try (DatagramSocket s = new DatagramSocket()) {
            s.setBroadcast(true);
            s.setSoTimeout(500);
            byte[] ask = "SPLITSCREEN_DISCOVER".getBytes(StandardCharsets.UTF_8);
            long end = System.currentTimeMillis() + timeoutMs;
            byte[] buf = new byte[512];
            while (System.currentTimeMillis() < end) {
                s.send(new DatagramPacket(ask, ask.length,
                        new InetSocketAddress(InetAddress.getByName("255.255.255.255"), DISCOVERY_PORT)));
                try {
                    DatagramPacket in = new DatagramPacket(buf, buf.length);
                    s.receive(in);
                    JSONObject j = new JSONObject(new String(in.getData(), 0, in.getLength(), StandardCharsets.UTF_8));
                    if ("splitscreen".equals(j.optString("app")) && j.optInt("port") > 0) {
                        return in.getAddress().getHostAddress() + ":" + j.getInt("port");
                    }
                } catch (SocketTimeoutException ignored) {
                    // No answer yet: ask again.
                }
            }
        } catch (Exception ignored) {
            // No network, or broadcast blocked.
        }
        return null;
    }

    /** True if a Split Screen server answers at "host:port". */
    static boolean ping(String hostPort) {
        try {
            JSONObject j = new JSONObject(get("http://" + hostPort + "/api/info", 3000));
            return j.has("port");
        } catch (Exception e) {
            return false;
        }
    }

    static String get(String url, int readTimeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(4000);
        c.setReadTimeout(readTimeoutMs);
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new Exception("HTTP " + code);
            return read(c.getInputStream());
        } finally {
            c.disconnect();
        }
    }

    static void postJson(String url, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(3000);
        c.setReadTimeout(3000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream o = c.getOutputStream()) {
            o.write(body.getBytes(StandardCharsets.UTF_8));
        }
        try {
            c.getResponseCode();
        } finally {
            c.disconnect();
        }
    }

    /** Sends a window picture. Returns 1 (keep sending), 0 (the PC says stop) or -1 (refused). */
    static int postJpeg(String url, byte[] jpeg) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(3000);
        c.setReadTimeout(5000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setFixedLengthStreamingMode(jpeg.length);
        c.setRequestProperty("Content-Type", "image/jpeg");
        try (OutputStream o = c.getOutputStream()) {
            o.write(jpeg);
        }
        try {
            if (c.getResponseCode() != 200) return -1;
            return new JSONObject(read(c.getInputStream())).optBoolean("wanted", false) ? 1 : 0;
        } finally {
            c.disconnect();
        }
    }

    private static String read(InputStream in) throws Exception {
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = is.read(b)) > 0) out.write(b, 0, n);
            return out.toString("UTF-8");
        }
    }
}
