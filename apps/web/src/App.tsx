import { useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { LeftPanel } from './components/LeftPanel';
import { MapView } from './components/MapView';
import { RightPanel } from './components/RightPanel';
import { Timeline } from './components/Timeline';
import { ErrorBoundary } from './components/ErrorBoundary';
import { connectWs } from './lib/store';

export function App() {
  useEffect(() => connectWs(), []);

  return (
    <ErrorBoundary>
      <div className="app-shell">
        <TopBar />
        <div className="main-row">
          <LeftPanel />
          <ErrorBoundary>
            <MapView />
          </ErrorBoundary>
          <RightPanel />
        </div>
        <Timeline />
      </div>
    </ErrorBoundary>
  );
}
