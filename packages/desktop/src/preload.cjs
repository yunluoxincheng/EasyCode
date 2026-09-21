/* EasyCode 预加载脚本：以最小白名单 API 暴露给渲染进程（contextIsolation 下唯一通道） */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listenerWrapper = (listener) => (_event, payload) => listener(payload);

contextBridge.exposeInMainWorld('easycode', {
  invoke: (method, args) => ipcRenderer.invoke('easycode', method, args),
  onEvent: (listener) => {
    const wrapped = listenerWrapper(listener);
    ipcRenderer.on('easycode:event', wrapped);
    return wrapped;
  },
  offEvent: (listener) => ipcRenderer.removeListener('easycode:event', listener),
  /* 文件拖拽（TODOS #20）：HTML5 drop 的 File 对象取回绝对路径 */
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
