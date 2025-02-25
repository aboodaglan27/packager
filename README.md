# TurboWarp Packager

https://packager.turbowarp.org/

Converts Scratch projects into HTML files, zip archives, or executable programs for Windows, macOS, and Linux.

## Development

Install dependencies:

```
npm ci
```

Start in development mode:

```
npm start
```

Then visit http://localhost:8947. Manually refresh to see changes.

Packaged projects generated while in development mode should not be distributed. Instead, you should run a production build to significantly reduce file size of both the website and the packager.

```
npm run build-prod
```

Output will be located in the `dist` folder.

The general layout of `src` is:

 - packager: The code that downloads and packages projects.
 - p4: The Svelte website for the packager. "p4" is the name that the packager uses internally to refer to itself.
 - scaffolding: A minimal Scratch project player. Handles most of the boring details of running Scratch projects like handling mouse inputs.
 - common: Some files used by both scaffolding and the packager.
 - addons: Optional addons such as gamepad support or pointerlock.
 - locales: Translations. en.json contains the original English messages. The other languages are translated by volunteers. ([you can help](https://docs.turbowarp.org/translate))
 - build: Various build-time scripts such as webpack plugins and loaders.

## Tips for forks

**Changing Scratch internals**: If you want to change the VM/renderer/etc. used, just `npm install` or `npm link` a different scratch-vm/scratch-render/etc and rebuild. You can even install a vanilla scratch-vm and all core functionality will still work (but optional features such as interpolation, high quality pen, stage size, etc. may not work)

**Deploying**: The packager is deployed as a simple static website. You can host it anywhere by just copying the `dist` folder after a build. We use GitHub Actions to deploy to GitHub Pages by running the "Deploy" workflow whenever we want to push to production (Actions > Deploy > Run workflow). This should be automatically available in forks after enabling GitHub Actions.

**Branding**: If you want to rebrand the packager for a different Scratch fork, the bare minimum changes to make are:

 - Update the brand strings (`src/packager/brand.js`) to use your own name and links.
 - Update the privacy policy (`static/privacy.html`) to reflect your privacy practices.

**Common problems**: 

 - Sometimes when you `npm install` a package here, npm breaks and packages don't install properly. To fix this just run `npm install` and everything should get fixed.

**Large files**: Large files such as NW.js, Electron, and WKWebView executables are stored on an external server outside of this repository. While we aren't actively removing old files (the server still serves files unused since November 2020), we can't promise they will exist forever. Forks are free to use our servers, but it's easy to setup your own if you'd prefer (it's just a static file server; see `src/packager/large-assets.js` for more information).

**Service worker**: Set the environment variable `ENABLE_SERVICE_WORKER` to `1` to enable service worker for offline support (experimental, not 100% reliable). Not recommended in development. Automatically used by the GitHub Actions deploy script.

## Standalone builds

To make a production standalone build:

```
npm run build-standalone-prod
```

Output will be located in `dist/standalone.html`.

## License

<!-- Make sure to also update COPYRIGHT_NOTICE in src/packager/brand.js -->

Copyright (C) 2021 Thomas Weber

This project is licensed under the GNU Lesser General Public License version 3. See COPYING and COPYING.LESSER for more information. We believe that packaging a project using the packager "makes use of an interface provided by the Library, but which is not otherwise based on the Library"
