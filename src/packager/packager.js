import * as Comlink from 'comlink';
import ChecksumWorker from 'worker-loader?name=checksum.worker.js!./checksum.worker.js'
import defaultIcon from './default-icon.png';
import {readAsArrayBuffer, readAsURL} from './lib/readers';
import largeAssets from './large-assets';
import xhr from './lib/xhr';
import pngToAppleICNS from './lib/icns';
import assetCache from './cache';

const PROGRESS_LOADED_SCRIPTS = 0.1;
const PROGRESS_LOADED_JSON_BUT_NEED_ASSETS = 0.2;
const PROGRESS_FETCHED_INLINE_DATA_BUT_NOT_LOADED = 0.9;

const escapeXML = (v) => v.replace(/["'<>&]/g, (i) => {
  switch (i) {
    case '"': return '&quot;';
    case '\'': return '&apos;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '&': return '&amp;';
  }
});

const sha256 = async (buffer) => {
  const worker = new ChecksumWorker();
  const wrap = Comlink.wrap(worker);
  const hash = await wrap.sha256(buffer);
  worker.terminate();
  return hash;
};

const getJSZip = async () => (await import(/* webpackChunkName: "jszip" */ 'jszip')).default;

const setFileFast = (zip, path, data) => {
  zip.files[path] = data;
};

const getAppIcon = async (icon) => {
  if (!icon) {
    const blob = await xhr({
      url: defaultIcon,
      type: 'blob'
    });
    return {
      data: blob,
      name: 'icon.png'
    };
  }
  return {
    data: await readAsArrayBuffer(icon),
    name: icon.name || 'icon.png'
  };
};

const COPYRIGHT_HEADER = `/*!
* Copyright (C) 2021 Thomas Weber
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Lesser General Public License version 3
* as published by the Free Software Foundation.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Lesser General Public License for more details.
*
* You should have received a copy of the GNU Lesser General Public License
* along with this program. If not, see <https://www.gnu.org/licenses/>.
*/\n`;

class Packager extends EventTarget {
  constructor () {
    super();
    this.project = null;
    this.options = Packager.DEFAULT_OPTIONS();
  }

  async fetchLargeAsset (name) {
    const asset = largeAssets[name];
    if (!asset) {
      throw new Error(`Invalid asset: ${name}`);
    }
    const dispatchProgress = (progress) => this.dispatchEvent(new CustomEvent('large-asset-fetch', {
      detail: {
        asset: name,
        progress
      }
    }));
    dispatchProgress(0);
    let result;
    let cameFromCache = false;
    try {
      const cached = await assetCache.get(asset);
      if (cached) {
        result = cached;
        cameFromCache = true;
        dispatchProgress(0.5);
      }
    } catch (e) {
      console.warn(e);
    }
    if (!result) {
      let url = asset.src;
      if (asset.cacheBuster) {
        url += `?${assetCache.getCacheBuster()}`;
      }
      result = await xhr({
        url,
        type: asset.type,
        estimatedSize: asset.estimatedSize,
        progressCallback: (progress) => {
          dispatchProgress(progress);
        }
      });
    }
    if (asset.sha256) {
      const hash = await sha256(result);
      if (hash !== asset.sha256) {
        throw new Error(`Hash mismatch for ${name}, found ${hash} but expected ${asset.sha256}`);
      }
    }
    if (!cameFromCache) {
      try {
        await assetCache.set(asset, result);
      } catch (e) {
        console.warn(e);
      }
    }
    dispatchProgress(1);
    return result;
  }

  async loadResources () {
    const texts = [COPYRIGHT_HEADER];
    texts.push(await this.fetchLargeAsset('scaffolding'));
    if (this.options.chunks.gamepad) {
      texts.push(await this.fetchLargeAsset('addons'));
    }
    this.script = texts.join('\n').replace(/<\/script>/g,"</scri'+'pt>");
  }

