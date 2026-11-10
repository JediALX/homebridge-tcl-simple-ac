# homebridge-tcl-simple-ac

Homebridge plugin that exposes **TCL Home split air conditioners** (built for the TCL **BreezeIN 2.0**, should work with other TCL split units) as single, Apple-like accessories.

Each AC appears in the Home app as **one HeaterCooler tile** — power, Auto/Heat/Cool mode, target temperature, current temperature, fan speed and oscillation, exactly like Apple's native AC UI. TCL features that HomeKit cannot represent (Dry mode, Fan-only mode, eco, turbo, sleep, display, beep) are deliberately **not** exposed, so there are no satellite switches cluttering your home.

## Supported devices

Developed and tested against **TCL BreezeIN 2.0** split ACs (firmware `V8-R82CT20-WFMV206`, EU account, heat-pump models). Other TCL split ACs that appear in the TCL Home app should work — the plugin adapts to the properties each unit reports (both fan-speed scales and both swing properties are handled) — but they are untested. If yours works, or doesn't, please [open an issue](https://github.com/JediALX/homebridge-tcl-simple-ac/issues) and include the output of `npm run probe` (it contains no credentials).

**Requirements**: Node 22, 24 or 26, Homebridge 1.8+ or 2.x, and a TCL Home account with your ACs already set up in the app.

## How it works

