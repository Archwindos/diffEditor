import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopAPI, WireReply } from '../shared/contracts';
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply: WireReply = await ipcRenderer.invoke(channel, ...args);
  if (!reply.ok) throw new Error(reply.error);
  return reply.result as T;
}
function listen(channel: string, callback: () => void): () => void {
  const handler = () => callback();
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
const api: DesktopAPI = {
  getSettings: () => call('settings:get'),
  setSettings: settings => call('settings:set', settings),
  list: () => call('review:list'),
  pickFiles: (mode, encoding) => call('review:pick', mode, encoding),
  openFiles: request => call('review:open', request),
  createTextReview: () => call('review:new-text'),
  setReviewClosed: (reviewId, closed) => call('review:set-closed', reviewId, closed),
  deleteReview: reviewId => call('review:delete', reviewId),
  deleteClosedReviews: reviewIds => call('review:delete-closed', reviewIds),
  updateDraft: request => call('review:update', request),
  prepareSave: request => call('review:prepare', request),
  commitSave: token => call('review:commit', token),
  continueTarget: (reviewId, targetId) => call('review:continue', reviewId, targetId),
  rejectReview: reviewId => call('review:reject', reviewId),
  showInFolder: filePath => call('review:show', filePath),
  getFilePath: file => webUtils.getPathForFile(file),
  onChanged: callback => listen('review:changed', callback),
  onSaveShortcut: callback => listen('review:save-shortcut', callback),
  onBeforeClose: callback => listen('review:before-close', callback),
  readyToClose: () => ipcRenderer.send('review:ready-close'),
  onBeforeWithdraw: callback => {
    const handler = (_event: unknown, request: Parameters<typeof callback>[0]) => callback(request);
    ipcRenderer.on('review:before-withdraw', handler);
    return () => ipcRenderer.removeListener('review:before-withdraw', handler);
  },
  withdrawReady: (token, error) => ipcRenderer.send('review:withdraw-ready', token, error),
  onWithdrawFinished: callback => {
    const handler = (_event: unknown, result: Parameters<typeof callback>[0]) => callback(result);
    ipcRenderer.on('review:withdraw-finished', handler);
    return () => ipcRenderer.removeListener('review:withdraw-finished', handler);
  },
};
contextBridge.exposeInMainWorld('diffEditor', api);
