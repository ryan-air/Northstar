import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Northstar UI error', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#d7e2ec', fontFamily: 'IBM Plex Sans, sans-serif' }}>
          <h1 style={{ color: '#e05252' }}>Northstar UI error</h1>
          <p>{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
              location.reload();
            }}
            style={{
              marginTop: 12,
              padding: '8px 14px',
              background: '#1c2833',
              color: '#3dd6c6',
              border: '1px solid #2a3a48',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
