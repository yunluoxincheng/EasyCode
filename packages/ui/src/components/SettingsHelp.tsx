import type { ReactNode } from 'react';

/** 设置页低频说明：原生折叠语义支持键盘，不参与设置草稿。 */
export function SettingsHelp({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="settings-help">
      <summary>[ {title} ]</summary>
      <div className="settings-help-body">{children}</div>
    </details>
  );
}
