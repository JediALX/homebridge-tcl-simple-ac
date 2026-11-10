# Changelog

## 1.1.0 (unreleased; beta 1.1.0-beta.0 on npm under the `beta` tag)

### Added

- **External sensor compensation** (optional, off by default). The AC is sent a corrected target so that the room, as measured by any temperature sensor in the Home app, reaches the target you set. Room readings arrive from a Home automation triggered by a new "Sensor poll" switch, which exists only while the feature is configured. See the README section *Optional: External sensor compensation*.
  - The plugin settings show the Home automation setup steps once the feature is enabled, and the log prints the exact URL to use in the shortcut at startup.

### Changed

- Dependencies updated (AWS SDK, tsx, @types/node; Homebridge dev dependency to ^2.5.0).

Without a `compensation` section in the config, the plugin behaves exactly as in 1.0.0.

## 1.0.0

First public release.
