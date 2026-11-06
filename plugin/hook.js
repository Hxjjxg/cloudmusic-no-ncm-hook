(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CloudmusicNoNCM = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const sourceExtension = (path) => {
    if (typeof path !== "string") return null;
    const match = /\.((?:mp3|flac))$/i.exec(path);
    return match ? match[1].toLowerCase() : null;
  };

  function rewriteParams(params) {
    if (!Array.isArray(params) || params.length < 5) return null;
    const [id, source, , , ext] = params;
    if (typeof id !== "string" || !/^track-.+-image$/.test(id)) return null;
    if (!ext || typeof ext !== "object" || Array.isArray(ext)) return null;
    if (ext.encrypt !== true || ext.decrypt) return null;
    const suffix = sourceExtension(source);
    if (!suffix || typeof ext.media_rel_path !== "string") return null;
    // A foreign hook may already have selected a different output path.
    if (!/\.ncm$/i.test(ext.media_rel_path)) return null;
    const next = params.slice();
    next[4] = {
      ...ext,
      encrypt: false,
      media_rel_path: ext.media_rel_path.replace(/\.ncm$/i, "." + suffix),
    };
    return next;
  }

  function createHook(options = {}) {
    const getChannel = options.getChannel || (() => globalThis.channel);
    const maxRecords = Number.isInteger(options.maxRecords) && options.maxRecords > 0
      ? options.maxRecords : 200;
    let enabled = options.enabled !== false;
    let captureUrls = options.captureUrls !== false;
    let binding = null;
    let disposed = false;
    let patched = 0;
    let dropped = 0;
    const records = [];

    function record(value) {
      records.push({ time: new Date().toISOString(), ...value });
      if (records.length > maxRecords) {
        records.shift();
        dropped++;
      }
      // Logging must never prevent native calls.
      if (typeof options.onEvent === "function") {
        try { options.onEvent({ ...records[records.length - 1] }); } catch (_) { }
      }
    }

    function install() {
      if (disposed) return false;
      if (binding) return true;
      const channel = getChannel();
      if (!channel || typeof channel.call !== "function") return false;
      const original = channel.call;
      function wrapped(...args) {
        let outgoing = args;
        try {
          const [command, , params] = args;
          if (command === "download.start" && captureUrls && Array.isArray(params)) {
            const item = params[0];
            if (item && typeof item.id === "string" && item.id.startsWith("track-") &&
                item.mediaType === 1 && typeof item.url === "string") {
              record({
                type: "download", id: item.id, url: item.url,
                relativePath: item.rel_path, size: item.size, md5: item.md5,
              });
            }
          }
          if (command === "storage.addid3" && enabled) {
            const next = rewriteParams(params);
            if (next) {
              outgoing = args.slice();
              outgoing[2] = next;
              patched++;
              record({
                type: "patch", id: params[0], source: params[1],
                before: { encrypt: params[4].encrypt, output: params[4].media_rel_path },
                after: { encrypt: next[4].encrypt, output: next[4].media_rel_path },
              });
            }
          }
        } catch (error) {
          // Unknown parameter layouts pass through unchanged.
          outgoing = args;
        }
        // Keep the original receiver, callback, extra arguments, return and errors.
        return Reflect.apply(original, this, outgoing);
      }
      channel.call = wrapped;
      if (channel.call !== wrapped) return false;
      binding = { channel, original, wrapped };
      return true;
    }

    function dispose() {
      enabled = false;
      captureUrls = false;
      disposed = true;
      if (binding && binding.channel.call === binding.wrapped) {
        binding.channel.call = binding.original;
        return true;
      }
      // If another plugin wraps us, stay inert instead of overwriting its hook.
      return !binding;
    }

    return {
      install,
      dispose,
      setEnabled(value) { if (!disposed) enabled = Boolean(value); },
      setCaptureUrls(value) { if (!disposed) captureUrls = Boolean(value); },
      clearRecords() { records.length = 0; dropped = 0; },
      getRecords() { return JSON.parse(JSON.stringify(records)); },
      status() {
        return {
          installed: Boolean(binding) && !disposed,
          outermost: Boolean(binding && binding.channel.call === binding.wrapped),
          disposed, enabled, captureUrls, patched, records: records.length, dropped,
        };
      },
    };
  }

  return { createHook };
});
