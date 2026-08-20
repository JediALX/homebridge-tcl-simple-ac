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