  async addNwJS (projectZip) {
    const nwjsBuffer = await this.fetchLargeAsset(this.options.target);
    const nwjsZip = await (await getJSZip()).loadAsync(nwjsBuffer);

    const isMac = this.options.target === 'nwjs-mac';
    const isWindows = this.options.target.startsWith('nwjs-win');

    // NW.js Windows folder structure:
    // * (root)
    // +-- nwjs-v0.49.0-win-x64
    //   +-- nw.exe (executable)
    //   +-- credits.html
    //   +-- (project data)
    //   +-- ...

    // NW.js macOS folder structure:
    // * (root)
    // +-- nwjs-v0.49.0-osx-64
    //   +-- credits.html
    //   +-- nwjs.app
    //     +-- Contents
    //       +-- Resources
    //         +-- app.icns (icon)
    //         +-- app.nw
    //           +-- (project data)
    //       +-- MacOS
    //         +-- nwjs (executable)
    //       +-- ...

    // the first folder, something like "nwjs-v0.49.0-win-64"
    const nwjsPrefix = Object.keys(nwjsZip.files)[0].split('/')[0];

    const zip = new (await getJSZip());

    const packageName = this.options.app.packageName;

    // Copy NW.js files to the right place
    for (const path of Object.keys(nwjsZip.files)) {
      const file = nwjsZip.files[path];

      let newPath = path.replace(nwjsPrefix, packageName);
      if (isMac) {
        newPath = newPath.replace('nwjs.app', `${packageName}.app`);
      } else if (isWindows) {
        newPath = newPath.replace('nw.exe', `${packageName}.exe`);
      }

      setFileFast(zip, newPath, file);
    }

    const icon = await getAppIcon(this.options.app.icon);
    const manifest = {
      name: packageName,
      main: 'index.html',
      window: {
        width: this.options.stageWidth,
        height: this.options.stageHeight,
        icon: icon.name
      }
    };

    let dataPrefix;
    if (isMac) {
      const icnsData = await pngToAppleICNS(icon.data);
      zip.file(`${packageName}/${packageName}.app/Contents/Resources/app.icns`, icnsData);
      dataPrefix = `${packageName}/${packageName}.app/Contents/Resources/app.nw/`;
    } else {
      dataPrefix = `${packageName}/`;
    }

    // Copy project files and extra NW.js files to the right place
    for (const path of Object.keys(projectZip.files)) {
      setFileFast(zip, dataPrefix + path, projectZip.files[path]);
    }
    zip.file(dataPrefix + icon.name, icon.data);
    zip.file(dataPrefix + 'package.json', JSON.stringify(manifest, null, 4));

    return zip;
  }

  makeWebSocketProvider () {
    return `new Scaffolding.Cloud.WebSocketProvider(${JSON.stringify(this.options.cloudVariables.cloudHost)}, "${this.options.projectId}")`;
  }

  makeLocalStorageProvider () {
    return `new Scaffolding.Cloud.LocalStorageProvider()`;
  }

  makeCustomProvider () {
    const variables = this.options.cloudVariables.custom;
    let result = '{const providers = {};\n';
    for (const provider of new Set(Object.values(variables))) {
      if (provider === 'ws') {
        result += `providers.ws = ${this.makeWebSocketProvider()};\n`;
      } else if (provider === 'local') {
        result += `providers.local = ${this.makeLocalStorageProvider()};\n`;
      }
    }
    result += 'for (const provider of Object.values(providers)) scaffolding.addCloudProvider(provider);\n';
    for (const variableName of Object.keys(variables)) {
      const providerToUse = variables[variableName];
      result += `scaffolding.addCloudProviderOverride(${JSON.stringify(variableName)}, providers[${JSON.stringify(providerToUse)}] || null);\n`;
    }
    result += '}';
    return result;
  }

  generateFilename (extension) {
    return `${this.options.app.windowTitle}.${extension}`;
  }

  async generateGetProjectData () {
    if (this.options.target === 'html') {
      const url = await readAsURL(this.project.blob);
      return `
      setProgress(${PROGRESS_FETCHED_INLINE_DATA_BUT_NOT_LOADED});
      const getProjectData = () => fetch(${JSON.stringify(url)})
        .then((r) => r.arrayBuffer())
        .then((buffer) => {
          setProgress(1);
          return buffer;
        });`;
    }
    let src;
    let progressWeight;
    if (this.project.type === 'blob' || this.options.target === 'zip-one-asset') {
      src = './project.zip';
      progressWeight = 1 - PROGRESS_LOADED_SCRIPTS;
    } else {
      src = './assets/project.json';
      progressWeight = PROGRESS_LOADED_JSON_BUT_NEED_ASSETS - PROGRESS_LOADED_SCRIPTS;
    }
    return `const getProjectData = () => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.onload = () => {
        resolve(xhr.response);
      };
      xhr.onerror = () => {
        reject(new Error("Request to load project data failed."));
      };
      xhr.onprogress = (e) => {
        if (e.lengthComputable) {
          setProgress(${PROGRESS_LOADED_SCRIPTS} + (e.loaded / e.total) * ${progressWeight});
        }
      };
      xhr.responseType = "arraybuffer";
      xhr.open("GET", ${JSON.stringify(src)});
      xhr.send();
    });`;
  }

