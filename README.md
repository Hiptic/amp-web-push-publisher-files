## AMP Helper Files Builder - HTTP

This tool builds `amp-http-helper-frame.js` and `amp-http-remote-frame.js` and copies it to `Hiptic/OneSignal`'s `public/sdks/amp` directory so that all AMP web pages can use a globally distributed copy that can be easily updated.

### Usage

1. `yarn` to install packages
2. Clone `Hiptic/OneSignal` if you haven't side-by-side with this repo
	- `cd ..; git clone git@github.com:Hiptic/OneSignal.git; cd amp-helper-files-builder`
3. `yarn dist`
4. Files will be updated your local `Hiptic/OneSignal` repo in the paths noted in the `package.json` in this repo

For the **HTTPS** AMP helper see the following repo
https://github.com/Hiptic/amp-helper-files-builder