The plugin signs in to the TCL cloud with your TCL Home app credentials (the same reverse-engineered API used by the excellent [ha-tcl-home-unofficial-integration](https://github.com/nemesa/ha-tcl-home-unofficial-integration)):

1. Login at TCL's global account endpoint.
2. Discover your account's **regional** cloud endpoints automatically (no region setting needed — your account is already bound to the region you chose in the TCL Home app).
3. Exchange tokens for temporary AWS credentials.
4. Read each AC's state from its AWS IoT shadow, and send commands by publishing shadow updates — the exact mechanism the official app uses.

State is polled (default every 15 s). Commands are applied **optimistically** and rapid changes (e.g. dragging the temperature slider) are coalesced into a single cloud command, so the Home app feels instant.

## Installation

```bash
npm install -g homebridge-tcl-simple-ac
```

Or search for "TCL Simple AC" in the Homebridge UI. Then configure with your TCL Home email and password.

> Tip: consider creating a dedicated TCL Home account and sharing your devices to it, since the TCL cloud sometimes invalidates sessions when the same account logs in elsewhere.

### Configuration

```json
{
  "platforms": [
    {
      "platform": "TclSimpleAC",
      "name": "TCL Simple AC",
      "username": "you@example.com",
      "password": "your-tcl-home-password",
      "pollInterval": 15
    }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `username` / `password` | — | TCL Home app credentials (required) |
| `pollInterval` | `15` | Seconds between state reads |
| `enableDehumidifier` | `false` | Expose Dry mode as a separate Dehumidifier accessory per AC (see below) |
| `devices` | all split ACs | Optional allowlist of TCL device IDs (printed in the log at startup) |
| `minTemp` / `maxTemp` | `16` / `31` | Target temperature range (°C) |
| `compensation` | off | Regulate on a room sensor from the Home app instead of the AC's own (see below) |
| `loginUrl`, `cloudUrlsEndpoint`, `appId`, `iotEndpoint` | auto | Advanced endpoint overrides; normally never needed |

## Behavior notes

- **Fan speed slider**: the first slider position is **Auto**, the remaining positions are the unit's manual speeds from lowest to highest. The slider snaps to valid positions.
- **Oscillate** maps to the unit's vertical swing.
- **Dry / Fan-only modes** (set from the IR remote or TCL app) have no HomeKit equivalent: the tile shows the unit as on and *Idle*, with the mode selector unchanged. The plugin never overrides what you set on the remote. (Dry mode gets a proper representation with `enableDehumidifier`, below.)
- Selecting a mode in the Home app while the AC is off also powers it on (Apple-like behavior).
- **Powering on re-asserts oscillation** to whatever the Home app is showing, so the unit cannot resume
  swinging from its own memory when it starts up. Fan speed reads as 0 while the unit is off.

## Optional: Dehumidifier accessory

HomeKit has a native dehumidifier type, so with `"enableDehumidifier": true` each AC gains a **second tile** controlling its Dry mode. The two tiles act like separate appliances sharing one chassis:

- Turning the **Dehumidifier on** switches the unit to Dry mode; the AC tile shows **Off** while dehumidifying.
- Turning the **AC tile on** (or picking a mode) switches back to the last AC mode; the dehumidifier tile turns off.
- Turning the **Dehumidifier off** powers the unit down.

Caveats: the **humidity percentage shown is a fixed, synthetic 50%** (TCL split ACs report no humidity), and while in Dry mode the firmware controls fan speed and ignores the temperature setpoint itself. Disable the option and restart Homebridge to remove the tiles again.

## Optional: External sensor compensation

The indoor unit regulates on its own sensor, which sits high up in the unit and often misreads the room, especially when heating: the target looks reached long before the room is warm. With compensation on, the plugin reads a real room sensor and nudges the target it sends the AC so that the **room** ends up at your target:

```
sent to the AC = your target + (AC's own reading − room sensor reading)
```

The Home app keeps showing **your** target, and **Current Temperature shows the room sensor**. The AC keeps modulating its inverter as usual; nothing switches it on and off.

- Works in **Heat** and **Cool**. In Auto, Dry and Fan-only, and while a TCL preset that owns the setpoint is on (AI Eco, Sleep, 8 °C heating), the plugin leaves the target alone; when the AC leaves Heat/Cool it puts your plain target back.
- A target changed in the TCL app or with the IR remote is adopted as your new target.
- If room readings stop arriving, the plugin falls back to your plain target, so the AC behaves as it would without this feature.
- The correction is smoothed (about 10 minutes), capped (±5 °C by default) and written at most every 3 minutes, plus immediately when you change the target in the Home app.

### How the room temperature gets in

A Homebridge plugin cannot read other HomeKit accessories, so Apple Home delivers the readings: **any temperature sensor in the Home app works** (Hue, HomePod, Aqara, Eve…). The plugin adds one extra accessory, a **"Sensor poll"** switch, and turns it on briefly every 3 minutes. A Home automation reacts to that by reading your sensors and sending them to the plugin over your local network.

1. **Configure** (Homebridge UI → plugin settings → *External sensor compensation*):

   ```json
   "compensation": {
     "enabled": true,
     "token": "a-long-random-string-of-your-choice",
     "rooms": [
       { "deviceId": "DYQmFxFAAAE", "roomKey": "living" },
       { "deviceId": "DYQmFxFBBBB", "roomKey": "bedroom" }
     ]
   }
   ```

   Device IDs are printed in the Homebridge log at startup. Room keys are names you choose; lowercase ASCII (`living`, `bedroom`) avoids typos in the shortcut. Only mapped ACs are compensated.

2. **Network.** The plugin listens on port `18581` (configurable) on the machine running Homebridge. If Homebridge runs in Docker, use host networking or map the port. Allow the port in your NAS/computer firewall if one is on, and keep it on your LAN — never forward it from the internet.

3. **Home app.** Put the new **Sensor poll** switch in a room you don't use and leave it out of favourites. Then create a **Home automation**:
   - *When*: "An accessory is controlled" → **Sensor poll** → **turns on**. Choose **Convert to Shortcut**.
   - Add one **Get the state of** → *Current Temperature* action per room sensor.
   - Add **Get Contents of URL**: URL `http://<Homebridge IP>:18581/temperatures` (the address you open the Homebridge UI with, on port 18581 instead of the UI's port; the exact URL is printed in the Homebridge log at startup), method **POST**, header `x-token` = your token, request body **JSON** with one field `readings` of type **Dictionary** holding one entry per room: the room key → the matching *Current Temperature* result.
   - **Never include the ACs' own Current Temperature**: with compensation on it already shows the room sensor, which would feed back on itself.

   Tapping the Sensor poll switch runs the automation once, which is handy while setting it up. The same steps are shown in the plugin settings once the feature is enabled.

| Option (`compensation.`) | Default | Description |
|---|---|---|
| `enabled` | `false` | Turns the feature on. Without it, the plugin behaves exactly as without this section |
| `token` | — | Shared secret the shortcut sends as `x-token` (at least 16 characters) |
| `rooms` | — | `[{ "deviceId": …, "roomKey": … }]`, one entry per AC to compensate |
| `port` / `bindHost` | `18581` / all interfaces | Where the plugin listens for the shortcut |
| `sensorPollIntervalSeconds` | `180` | How often the Sensor poll switch fires the automation |
| `staleAfterSeconds` | `600` | Room readings older than this are ignored (fall back to the plain target) |
| `maxOffset` | `5` | Largest correction in °C |
| `smoothingMinutes` | `10` | How gently the correction follows changes; `0` turns smoothing off |
| `minChangeIntervalSeconds` | `180` | Minimum time between automatic target writes |

To switch the feature off, set `enabled` to `false` (or remove the section) and restart. Each AC gets your plain target back the next time it is on, and the Sensor poll switch is removed, together with the automation that uses it.

### Troubleshooting compensation

- The log shows one line per write, e.g. `compensation: user=22 internal=23 external=19 -> sent 26`, and warns when no readings arrive, when they stop or resume, and when the shortcut sends a room key that isn't configured.
- Test the receiver from any computer on your network (expect `HTTP 204`):

  ```bash
  curl -i -X POST http://<Homebridge IP>:18581/temperatures -H 'x-token: <your token>' -H 'content-type: application/json' -d '{"readings":{"living":"21,4 °C"}}'
  ```

  `404` means a wrong token or URL; `400` means no usable reading (an unknown room key or an unreadable value).
- **Known risk:** some users report that "Get Contents of URL" fails when the automation runs on the home hub, although it works when run by hand. If manual runs work but scheduled ones never arrive, this is the first suspect. The plugin then simply uses your plain targets.
- If heating sawtooths (the indoor fan slows near the target, its sensor reads high, the correction grows, the unit restarts…), increase `smoothingMinutes` or `minChangeIntervalSeconds`, or lower `maxOffset`.

## Limitations

- **Cloud only.** Every read and command goes through TCL's cloud; there is no local control. If your internet or TCL's service is down, so is the plugin.
- **Polling, not push.** State is refreshed every 15 s by default, so changes made on the IR remote take up to that long to appear in Home. Commands you send from Home apply immediately (optimistically).
- **Dry and Fan-only** are not part of the HeaterCooler tile by design; Dry can be exposed separately (see above), Fan-only cannot be represented at all.
- **No humidity sensor** exists on these units, so the optional dehumidifier reports a fixed 50%.
- The TCL API is **unofficial and undocumented** — TCL can change or break it at any time.

## Troubleshooting

- **"Missing TCL Home username/password"** — the plugin is installed but not configured; fill in the credentials in the plugin settings.
- **Login or discovery failures** — check the credentials in the TCL Home app first. The plugin retries with a growing backoff, so watch the log rather than restarting repeatedly.
- **Stuck session** — delete `tcl-simple-ac/tcl-session.json` from your Homebridge storage directory and restart to force a fresh login. Note that TCL sometimes invalidates a session when the same account logs in elsewhere.
- **Wrong or missing devices** — run the probe (below) to see exactly what your account exposes, then use the `devices` allowlist if needed.
- Enable Homebridge's debug mode to see every command the plugin publishes.

## Probing your device

To verify connectivity and dump the raw state of every device on your account (useful for debugging or adding support for new models):

```bash
TCL_USERNAME='you@example.com' TCL_PASSWORD='secret' npm run probe > probe-output.json
```

## Development

```bash
npm install
npm run build
npm test

# Run a local Homebridge with the plugin linked:
npm link
homebridge -D -U ./.homebridge-dev -P .
```

## Contributing

Issues and pull requests are welcome. For device-support reports, please include your model, firmware version and the probe output.

## Credits & disclaimer

API knowledge comes from the MIT-licensed [nemesa/ha-tcl-home-unofficial-integration](https://github.com/nemesa/ha-tcl-home-unofficial-integration). This project is not affiliated with TCL; use at your own risk.

## License

MIT
