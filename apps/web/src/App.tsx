import { useState, useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { LeftPanel } from './components/LeftPanel';
import { MapView } from './components/MapView';
import { RightPanel } from './components/RightPanel';
import { BottomBar } from './components/BottomBar';
import { CyberWindow } from './components/CyberWindow';
import { ErrorBoundary } from './components/ErrorBoundary';
import { connectWs } from './lib/store';

export function App() {
  const [cyberOpen, setCyberOpen] = useState(false);
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
        <BottomBar onCyberOpen={() => setCyberOpen(true)} />
        <CyberWindow open={cyberOpen} onClose={() => setCyberOpen(false)} />
      </div>
    </ErrorBoundary>
  );
}
