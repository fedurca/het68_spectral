/*
 * The bridge between the renderer and the main process.
 *
 * Deliberately narrow: the renderer is the same code that runs in a browser, so it
 * gets exactly the handful of operations a browser cannot perform and nothing else.
 * No Node APIs, no ipcRenderer, no filesystem — a bug in the analysis code should not
 * be able to reach the machine.
 */

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("het68", {
  platform: process.platform,

  listAudioDevices: () => ipcRenderer.invoke("het68:list-audio-devices"),
  startCapture: (opts) => ipcRenderer.invoke("het68:start-capture", opts),
  stopCapture: () => ipcRenderer.invoke("het68:stop-capture"),
  captureStats: () => ipcRenderer.invoke("het68:capture-stats"),
  onCaptureBlock: (cb) => subscribe("het68:capture-block", cb),
  onCaptureLog: (cb) => subscribe("het68:capture-log", cb),

  listSerialPorts: () => ipcRenderer.invoke("het68:list-serial-ports"),
  startSerial: (opts) => ipcRenderer.invoke("het68:start-serial", opts),
  stopSerial: () => ipcRenderer.invoke("het68:stop-serial"),
  onSerialLine: (cb) => subscribe("het68:serial-line", cb),

  saveFile: (name, contents) =>
    ipcRenderer.invoke("het68:save-file", {
      name,
      // A Uint8Array survives structured clone, but its backing buffer is what the
      // main process needs to write, so it is normalised here rather than there.
      contents: typeof contents === "string" ? contents : Array.from(contents),
    }),
});
