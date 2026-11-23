'use client';

import { useState, type PointerEvent } from 'react';
import { getMesh, mediaError } from '@/lib/webrtc';
import { readPref, writePref } from '@/lib/util';
import { useRoom, type GateMode } from '@/store/room';

const GATE_LABELS: Record<GateMode, string> = { open: 'Always on', vad: 'Voice activity', ptt: 'Push to talk (hold Space)' };

export function CallBar() {
  const call = useRoom((s) => s.call);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState<'mic' | 'cam' | 'screen' | null>(null);

  async function run(which: 'mic' | 'cam' | 'screen', fn: () => Promise<unknown>) {
    setError(null);
    setBusy(which);
    try {
      await fn();
    } catch (err: unknown) {
      setError(mediaError(err));
    } finally {
      setBusy(null);
    }
  }

  function toggleMic() {
    const mesh = getMesh();
    if (!mesh) return;
    if (!call.mic && readPref('wp:headphonesHint') !== '1') {
      writePref('wp:headphonesHint', '1');
      setHint('Tip: use headphones so the movie audio doesn’t echo into your mic.');
    }
    void run('mic', () => mesh.setMic(!call.mic));
  }

  const holdDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    getMesh()?.setPushToTalk(true);
  };
  const holdUp = () => getMesh()?.setPushToTalk(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="icon-btn"
        aria-pressed={call.mic}
        aria-label={call.mic ? 'Mute microphone' : 'Turn on microphone'}
        title={call.mic ? 'Mute' : 'Unmute'}
        disabled={busy === 'mic'}
        onClick={toggleMic}
      >
        {call.mic ? '🎙️' : '🔇'}
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-pressed={call.cam}
        aria-label={call.cam ? 'Turn off camera' : 'Turn on camera'}
        disabled={busy === 'cam'}
        onClick={() => {
          const mesh = getMesh();
          if (mesh) void run('cam', () => mesh.setCam(!call.cam));
        }}
      >
        📷
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-pressed={call.screen}
        aria-label={call.screen ? 'Stop sharing your screen' : 'Share a tab or screen'}
        disabled={busy === 'screen'}
        onClick={() => {
          const mesh = getMesh();
          if (!mesh) return;
          if (call.screen) mesh.stopScreenShare();
          else void run('screen', () => mesh.startScreenShare());
        }}
      >
        🖥️
      </button>

      {call.mic && (
        <div className="flex flex-wrap items-center gap-2 pl-1">
          <label htmlFor="gate-mode" className="sr-only">
            Microphone mode
          </label>
          <select
            id="gate-mode"
            value={call.gateMode}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'open' || v === 'vad' || v === 'ptt') getMesh()?.setGateMode(v);
            }}
            className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs"
          >
            {(Object.keys(GATE_LABELS) as GateMode[]).map((m) => (
              <option key={m} value={m}>
                {GATE_LABELS[m]}
              </option>
            ))}
          </select>
          {call.gateMode === 'vad' && (
            <label className="flex items-center gap-2 text-[11px] text-zinc-400">
              Sensitivity
              <input
                type="range"
                min={-70}
                max={-20}
                step={1}
                value={call.vadThresholdDb}
                onChange={(e) => getMesh()?.setVadThreshold(Number(e.target.value))}
                aria-label="Voice activity threshold (dBFS)"
                className="h-1 w-24 cursor-pointer accent-screen [direction:rtl]"
              />
            </label>
          )}
          {call.gateMode === 'ptt' && (
            <button
              type="button"
              className="pressable select-none rounded-full bg-white/[0.06] px-3 py-1.5 text-xs font-medium active:bg-screen active:text-ink-950"
              onPointerDown={holdDown}
              onPointerUp={holdUp}
              onPointerCancel={holdUp}
              onContextMenu={(e) => e.preventDefault()}
            >
              Hold to talk
            </button>
          )}
          <span
            className={`h-2.5 w-2.5 rounded-full transition-colors duration-100 ${call.talking ? 'bg-signal-live' : 'bg-white/15'}`}
            title={call.talking ? 'Mic is live' : 'Mic gate closed'}
            aria-label={call.talking ? 'Mic is live' : 'Mic gate closed'}
          />
        </div>
      )}

      {(error || hint) && (
        <p role={error ? 'alert' : 'status'} className={`w-full text-xs ${error ? 'text-signal-err' : 'text-zinc-400'}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
