import React from 'react';

interface State {
  error: Error | null;
}

/** 渲染期异常兜底：否则 React 会卸载整棵树，用户只能看到空白背景 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <pre
        style={{
          color: '#f87171',
          font: '12px/1.6 Consolas, monospace',
          padding: 24,
          whiteSpace: 'pre-wrap',
        }}
      >
        {`[ RENDER ERROR ]\n${error.stack ?? error.message}\n\n可尝试重新加载窗口（Ctrl+R）。`}
      </pre>
    );
  }
}
