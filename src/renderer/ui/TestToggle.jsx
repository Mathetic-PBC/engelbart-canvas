import Button from './Button.jsx';

/** The one control that exists on every screen: test mode on/off, fixed top-right. */
export default function TestToggle({ testMode, onToggle, busy }) {
  return (
    <div style={{ position: 'fixed', top: 14, right: 16, zIndex: 200, display: 'flex', alignItems: 'center', gap: 10 }}>
      <Button caps size="sm" variant={testMode ? 'filled' : 'outline'} disabled={busy} onClick={onToggle} title={testMode ? 'Test mode is on — everything lives in ~/.engelbart/test' : 'Test mode is off'}>
        Test · {testMode ? 'on' : 'off'}
      </Button>
    </div>
  );
}
