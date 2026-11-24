# Split Screen

Play up to 16 URLs at once on a TV (built for the Hisense 75QD7QF). You control it from your PC. The TV shows the windows.

## Upgrade from TV Wall

Split Screen was called TV Wall before release 1.1. To move an existing install over, do these steps 1 time:

1. In the old TV Wall tray icon, turn **Start with Windows** off. Then click **Quit TV Wall**. If you used `start-tv-wall.bat`, close its window instead.
2. Move `state.json` and the `media` folder from the folder with `TVWall.exe` (in a copy of the project, `tv-wall`) into the folder with `SplitScreen.exe` (in a copy of the project, `split-screen`). Your window list and files come with them.
3. Delete `TVWall.exe`. If it stays, an old sign-in entry or a double-click can start it instead of Split Screen. In a copy of the project, delete the whole old `tv-wall` folder.
4. Start `SplitScreen.exe` (or `start-split-screen.bat`). If you want it, turn **Start with Windows** on again in its tray icon.
5. On the TV, uninstall the **TV Wall** app (**Settings > Applications > Manage Installed Applications > TV Wall > Uninstall**). Then install Split Screen (see **Fire TV app**, steps 6-9). It finds the PC by itself. If you typed the PC address in the old app's MENU dialog, type it again.

> **NOTE:** Until you replace it, the old TV Wall app still finds and plays from Split Screen.

## Start

> **WARNING:** The PC and the TV must be on the same Wi-Fi or router.

**On the PC:**