  async generateFavicon () {
    if (this.options.app.icon === null) {
      return '<!-- no favicon -->';
    }
    const data = await readAsURL(this.options.app.icon);
    return `<link id="favicon" rel="icon" href="${data}" type="image/png" sizes="16x16">`;
  }

  async package () {
    await this.loadResources();
    const html = `<!DOCTYPE html>
<!-- Created with https://packager.turbowarp.org/ -->
<html>
<head>
  <meta charset="utf8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <!-- We only include this to explicitly loosen the CSP of various packager environments. It does not provide any security. -->
  <meta http-equiv="Content-Security-Policy" content="default-src * 'self' 'unsafe-inline' 'unsafe-eval' data: blob:">
  <title>${escapeXML(this.options.app.windowTitle)}</title>
  <style>
    body {
      background-color: ${this.options.appearance.background};
      color: ${this.options.appearance.foreground};
      font-family: sans-serif;
      overflow: hidden;
    }
    [hidden] {
      display: none !important;
    }
    h1 {
      font-weight: normal;
    }
    a {
      color: inherit;
      text-decoration: underline;
      cursor: pointer;
    }

    #app, #loading, #error, #launch {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    .screen {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      cursor: default;
      user-select: none;
      background-color: ${this.options.appearance.background};
    }
    #launch {
      background-color: rgba(0, 0, 0, 0.7);
      cursor: pointer;
    }
    .green-flag {
      width: 80px;
      height: 80px;
      padding: 16px;
      border-radius: 100%;
      background: rgba(255, 255, 255, 0.75);
      border: 3px solid hsla(0, 100%, 100%, 1);
      display: flex;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
    }
    .progress-bar-outer {
      border: 1px solid currentColor;
      height: 10px;
      width: 200px;
      max-width: 200px;
    }
    .progress-bar-inner {
      height: 100%;
      width: 0;
      background-color: currentColor;
    }
    .loading-text {
      font-weight: normal;
      font-size: 36px;
      margin: 0 0 16px;
    }
    .control-button {
      width: 2rem;
      height: 2rem;
      padding: 0.375rem;
      border-radius: 0.25rem;
      margin-top: 0.5rem;
      margin-bottom: 0.5rem;
      user-select: none;
      cursor: pointer;
      border: 0;
      border-radius: 4px;
    }
    .control-button:hover {
      background: ${this.options.appearance.accent}26;
    }
    .control-button.active {
      background: ${this.options.appearance.accent}59;
    }
    .fullscreen-button {
      background: white !important;
    }
    .standalone-fullscreen-button {
      position: absolute;
      top: 0;
      right: 0;
      background-color: rgba(0, 0, 0, 0.5);
      border-radius: 0 0 0 4px;
      padding: 4px;
      cursor: pointer;
    }
  </style>
  <meta name="theme-color" content="${this.options.appearance.background}">
  ${await this.generateFavicon()}
</head>
<body>
  <noscript>Enable JavaScript</noscript>

  <div id="app"></div>

  <div id="launch" class="screen" hidden title="Click to start" tabindex="0">
    <div class="green-flag">
      <svg viewBox="0 0 16.63 17.5" width="42" height="44">
        <defs><style>.cls-1,.cls-2{fill:#4cbf56;stroke:#45993d;stroke-linecap:round;stroke-linejoin:round;}.cls-2{stroke-width:1.5px;}</style></defs>
        <path class="cls-1" d="M.75,2A6.44,6.44,0,0,1,8.44,2h0a6.44,6.44,0,0,0,7.69,0V12.4a6.44,6.44,0,0,1-7.69,0h0a6.44,6.44,0,0,0-7.69,0"/>
        <line class="cls-2" x1="0.75" y1="16.75" x2="0.75" y2="0.75"/>
      </svg>
    </div>
  </div>

  <div id="loading" class="screen">
    ${this.options.loadingScreen.text ? `<h1 class="loading-text">${escapeXML(this.options.loadingScreen.text)}</h1>` : ''}
    <div class="progress-bar-outer"><div class="progress-bar-inner" id="loading-inner"></div></div>
  </div>

  <div id="error" class="screen" hidden>
    <h1>Error</h1>
    <p>See console for more information</p>
  </div>

  ${this.options.target === 'html' ? `<script>${this.script}</script>` : '<script src="script.js"></script>'}
  <script>
    const appElement = document.getElementById('app');
    const launchScreen = document.getElementById('launch');
    const loadingScreen = document.getElementById('loading');
    const loadingInner = document.getElementById('loading-inner');
    const errorScreen = document.getElementById('error');

    const scaffolding = new Scaffolding.Scaffolding();
    scaffolding.width = ${this.options.stageWidth};
    scaffolding.height = ${this.options.stageHeight};
    scaffolding.setup();
    scaffolding.appendTo(appElement);

    if (typeof ScaffoldingAddons !== "undefined") ScaffoldingAddons.run(scaffolding);

    const {storage, vm} = scaffolding;
    storage.addWebStore(
      [storage.AssetType.ImageVector, storage.AssetType.ImageBitmap, storage.AssetType.Sound],
      (asset) => new URL("./assets/" + asset.assetId + "." + asset.dataFormat, location).href
    );
    const setProgress = (progress) => {
      loadingInner.style.width = progress * 100 + "%";
    }
    storage.onprogress = (total, loaded) => {
      setProgress(${PROGRESS_LOADED_JSON_BUT_NEED_ASSETS} + (loaded / total) * ${1 - PROGRESS_LOADED_JSON_BUT_NEED_ASSETS});
    };
    setProgress(${PROGRESS_LOADED_SCRIPTS});

    scaffolding.setUsername(${JSON.stringify(this.options.username)}.replace(/#/g, () => Math.floor(Math.random() * 10)));

    ${this.options.cloudVariables.mode === 'ws' ?
      `scaffolding.addCloudProvider(${this.makeWebSocketProvider()})` :
      this.options.cloudVariables.mode === 'local' ?
      `scaffolding.addCloudProvider(${this.makeLocalStorageProvider()})` :
      this.options.cloudVariables.mode === 'custom' ?
      this.makeCustomProvider() :
      '/* no-op */'
    };

    if (${this.options.controls.greenFlag.enabled}) {
      const greenFlagButton = document.createElement("img");
      greenFlagButton.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16.63 17.5"><path d="M.75 2a6.44 6.44 0 017.69 0h0a6.44 6.44 0 007.69 0v10.4a6.44 6.44 0 01-7.69 0h0a6.44 6.44 0 00-7.69 0" fill="#4cbf56" stroke="#45993d" stroke-linecap="round" stroke-linejoin="round"/><path stroke-width="1.5" fill="#4cbf56" stroke="#45993d" stroke-linecap="round" stroke-linejoin="round" d="M.75 16.75v-16"/></svg>');
      greenFlagButton.className = 'control-button';
      greenFlagButton.addEventListener('click', () => {
        scaffolding.greenFlag();
      });
      scaffolding.addEventListener('PROJECT_RUN_START', () => {
        greenFlagButton.classList.add('active');
      });
      scaffolding.addEventListener('PROJECT_RUN_STOP', () => {
        greenFlagButton.classList.remove('active');
      });
      scaffolding.addControlButton({
        element: greenFlagButton,
        where: 'top-left'
      });
    }

    if (${this.options.controls.stopAll.enabled}) {
      const stopAllButton = document.createElement("img");
      stopAllButton.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path fill="#ec5959" stroke="#b84848" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" d="M4.3.5h5.4l3.8 3.8v5.4l-3.8 3.8H4.3L.5 9.7V4.3z"/></svg>');
      stopAllButton.className = 'control-button';
      stopAllButton.addEventListener('click', () => {
        scaffolding.stopAll();
      });
      scaffolding.addControlButton({
        element: stopAllButton,
        where: 'top-left'
      });
    }

    if (${this.options.controls.fullscreen.enabled} && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
      let isFullScreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
      const fullscreenButton = document.createElement('img');
      fullscreenButton.className = 'control-button fullscreen-button';
      fullscreenButton.addEventListener('click', () => {
        if (isFullScreen) {
          if (document.exitFullscreen) {
            document.exitFullscreen();
          } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
          }
        } else {
          if (document.body.requestFullscreen) {
            document.body.requestFullscreen()
          } else if (document.body.webkitRequestFullscreen) {
            document.body.webkitRequestFullscreen();
          }
        }
      });
      const otherControlsExist = ${this.options.controls.greenFlag.enabled || this.options.controls.stopAll.enabled};
      const fillColor = otherControlsExist ? '#575E75' : '${this.options.appearance.foreground}';
      const updateFullScreen = () => {
        isFullScreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (isFullScreen) {
          fullscreenButton.src = 'data:image/svg+xml,' + encodeURIComponent('<svg width="20" height="20" xmlns="http://www.w3.org/2000/svg"><g fill="' + fillColor + '" fill-rule="evenodd"><path d="M12.662 3.65l.89.891 3.133-2.374a.815.815 0 011.15.165.819.819 0 010 .986L15.467 6.46l.867.871c.25.25.072.664-.269.664L12.388 8A.397.397 0 0112 7.611V3.92c0-.341.418-.514.662-.27M7.338 16.35l-.89-.89-3.133 2.374a.817.817 0 01-1.15-.166.819.819 0 010-.985l2.37-3.143-.87-.871a.387.387 0 01.27-.664L7.612 12a.397.397 0 01.388.389v3.692a.387.387 0 01-.662.27M7.338 3.65l-.89.891-3.133-2.374a.815.815 0 00-1.15.165.819.819 0 000 .986l2.37 3.142-.87.871a.387.387 0 00.27.664L7.612 8A.397.397 0 008 7.611V3.92a.387.387 0 00-.662-.27M12.662 16.35l.89-.89 3.133 2.374a.817.817 0 001.15-.166.819.819 0 000-.985l-2.368-3.143.867-.871a.387.387 0 00-.269-.664L12.388 12a.397.397 0 00-.388.389v3.692c0 .342.418.514.662.27"/></g></svg>');
        } else {
          fullscreenButton.src = 'data:image/svg+xml,' + encodeURIComponent('<svg width="20" height="20" xmlns="http://www.w3.org/2000/svg"><g fill="' + fillColor + '" fill-rule="evenodd"><path d="M16.338 7.35l-.89-.891-3.133 2.374a.815.815 0 01-1.15-.165.819.819 0 010-.986l2.368-3.142-.867-.871a.387.387 0 01.269-.664L16.612 3a.397.397 0 01.388.389V7.08a.387.387 0 01-.662.27M3.662 12.65l.89.89 3.133-2.374a.817.817 0 011.15.166.819.819 0 010 .985l-2.37 3.143.87.871c.248.25.071.664-.27.664L3.388 17A.397.397 0 013 16.611V12.92c0-.342.418-.514.662-.27M3.662 7.35l.89-.891 3.133 2.374a.815.815 0 001.15-.165.819.819 0 000-.986L6.465 4.54l.87-.871a.387.387 0 00-.27-.664L3.388 3A.397.397 0 003 3.389V7.08c0 .341.418.514.662.27M16.338 12.65l-.89.89-3.133-2.374a.817.817 0 00-1.15.166.819.819 0 000 .985l2.368 3.143-.867.871a.387.387 0 00.269.664l3.677.005a.397.397 0 00.388-.389V12.92a.387.387 0 00-.662-.27"/></g></svg>');
        }
      };
      updateFullScreen();
      document.addEventListener('fullscreenchange', updateFullScreen);
      document.addEventListener('webkitfullscreenchange', updateFullScreen);
      if (otherControlsExist) {
        fullscreenButton.className = 'control-button fullscreen-button';
        scaffolding.addControlButton({
          element: fullscreenButton,
          where: 'top-right'
        });
      } else {
        fullscreenButton.className = 'standalone-fullscreen-button';
        document.body.appendChild(fullscreenButton);
      }
    }

    vm.setTurboMode(${this.options.turbo});
    vm.setInterpolation(${this.options.interpolation});
    vm.setFramerate(${this.options.framerate});
    vm.renderer.setUseHighQualityRender(${this.options.highQualityPen});
    vm.setRuntimeOptions({
      fencing: ${this.options.fencing},
      miscLimits: ${this.options.miscLimits},
      maxClones: ${this.options.maxClones},
    });
    vm.setCompilerOptions({
      enabled: ${this.options.compiler.enabled},
      warpTimer: ${this.options.compiler.warpTimer}
    });
  </script>
  <script>
    ${await this.generateGetProjectData()}

    const run = async () => {
      const projectData = await getProjectData();
      ${this.options.custom.js}
      await scaffolding.loadProject(projectData);
      setProgress(1);
      loadingScreen.hidden = true;
      if (${this.options.autoplay}) {
        scaffolding.start();
      } else {
        launchScreen.hidden = false;
        launchScreen.addEventListener('click', () => {
          launchScreen.hidden = true;
          scaffolding.start();
        });
        launchScreen.focus();
      }
    };

    const handleError = (error) => {
      console.error(error);
      errorScreen.hidden = false;
    };

    run().catch(handleError);

  </script>
</body>
</html>
`;

    if (this.options.target !== 'html') {
      let zip;
      if (this.project.type === 'sb3' && this.options.target !== 'zip-one-asset') {
        zip = await (await getJSZip()).loadAsync(this.project.blob);
        for (const file of Object.keys(zip.files)) {
          zip.files[`assets/${file}`] = zip.files[file];
          delete zip.files[file];
        }
      } else {
        zip = new (await getJSZip());
        zip.file('project.zip', this.project.blob);
      }
      zip.file('index.html', html);
      zip.file('script.js', this.script);

      if (this.options.target.startsWith('nwjs-')) {
        zip = await this.addNwJS(zip);
      }

      return {
        blob: await zip.generateAsync({
          type: 'blob',
          compression: 'DEFLATE',
          // Use UNIX permissions so that executable bits are properly set, which matters for NW.js macOS
          platform: 'UNIX'
        }, (meta) => {
          this.dispatchEvent(new CustomEvent('zip-progress', {
            detail: {
              progress: meta.percent / 100
            }
          }));
        }),
        filename: this.generateFilename('zip')
      };
    }
    return {
      blob: new Blob([html], {
        type: 'text/html'
      }),
      filename: this.generateFilename('html')
    };
  }
}

