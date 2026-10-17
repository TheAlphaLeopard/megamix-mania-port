(function () {
  var DATA_FILE = "RSDKv5U.data";
  var DATA_MANIFEST_URL = DATA_FILE + ".manifest.json";
  var DIRECT_DATA_URL = DATA_FILE;
  var WASM_FILE = "RSDKv5U.wasm";

  var qs = new URLSearchParams(window.location.search);

  /* --- [mmx-web] base-prefix support -------------------------------------
   * window.__MMX_BASE__ (set by index.html/cdn.html) is prefixed onto every
   * file this loader fetches itself (manifest, data parts). Empty string =
   * plain relative paths, i.e. identical to the original standalone behavior.
   * ---------------------------------------------------------------------- */
  function mmxJoin(u) { return (window.__MMX_BASE__ || "") + u; }
  var dataOverride = qs.get("data");

  var ui = {
    overlay: null,
    progress: null,
    statusText: null,
  };

  function setupUI() {
    ui.overlay = document.getElementById("loader-overlay");
    ui.progress = document.getElementById("loader-progress");
    ui.statusText = document.getElementById("loader-status");
  }

  function setStatus(text) {
    if (ui.statusText) ui.statusText.textContent = text;
  }

  function setProgress(loaded, total) {
    if (!ui.progress) return;
    var fill = ui.progress.firstElementChild;
    if (!fill) return;
    if (total > 0) {
      var pct = (loaded / total) * 100;
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      fill.style.width = pct + "%";
    }
  }

  function hasDecompressionStream() {
    return typeof DecompressionStream !== "undefined";
  }

  async function gunzipStream(response) {
    if (!response.body || !hasDecompressionStream()) {
      throw new Error("DecompressionStream unavailable; cannot ungzip");
    }
    var decompressed = response.body.pipeThrough(new DecompressionStream("gzip"));
    var reader = decompressed.getReader();
    var chunks = [];
    var total = 0;
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      total += r.value.byteLength;
    }
    var out = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].byteLength;
    }
    return out;
  }

  /* Retry helper: CDNs (jsDelivr/Fastly in particular) intermittently serve
   * transient 403/5xx on large-object fetches. Retry with backoff instead of
   * failing the whole load. */
  var RETRY_DELAYS_MS = [800, 2000, 4500, 9000, 15000];
  function wait(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }
  async function fetchRetry(url, opts, label) {
    var lastErr = null;
    for (var attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        var r = await fetch(url, opts || {});
        if (r.ok) return r;
        lastErr = new Error("fetch " + (label || url) + " failed: " + r.status);
        // 404 = really missing, don't hammer the CDN
        if (r.status === 404) throw lastErr;
      } catch (e) {
        lastErr = e;
        if (e && e.message && e.message.indexOf("failed: 404") !== -1) throw e;
      }
      if (attempt < RETRY_DELAYS_MS.length) {
        console.warn("[dataloader] " + (label || url) + " attempt " + (attempt + 1) + " failed, retrying in " + RETRY_DELAYS_MS[attempt] + "ms");
        await wait(RETRY_DELAYS_MS[attempt]);
      }
    }
    throw lastErr;
  }

  async function headOk(url) {
    try {
      var r = await fetchRetry(url, { method: "HEAD", cache: "no-cache" }, "HEAD " + url);
      return r.ok;
    } catch (e) {
      return false;
    }
  }

  async function fetchWithProgress(url, onProgress, expectedSize) {
    // DISABLED 2026-05-22: gzip path same as tryLoadGzippedWasm below.
    // Force useGz=false until corruption root cause is fixed. GH Pages'
    // Fastly CDN auto-gzips via Content-Encoding so we lose nothing.
    var useGz = false;
    // var gzUrl = url + ".gz";
    // if (hasDecompressionStream()) {
    //   try {
    //     var probe = await fetch(gzUrl, { method: "HEAD", cache: "no-cache" });
    //     useGz = probe.ok;
    //   } catch (e) { useGz = false; }
    // }

    var actualUrl = url;
    var resp = await fetchRetry(actualUrl, {}, "chunk " + url);
    if (!resp.ok) throw new Error("fetch " + actualUrl + " failed: " + resp.status);

    if (useGz) {
      var bytes = await gunzipStream(resp);
      onProgress(bytes.byteLength, bytes.byteLength);
      return bytes;
    }

    var total = parseInt(resp.headers.get("Content-Length") || expectedSize || "0", 10);
    if (!resp.body || !resp.body.getReader) {
      var buf = new Uint8Array(await resp.arrayBuffer());
      onProgress(buf.byteLength, buf.byteLength);
      return buf;
    }
    var reader = resp.body.getReader();
    var chunks = [];
    var received = 0;
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      received += r.value.byteLength;
      onProgress(received, total);
    }
    var out = new Uint8Array(received);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].byteLength;
    }
    return out;
  }

  async function buildBlobFromManifest(manifest) {
    var totalBytes = manifest.totalSize || 0;
    var assembled = new Uint8Array(totalBytes);
    var written = 0;
    for (var i = 0; i < manifest.parts.length; i++) {
      var part = manifest.parts[i];
      setStatus("downloading part " + (i + 1) + "/" + manifest.parts.length + ": " + part.name);
      var bytes = await fetchWithProgress(mmxJoin(part.name), function (loaded, total) {
        setProgress(written + loaded, totalBytes);
      }, part.size);
      if (part.size && bytes.byteLength !== part.size) {
        throw new Error(
          "chunk size mismatch for " + part.name +
          " (expected " + part.size + " bytes, got " + bytes.byteLength + ")"
        );
      }
      assembled.set(bytes, written);
      written += bytes.byteLength;
    }
    setProgress(totalBytes, totalBytes);
    setStatus(DATA_FILE + " assembled (" + (totalBytes / 1048576).toFixed(1) + " MB), starting engine...");
    var blob = new Blob([assembled], { type: "application/octet-stream" });
    return URL.createObjectURL(blob);
  }

  async function resolveDataUrl() {
    setupUI();

    if (dataOverride) {
      setStatus("downloading from override URL...");
      var bytes = await fetchWithProgress(dataOverride, function (loaded, total) {
        setProgress(loaded, total);
        setStatus(
          "downloading override: " +
            (loaded / 1048576).toFixed(1) +
            " / " +
            (total / 1048576).toFixed(1) +
            " MB"
        );
      });
      var blob = new Blob([bytes], { type: "application/octet-stream" });
      return URL.createObjectURL(blob);
    }

    setStatus("locating " + DATA_FILE + "...");
    if (await headOk(mmxJoin(DIRECT_DATA_URL))) {
      setStatus(DATA_FILE + " ready, starting engine...");
      return DIRECT_DATA_URL;
    }

    if (await headOk(mmxJoin(DATA_MANIFEST_URL))) {
      var manifestResp = await fetchRetry(mmxJoin(DATA_MANIFEST_URL), { cache: "no-cache" }, "manifest");
      var manifest = await manifestResp.json();
      if (!manifest || !Array.isArray(manifest.parts) || manifest.parts.length === 0) {
        throw new Error("manifest is empty or malformed");
      }
      return await buildBlobFromManifest(manifest);
    }

    throw new Error("neither " + DATA_FILE + " nor " + DATA_MANIFEST_URL + " was reachable");
  }

  async function tryLoadGzippedWasm() {
    // DISABLED 2026-05-22: this path produces corrupted wasm bytes (engine
    // crashes with "null function" inside WASM function-table calls). Root
    // cause unconfirmed but likely one of: PowerShell GZipStream vs browser
    // DecompressionStream incompatibility, Module.wasmBinary buffer-view
    // mismatch, or race with Emscripten's own fetch.
    // GH Pages' Fastly CDN auto-gzips application/wasm via Content-Encoding
    // anyway, so users get the bandwidth savings for free without this path.
    // To re-enable: remove this early return AND fix the corruption first.
    return null;
    /* original code preserved below for reference:
    if (qs.get("nogzip")) {
      console.log("[dataloader] nogzip=1 set, skipping gzipped wasm path");
      return null;
    }
    if (!hasDecompressionStream()) return null;
    try {
      var probe = await fetch(WASM_FILE + ".gz", { method: "HEAD", cache: "no-cache" });
      if (!probe.ok) return null;
    } catch (e) { return null; }

    setStatus("downloading engine (gzipped)...");
    try {
      var resp = await fetch(WASM_FILE + ".gz");
      if (!resp.ok) return null;
      var bytes = await gunzipStream(resp);
      setStatus("engine decompressed (" + (bytes.byteLength / 1048576).toFixed(1) + " MB), initializing...");
      return bytes;
    } catch (e) {
      console.warn("[dataloader] gzipped wasm load failed, falling back:", e);
      return null;
    }
    */
  }

  window.Module = window.Module || {};
  var Module = window.Module;

  Module.canvas = (function () {
    var c = document.getElementById("canvas");
    if (c) {
      c.addEventListener("webglcontextlost", function (e) {
        e.preventDefault();
        setStatus("WebGL context lost. Reload to recover.");
      }, false);
    }
    return c;
  })();

  Module.print = function (text) { console.log(text); };
  Module.printErr = function (text) { console.warn(text); };
  Module.setStatus = function (text) {
    if (!text) return;
    setStatus(text);
    var m = text.match(/\((\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\)/);
    if (m && parseFloat(m[2]) > 0) setProgress(parseFloat(m[1]), parseFloat(m[2]));
  };

  /* --- IDBFS save persistence ---
   * Sonic Mania writes UserDB and save files to its working directory. We mount
   * IndexedDB-backed storage at /idbfs so writes survive tab close. Engine sees
   * a regular filesystem; FS.syncfs flushes to IndexedDB on intervals. */
  Module.preRun = Module.preRun || [];
  Module.preRun.push(function () {
    if (qs.get("noidbfs")) {
      console.log("[dataloader] noidbfs=1 set, skipping IDBFS mount entirely");
      return;
    }
    console.log("[dataloader] mounting idbfs");
    try {
      FS.mkdir("/idbfs");
      FS.mount(IDBFS, {}, "/idbfs");
      console.log("[dataloader] idbfs mount ok");
    } catch (e) {
      console.warn("[dataloader] IDBFS mount failed (saves won't persist):", e);
      return;
    }
    Module.addRunDependency("idbfs-load");
    console.log("[dataloader] starting initial idbfs sync");
    FS.syncfs(true, function (err) {
      console.log("[dataloader] idbfs sync completed, err=", err);
      if (err) console.warn("[dataloader] IDBFS initial sync failed:", err);

      // Engine bug workaround: RSDKv5 looks for Data.rsdk at userFileDir + "Data.rsdk".
      // Our IDBFS patch set userFileDir="/idbfs/", so engine tries /idbfs/Data.rsdk
      // but Emscripten preloads Data.rsdk at /Data.rsdk (MEMFS root). Symlink bridges
      // the two. Without this, LoadDataPack fails, engine forces devMenu=true.
      try {
        // Check if symlink already exists (carried over from previous boot via IDBFS persistence)
        var existing = null;
        try { existing = FS.readlink("/idbfs/Data.rsdk"); } catch (e) {}
        if (!existing) {
          FS.symlink("/Data.rsdk", "/idbfs/Data.rsdk");
          console.log("[dataloader] symlinked /Data.rsdk -> /idbfs/Data.rsdk");
        } else {
          console.log("[dataloader] /idbfs/Data.rsdk symlink already exists ->", existing);
        }
      } catch (e) {
        if (e.code === "EEXIST") {
          console.log("[dataloader] /idbfs/Data.rsdk already exists (likely cached from prev boot)");
        } else {
          console.warn("[dataloader] Data.rsdk symlink failed:", e);
        }
      }

      /* Seed a default Settings.ini on first boot so the engine skips its
       * RSDKv5 Dev Menu and boots straight into Sonic Mania. The engine WILL
       * call SaveSettingsINI on first run (UserCore.cpp:556), but its fwrite
       * only hits the in-memory IDBFS overlay — never IndexedDB — unless JS
       * calls FS.syncfs(false). So next reload it looks "missing" again and
       * we re-enter the dev menu. We seed it here once and persist it. */
      if (qs.get("nosettingsseed")) {
        console.log("[dataloader] nosettingsseed=1 set, skipping Settings.ini seed");
        Module.removeRunDependency("idbfs-load");
        return;
      }
      if (qs.get("keepsettings")) {
        console.log("[dataloader] keepsettings=1 set, preserving existing /idbfs/Settings.ini");
        Module.removeRunDependency("idbfs-load");
        return;
      }
      /* FORCE-OVERWRITE on every boot until we have an INI parser to
       * surgically patch just the devMenu key. A previously-persisted
       * Settings.ini in IndexedDB (with devMenu=y, or written by the
       * engine's own SaveSettingsINI defaults) traps the user in the
       * Dev Menu otherwise. Losing user-customized settings each boot
       * is an acceptable tradeoff vs being stuck in the dev menu.
       * Escape hatch: append ?keepsettings=1 to the URL. */
      console.log("[dataloader] force-writing /idbfs/Settings.ini with devMenu=n");
      var defaultIni =
        "; Retro Engine Config File (seeded by dataloader.js)\n\n" +
        "[Game]\n" +
        "dataFile=Data.rsdk\n" +
        "devMenu=n\n" +
        "language=0\n" +
        "\n" +
        "[Video]\n" +
        "windowed=y\n" +
        "border=y\n" +
        "exclusiveFS=n\n" +
        "vsync=n\n" +
        "tripleBuffering=n\n" +
        "winWidth=424\n" +
        "winHeight=240\n" +
        "refreshRate=60\n" +
        "shaderSupport=y\n" +
        "screenShader=0\n" +
        "\n" +
        "[Audio]\n" +
        "streamsEnabled=y\n" +
        "streamVolume=0.800000\n" +
        "sfxVolume=1.000000\n";
      try {
        FS.writeFile("/idbfs/Settings.ini", defaultIni);
        FS.syncfs(false, function (err2) {
          if (err2) console.warn("[dataloader] Settings.ini persist failed:", err2);
          else console.log("[dataloader] Settings.ini persisted to IndexedDB");
          Module.removeRunDependency("idbfs-load");
        });
      } catch (writeErr) {
        console.warn("[dataloader] Settings.ini seed write failed:", writeErr);
        Module.removeRunDependency("idbfs-load");
      }
    });
  });

  function flushIdb() {
    if (typeof FS === "undefined" || !FS.syncfs) return;
    FS.syncfs(false, function (err) {
      if (err) console.warn("[dataloader] IDBFS flush failed:", err);
    });
  }
  window.addEventListener("beforeunload", flushIdb);
  window.addEventListener("pagehide", flushIdb);
  /* periodic safety flush so a crash doesn't lose progress */
  setInterval(flushIdb, 15000);

  Module.postRun = Module.postRun || [];
  Module.postRun.push(function () {
    console.log("[dataloader] postRun fired, engine ready");
    if (ui.overlay) ui.overlay.style.display = "none";
    document.body.classList.add("engine-ready");
  });

  window.__dataloaderReady = (async function () {
    try {
      var url = await resolveDataUrl();
      window.__RSDKv5_data_url = url;

      var wasmBytes = await tryLoadGzippedWasm();
      if (wasmBytes) {
        Module.wasmBinary = wasmBytes;
      }

      var prevLocateFile = Module.locateFile;
      Module.locateFile = function (path, prefix) {
        if (path === DATA_FILE || (typeof path === "string" && path.endsWith("/" + DATA_FILE))) {
          console.log("[dataloader] locateFile " + DATA_FILE + " ->", url);
          return url;
        }
        if (typeof prevLocateFile === "function") {
          return prevLocateFile(path, prefix);
        }
        return (prefix || "") + path;
      };
      return url;
    } catch (e) {
      setStatus("FATAL: " + e.message);
      console.error("[dataloader]", e);
      throw e;
    }
  })();
})();
