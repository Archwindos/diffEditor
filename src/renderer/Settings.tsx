import React, { useEffect, useState } from 'react';
import type { AppSettings } from '../shared/contracts';

export function Settings({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy(true); setError('');
    void window.diffEditor.getSettings().then(value => {
      if (active) setSettings(value);
    }).catch(e => {
      if (active) { setSettings(undefined); setError(`无法读取设置：${e instanceof Error ? e.message : String(e)}`); }
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [open, reload]);

  const update = async (closeToTray: boolean) => {
    setBusy(true); setError('');
    try { setSettings(await window.diffEditor.setSettings({ closeToTray })); }
    catch (e) { setError(`设置未保存：${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  };

  return <section className="app-settings" aria-label="应用设置">
    <button className="settings-toggle" data-testid="settings-toggle" aria-expanded={open} aria-controls="settings-panel" disabled={disabled || busy} onClick={() => setOpen(!open)}>设置<span>{open ? '收起' : '展开'}</span></button>
    {open && <div id="settings-panel" className="settings-panel" data-testid="settings-panel" aria-busy={busy}>
      {settings && <label className="settings-choice"><input data-testid="close-to-tray" type="checkbox" checked={settings.closeToTray} disabled={disabled || busy} onChange={e => void update(e.target.checked)} /><span>关闭窗口后转到后台</span></label>}
      <p>开启后，点击叉号隐藏到右下角系统托盘。右键托盘图标可打开窗口或退出程序。</p>
      <div className="settings-status" role="status">{busy ? (settings ? '正在保存…' : '正在读取…') : settings && !error ? '设置已保存' : ''}</div>
      {error && <p className="settings-error" role="alert">{error}{!settings && <button disabled={disabled || busy} onClick={() => setReload(n => n + 1)}>重试</button>}</p>}
    </div>}
  </section>;
}