Packager.getDefaultPackageNameFromTitle = (title) => {
  // Remove file extension
  title = title.split('.')[0];
  title = title.replace(/[^\-a-z ]/gi, '');
  title = title.trim();
  title = title.replace(/ /g, '-');
  return title.toLowerCase() || 'packaged-project';
};

Packager.getWindowTitleFromProjectTitle = (title) => {
  title = title.trim();
  title = title.split('.')[0];
  return title || 'Packaged Project';
};

Packager.DEFAULT_OPTIONS = () => ({
  turbo: false,
  interpolation: false,
  framerate: 30,
  highQualityPen: false,
  maxClones: 300,
  fencing: true,
  miscLimits: true,
  stageWidth: 480,
  stageHeight: 360,
  autoplay: false,
  username: 'player####',
  custom: {
    js: ''
  },
  appearance: {
    background: '#000000',
    foreground: '#ffffff',
    accent: '#ff4c4c'
  },
  loadingScreen: {
    text: ''
  },
  controls: {
    greenFlag: {
      enabled: false,
    },
    stopAll: {
      enabled: false,
    },
    fullscreen: {
      enabled: false
    }
  },
  compiler: {
    enabled: true,
    warpTimer: false
  },
  target: 'html',
  app: {
    icon: null,
    packageName: Packager.getDefaultPackageNameFromTitle(''),
    windowTitle: Packager.getWindowTitleFromProjectTitle('')
  },
  chunks: {
    gamepad: false
  },
  cloudVariables: {
    mode: 'ws',
    id: 0,
    cloudHost: 'wss://clouddata.turbowarp.org',
    custom: {}
  }
});

export default Packager;