> **NOTE:** `SplitScreen.exe` is not stored in git. Get it 1 of 3 ways:
> 1. Download it from the GitHub **Releases** page (https://github.com/ADHD-TISM/split-screen/releases). Download `SplitScreen.apk` from the same release (the PC serves it to the TV; see **Fire TV app**), and put both files in 1 folder you can write to.
> 2. Build it with `build-exe.bat` (see **Build SplitScreen.exe**).
> 3. Skip it and use `start-split-screen.bat`, which needs Node.js 20.12 or later.

1. Double-click `SplitScreen.exe`. No window opens. A Split Screen icon appears in the taskbar tray, by the clock, and the control page opens in your browser.
2. If Windows shows **Windows protected your PC**, click **More info > Run anyway**. This appears for a downloaded copy, because the .exe is not signed.
3. If Windows Firewall asks about Split Screen, allow **Private networks**. The TV cannot connect without this.
4. To stop Split Screen, right-click the tray icon and click **Quit Split Screen**.

**Tray icon:**

| Action | Result |
|---|---|
| Click | Opens the control page. |
| Right-click > **Open control page** | Opens the control page. |
| Right-click > **Copy TV address** | Copies the address to type on the TV, for example `http://192.168.1.50:8090/tv`. |
| Right-click > **Show log** | Opens `splitscreen.log` in Notepad. Split Screen writes its messages there. |
| Right-click > **Start with Windows** | Turns starting at sign-in on or off. A check mark shows it is on. At sign-in, Split Screen starts in the tray without opening the control page. |
| Right-click > **Quit Split Screen** | Stops Split Screen. The icon goes away. |

- When Split Screen stops (**Quit Split Screen**, **Stop Split Screen** on the control page, or closing the `start-split-screen.bat` window), the TV clears its windows and shows **Split Screen was stopped on the PC**. Your window list stays saved. When Split Screen starts again, the TV shows the windows again by itself. Old TV Wall apps before version 1.4 clear the windows without the message.
- If the PC sleeps, shuts down, or Split Screen is ended in Task Manager, no stop message is sent. The TV keeps playing streams it loads directly and shows **Reconnecting to the PC…**. Close the app on the TV with BACK 2 times to stop them.
- **Start with Windows** adds Split Screen to your own sign-in programs (no admin rights needed).
  - It also shows in **Task Manager > Startup apps**, as **Split Screen** (a copy built before version 1.1 shows **Node.js JavaScript Runtime**). You can turn it off there too; the tray check mark then clears. Turning it on in the tray turns it back on.
  - At sign-in there is no balloon, and the network may not be ready yet. To get the TV address, use **Copy TV address** after a minute.
  - If you move `SplitScreen.exe`, start it once from the new place; the entry follows it. Another copy started from elsewhere does not take it over.
  - Before you delete `SplitScreen.exe`, turn **Start with Windows** off.
  - Signing out or restarting Windows ends Split Screen without a stop message to the TV, like a shutdown.
- The icon may be hidden under the **^** arrow by the clock. Drag it onto the taskbar to keep it visible.
- **Stop Split Screen** on the control page also stops it. Use this if the tray icon does not appear. Split Screen keeps serving the TV when the tray icon cannot start, for example on a PC where PowerShell is locked down.
- If Split Screen is already running, a 2nd double-click opens the running copy's control page. It does not start a 2nd server.
- If another app holds port 8090, Split Screen takes the next free port. The tray icon tooltip shows the port, and **Copy TV address** copies the full address.
- If Split Screen cannot start, a message box shows the reason. `splitscreen.log` has the details.
- If the tray icon cannot start, `splitscreen.log` says why (lines starting **Tray icon**).
- Open Split Screen by number (`127.0.0.1`, `192.168.x.x`), as `localhost`, or, from another device, by this PC's name. Other names are refused, for example `mypc.local`, `mypc.lan`, `something.nip.io` or a proxy address, so other websites cannot read Split Screen. In the Fire TV app's MENU dialog, type the PC's number.
- Each start writes a new `splitscreen.log`. The previous run's log is kept as `splitscreen.old.log`.
- If Split Screen ends unexpectedly (for example, from Task Manager), its tray icon may stay until you move the mouse over it.
- `start-split-screen.bat` runs Split Screen in a console window instead, with no tray icon. Close that window to stop it.

**On the TV:** use the Fire TV app (recommended, see **Fire TV app**), or the TV's web browser:

1. Open the web browser app.
2. Type the address shown on the control page, for example `http://192.168.1.50:8090/tv`.
3. Bookmark that page.
4. Press **OK** on the remote once. This turns on sound and full screen.

## Build SplitScreen.exe

`SplitScreen.exe` holds Node.js, the server, and the pages in 1 file, so the PC needs nothing else installed. It is about 90 MB, so it is not stored in git; each version is attached to a GitHub release instead. To use a ready-made one, download it from the Releases page (see **Start**).

1. Install Node.js 20.12 or later. Only the PC that builds the .exe needs it.
2. Double-click `build-exe.bat`. The build needs an internet connection: the 1st time, it downloads the build tools `postject` and `resedit` from npm, and each time it downloads the license of your Node.js version.
3. `SplitScreen.exe` and `NODE-LICENSE.txt` appear in this folder.

- Close Split Screen before you build (tray icon > **Quit Split Screen**). A running `SplitScreen.exe` cannot be replaced.
- Build again after you change `server.js`, `tray.ps1`, or a file in `public`.
- The build makes `SplitScreen.exe` a Windows program with no console window. The tray icon is a small PowerShell script built into the .exe; PowerShell comes with Windows.
- Keep `SplitScreen.exe` in the folder with `SplitScreen.apk` (in a copy of the project, this folder). It reads `state.json`, the `media` folder and `SplitScreen.apk` from the folder it sits in. To move it, move those with it.

**Publish a new version** (after a change, on the PC that builds):

1. Run `npm test` in this folder. It checks the stream relay (it uses ports 18990, 18991 and 18999, which must be free). Fix any failure before you commit.
2. If the TV app changed, run `android\build-apk.bat`. `SplitScreen.apk` is stored in git, so build it before you commit.
3. In PowerShell in this folder (`split-screen`), set the version to the release number (`1.1.0` for v1.1): `npm version 1.1.0 --no-git-tag-version --allow-same-version`. This updates `package.json` and `package-lock.json`. `SplitScreen.exe` shows it in Properties > Details. Commit the change, merge it into `main`, and push `main`. The release is tagged on `main` on GitHub.
4. Switch to `main` and update it (`git switch main`, then `git pull --ff-only`), then build `SplitScreen.exe` with `build-exe.bat`. The exe then holds exactly the tagged code. The build also writes `NODE-LICENSE.txt`, the license of the Node.js inside the exe (it needs an internet connection for this).
5. In PowerShell in this folder (`split-screen`), create the release with the next version number. This uploads all 3 files:

   ```powershell
   gh release create v1.1 SplitScreen.exe SplitScreen.apk NODE-LICENSE.txt --target main --title "Split Screen 1.1" --notes "What changed"
   ```

6. Check the release and its 3 files: `gh release view v1.1`.

- Use a new version number each time. Older releases keep their own files.
- Release numbers are separate from the TV app's version (`versionName` in `android\app\build.gradle`).
- `gh` is the GitHub CLI. It must be signed in to a GitHub account with write access to the repository (`gh auth status`).

## Use the control page (PC)

| Task | Action |
|---|---|
| Add windows | Paste 1 URL per line. Click **Add to TV**. |
| Swap all windows | Paste URLs. Click **Replace all**. |
| Pick the sound | Click **🔊 Sound** on 1 window. Only 1 window plays sound. |
| Show 1 window big | Click **⛶ Full**. Click again to return to the wall. |
| Change the layout | Click a layout button. **Auto** fits the window count. |
| Restart a stuck window | Click **↻**. |
| Play files from the PC | Put files in the `media` folder. Click **Refresh list**, then **Add**. |

Changes appear on the TV in under 1 second.

## Arrange windows freely

1. Click the **Free (drag & resize)** layout. The **Arrange** box opens. It is a map of the TV screen.
2. Drag a window to move it.
3. Drag a blue corner to resize it.
4. Click a window, then click a snap button: **Full**, halves, quarters, **Left ⅔**, **Right ⅓**, or **Small** in any corner.

- Windows snap to screen edges, halves, thirds, quarters, and the edges of other windows. A yellow line shows the snap.
- Hold **Shift** while dragging to stop snapping.
- Arrow keys move the selected window 1%. **Shift** + arrow moves it 10%.
- The window you touch last goes on top. **Full** sends that window to the back, so small windows stay visible over it.
- **Reset to grid** puts all windows back in an even grid.
- The TV follows the drag live.

## Full screen

- The TV page goes full screen when you press any button on the remote.
- If the TV leaves full screen, a prompt appears. Press any button to return.
- Browsers block full screen until the viewer presses a button. To skip that press, do 1 of these:
  1. Open `/tv` in the browser. Use its menu to **Add to home screen**. Start Split Screen from that icon.
  2. Install a kiosk browser app on the TV, such as Fully Kiosk Browser. Set its start page to the `/tv` address.

## Use the TV remote

| Button | Result |
|---|---|
| Arrows | Select a window. A blue frame shows the selection. |
| OK, 1st press | Sound plays from the selected window. |
| OK, 2nd press | The selected window goes full screen. Press again to return. |

A change on the PC replaces any choice made with the remote.

## What plays

| URL type | Works |
|---|---|
| `.m3u8` live streams | Yes. This is the main use. See **Live streams**. |
| `.mp4`, `.webm`, `.mov`, `.mkv`, audio files | Yes. `.mkv` depends on the TV codec. |
| Vimeo | Yes. Sound control works. |
| YouTube | In the Fire TV app, yes. In the TV's web browser, no: YouTube refuses a numeric address such as `192.168.x.x`, and Split Screen refuses domain names. |
| Twitch | Not supported. |
| Images | Yes. |
| Other web pages | Only if the site allows embedding. Netflix, Google, and most sign-in sites refuse. |

## Fire TV app (SplitScreen.apk)

The app plays streams with the TV's own video player. Video is smoother than in the browser. Sound works without the **OK** press. The screen stays on.

> **WARNING:** The PC must run Split Screen (`SplitScreen.exe` or `start-split-screen.bat`). The app gets its window list from the PC.

The app file is `SplitScreen.apk` in this folder. It is stored in git, so it comes with every copy of the project. It is also attached to each GitHub release, next to `SplitScreen.exe`. The PC serves it to the TV at `/SplitScreen.apk`.

**Install, 1 time:**

1. On the PC, start Split Screen. Read the TV address on the control page, for example `http://192.168.1.50:8090/tv`.
2. On the TV, install the **Downloader** app (by AFTVnews) from the Amazon Appstore.
3. On the TV, open **Settings > Device & Software > About**. On a Fire TV stick, the menu is **My Fire TV > About**.
4. Select the 1st item on the About screen (**Your TV**, or the TV's name) 7 times. The TV counts down the steps left. Stop when it says you are a developer.
5. Go back 1 screen. **Developer options** is now in the list. Open it, then open **Install unknown apps**. Turn it on for **Downloader**.
6. Open Downloader. In the address box, type the PC address with `/SplitScreen.apk` at the end, for example `http://192.168.1.50:8090/SplitScreen.apk`. Select **Go**.
7. When the download ends, select **Install**.
8. Select **Done**. When Downloader asks, select **Delete** to remove the downloaded file. The app stays installed.
9. Open **Split Screen** from **Your Apps & Channels**. It finds the PC by itself.

**Update the app:** do steps 1, 6, 7 and 8 again. Your settings stay. (From the old TV Wall app, see **Upgrade from TV Wall** instead.) The app shows its version in **Settings > Applications > Manage Installed Applications > Split Screen**.

> **CAUTION:** Build every new `SplitScreen.apk` on the same PC. The app is signed with that PC's Android debug key. An APK built on another PC fails to install over the old one with **App not installed**. Then uninstall Split Screen on the TV first. This clears the saved PC address; the app finds the PC again by itself.

If the app does not find the PC, press **MENU (≡)** and type the address from the control page without `/tv`, for example `192.168.1.50:8090`.

**Use:**

| Button | Result |
|---|---|
| Arrows | Select a window. |
| OK, 1st press | Sound plays from the selected window. |
| OK, 2nd press | The selected window goes full screen. |
| BACK | Leaves full screen. Press 2 times on the wall to close the app. |
| MENU (≡) | Type the PC address, or search again. |
| Play/Pause | Turns cursor mode on or off. |

**Cursor mode** (version 1.2 and later): a mouse cursor for clicking inside web pages and players.

| Button | Result |
|---|---|
| Arrows | Move the cursor. 1 short press moves it a little. Hold to speed up. |
| OK | Clicks at the tip of the arrow. |
| Rewind | Scrolls the window under the cursor up. |
| Fast-forward | Scrolls the window under the cursor down. |
| BACK or Play/Pause | Turns cursor mode off. |

- The cursor hides after 10 seconds without a press. The next OK, Rewind, or Fast-forward only shows it again, so you can see where it is before it clicks.
- The Fire TV remote has no motion sensor, so it cannot point at the screen. The arrows move the cursor.
- Text boxes in web pages cannot be typed into.
- In YouTube and Vimeo windows, clicks reach the player, but links that would replace the player are blocked. This keeps sound control working.

- The app finds the PC by itself (UDP port 47390). It finds the PC again when the port changes.
- If Windows Firewall asks about Split Screen or Node.js, allow **Private networks** only. The search needs it.
- To rebuild the app, run `android\build-apk.bat`. It writes a new `SplitScreen.apk`. Commit the new APK so the copy in git stays current.

## Live streams

Paste any HLS link. The link must contain `.m3u8`, in the path or in the query.

| Feature | What it does |
|---|---|
| Status on the PC | Each window shows what the TV reports: **playing**, **buffering**, **via PC**, or an error with a retry countdown. It updates every 5 seconds. |
| PC relay | If a stream refuses to play on the TV, the TV gets it through the PC instead. The status then says **via PC**. This is automatic. |
| Reconnect | If a stream drops, the window reconnects. It waits 3 s, then longer, up to 30 s between tries. |
| Freeze check | If the picture stops for 20 s, the window reconnects. |

- The relay only fetches hosts from the window list, plus hosts those playlists and their redirects point to.
- The relay never fetches from this PC's own loopback address (`127.0.0.1`, `localhost`). For a local file, put it in `media` and add it as `/media/...`.
- The relay fetches a device on your local network only when the window list has its exact address or local name, with the same `http`/`https` and port. A local name is 1 word (`nas`) or ends in `.local`, `.lan`, `.home`, `.home.arpa`, `.internal`, `.intranet`, `.localdomain` or `.fritz.box`. For any other name, use the device's address (for example `192.168.1.20`). Devices that use `https` with their own (self-signed) certificate do not play via PC. On IPv6 networks this covers the PC's own IPv6 network too.
- The relay passes on video, audio, playlists and subtitles only. Anything else (for example a web page) reaches the TV as plain bytes and never runs.
- Streams that go **via PC** use the PC's internet connection and upload speed to the TV.
- RTSP camera links (`rtsp://`) do not play in a browser. Use the camera's HLS link instead.
- DASH links (`.mpd`) are not supported.

## Limits

- The TV can decode a limited number of videos at once. If windows stutter, use 4 windows or fewer.
- Video plays muted until you press **OK** on the remote once. This is a browser rule.
- Only this PC can change the windows. Other devices on the network can only view `/tv`.
- The PC must stay on, awake, and running Split Screen.
- The TV may start its screensaver over still images. Turn off the screensaver in the TV settings if needed.

## Security

Split Screen has no passwords. It trusts the network it runs on.

- Run it on a home network you trust. In Windows Firewall, allow it on **Private networks** only, never Public.
- Anyone on the same network can see the window list (including any tokens inside stream links), play every file in `media`, and use the PC relay for the hosts in the window list and the hosts their playlists and redirects name.
- `ALLOW_REMOTE_CONTROL=1` lets any device on the network change what the TV shows. Leave it off unless you need it.
- Add only stream and page links you trust. The PC fetches streams for the TV, and also the hosts a playlist names.
- Known limit: the relay cannot tell your router's public internet address from any other public address. A playlist could make the PC send a plain request (GET) to it. The answer goes to the TV, not to the playlist's owner.
- The TV app finds the PC by a network search and trusts the 1st PC that answers. If the TV shows the wrong PC, type the PC's address in the app's MENU dialog.
- Get `SplitScreen.apk` and `SplitScreen.exe` only from this repository's Releases page. Official releases are built by the maintainer. To check an APK, run `apksigner verify --print-certs SplitScreen.apk` (Android SDK build-tools). The SHA-256 certificate digest must be `f03a3caa2cc1a11d82652b2cc812400fd963883d458ab31945b7dfc43fad5bee`.
- Pull requests that change `SplitScreen.apk` or `android\gradle\wrapper\gradle-wrapper.jar` are not merged: binary files cannot be reviewed. The maintainer builds them.
- To report a security problem, use **Report a vulnerability** on this repository's **Security** tab. Do not open a public issue for it.

## Settings

| Variable | Use | Default |
|---|---|---|
| `PORT` | Port number. | `8090` |
| `MEDIA_DIR` | Folder for local files. | `./media` |
| `STATE_FILE` | Saved windows and layout. | `./state.json` |
| `ALLOW_REMOTE_CONTROL` | Set to `1` to allow control from other devices on the network. | off |
| `OPEN_BROWSER` | `0`: do not open the control page at start. `1`: open it (set by `start-split-screen.bat`). | on for `SplitScreen.exe` |
| `TRAY` | `1`: use the tray icon and `splitscreen.log` with `node server.js` too. | always on for `SplitScreen.exe` |

## License

Split Screen is released under the MIT License (see `LICENSE`). `SplitScreen.exe` also contains Node.js and the parts it includes. Their licenses are in `NODE-LICENSE.txt`, attached to each release. `SplitScreen.apk` contains the AndroidX, Media3 and Kotlin libraries, released under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
