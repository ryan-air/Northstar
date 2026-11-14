import { CyberPanel } from './CyberPanel';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CyberWindow({ open, onClose }: Props) {
  if (!open) return null;

  return (
    <div className="cyber-window-overlay" onClick={onClose}>
      <div className="cyber-window" onClick={(e) => e.stopPropagation()}>
        <div className="cyber-window-header">
          <span
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--accent)',
            }}
          >
            Cyber
          </span>
          <button type="button" className="cyber-window-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cyber-window-body">
          <CyberPanel />
        </div>
      </div>
    </div>
  );
}
