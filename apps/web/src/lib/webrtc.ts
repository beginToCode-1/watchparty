import {
  turnResponseSchema,
  type MediaFlags,
  type RtcAnswerRelay,
  type RtcIceRelay,
  type RtcOfferRelay,
} from '@watchparty/shared-types';
import { useRoom, type GateMode, type RemoteMedia } from '@/store/room';
import { getSocket, type AppSocket } from './socket';
import { SERVER_URL, readPref, writePref } from './util';

// Mesh A/V + screen share (docs/WEBRTC_AND_MEDIA.md §4–§8).
// ponytail: full mesh, ~6 video peers before uplink saturates; SFU (LiveKit/mediasoup) behind the same rtc:* events.
// Four fixed transceivers per pair: 0 mic, 1 camera, 2 screen video, 3 screen audio. Toggles are replaceTrack only,
// and only the lower userId ever offers, so there is no glare and no renegotiation except ICE restarts.

const SLOT_MIC = 0;
const SLOT_CAM = 1;
const SLOT_SCREEN = 2;
const SLOT_SCREEN_AUDIO = 3;
const IDLE_CLOSE_MS = 30_000;
const DISCONNECT_GRACE_MS = 5_000;
const RESTART_WINDOW_MS = 60_000;
const TURN_REFRESH_EARLY_S = 300;
const TURN_RETRY_MS = 30_000;
const VAD_TICK_MS = 20;
const VAD_ATTACK_FRAMES = 2;
const VAD_HANGOVER_MS = 300;
const VAD_HYSTERESIS_DB = 3;
const SPEAKING_DB = -50;
const SPEAKING_HANGOVER_MS = 250;
const PTT_TAIL_MS = 150;
const PTT_CODE = 'Space';
const UPLINK_BPS = 15_000_000;

type GainKind = 'voice' | 'screen';

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  initiator: boolean;
  pendingIce: RTCIceCandidateInit[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  restarts: number[];
  sinks: HTMLAudioElement[];
  voice: { src: MediaStreamAudioSourceNode; gain: GainNode; analyser: AnalyserNode } | null;
  screenAudio: { src: MediaStreamAudioSourceNode; gain: GainNode } | null;
  speakingUntil: number;
  media: RemoteMedia;
}

const anyMedia = (m: MediaFlags) => m.audio || m.video || m.screen;

/** Appends stereo Opus params to the Opus fmtp line (§8.2); the only SDP munging in the codebase. */
function stereoOpus(sdp: string): string {
  const pt = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp)?.[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} [^\\r\\n]*`, 'g'), (line) =>
    line.includes('stereo=1') ? line : `${line};stereo=1;sprop-stereo=1;maxaveragebitrate=128000`,
  );
}

function dbfs(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] ?? 0;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

function readGateMode(): GateMode {
  const v = readPref('wp:gate');
  return v === 'open' || v === 'ptt' || v === 'vad' ? v : 'vad';
}

function readVadDb(): number {
  const v = Number(readPref('wp:vadDb'));
  return Number.isFinite(v) && v >= -70 && v <= -20 ? v : -45;
}

class MeshManager {
  private readonly socket: AppSocket;
  private readonly peers = new Map<string, Peer>();
  private readonly orphanIce = new Map<string, RTCIceCandidateInit[]>();
  private readonly ctx: AudioContext;
  private readonly buf = new Float32Array(1024);
  private iceServers: Promise<RTCIceServer[]>;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private vadTimer: ReturnType<typeof setInterval>;
  private flags: MediaFlags = { audio: false, video: false, screen: false };
  private micStream: MediaStream | null = null;
  private micAnalyser: { src: MediaStreamAudioSourceNode; analyser: AnalyserNode; sink: GainNode; clone: MediaStreamTrack } | null =
    null;
  private camStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private gateMode: GateMode = readGateMode();
  private vadDb = readVadDb();
  private vadOpen = false;
  private vadAbove = 0;
  private vadBelowMs = 0;
  private pttDown = false;
  private pttTail: ReturnType<typeof setTimeout> | null = null;
  private localSpeakingUntil = 0;
  private lastSpeaking = '';
  private destroyed = false;
  private readonly unsubStore: () => void;

  constructor(
    private readonly roomCode: string,
    private readonly userId: string,
  ) {
    this.socket = getSocket();
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.iceServers = this.fetchIce();
    this.socket.on('rtc:offer', this.onOffer);
    this.socket.on('rtc:answer', this.onAnswer);
    this.socket.on('rtc:ice', this.onIce);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.releasePtt);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('pointerdown', this.resumeAudio);
    this.vadTimer = setInterval(() => this.vadTick(), VAD_TICK_MS);
    useRoom.getState().patchCall({ gateMode: this.gateMode, vadThresholdDb: this.vadDb });
    this.unsubStore = useRoom.subscribe((next, prev) => {
      if (next.participants !== prev.participants) this.sync();
    });
    this.sync();
  }

  // ---------- public API ----------

  async setMic(on: boolean): Promise<void> {
    if (on === this.flags.audio) return;
    if (on) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48_000 },
      });
      if (this.destroyed) return stopAll(stream);
      const track = stream.getAudioTracks()[0];
      if (!track) return stopAll(stream);
      this.micStream = stream;
      // The analyser reads a clone: the gated track is silent while closed and could never re-open the gate.
      const clone = track.clone();
      const src = this.ctx.createMediaStreamSource(new MediaStream([clone]));
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      src.connect(analyser).connect(sink).connect(this.ctx.destination);
      this.micAnalyser = { src, analyser, sink, clone };
      track.enabled = this.gateOpen();
      void this.ctx.resume();
    } else {
      if (this.micStream) stopAll(this.micStream);
      this.micStream = null;
      if (this.micAnalyser) {
        this.micAnalyser.src.disconnect();
        this.micAnalyser.sink.disconnect();
        this.micAnalyser.clone.stop();
      }
      this.micAnalyser = null;
    }
    this.replaceAll(SLOT_MIC);
    this.setFlags({ audio: on });
  }

  async setCam(on: boolean): Promise<void> {
    if (on === this.flags.video) return;
    if (on) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } },
      });
      if (this.destroyed) return stopAll(stream);
      this.camStream = stream;
    } else {
      if (this.camStream) stopAll(this.camStream);
      this.camStream = null;
    }
    this.replaceAll(SLOT_CAM);
    useRoom.getState().patchCall({ localCam: this.camStream });
    this.setFlags({ video: on });
  }

  /** Must run inside the click handler (user gesture). Resolves false when the user cancels the picker. */
  async startScreenShare(): Promise<boolean> {
    if (this.flags.screen) return true;
    // CaptureController (Chromium) is not in TypeScript's DOM lib yet.
    const Ctor: unknown = Reflect.get(window, 'CaptureController');
    const controller =
      typeof Ctor === 'function' ? new (Ctor as new () => { setFocusBehavior(b: 'no-focus-change'): void })() : undefined;
    const options = {
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 60, max: 60 },
        displaySurface: 'browser',
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48_000,
        suppressLocalAudioPlayback: false,
      },
      controller,
      selfBrowserSurface: 'exclude',
      preferCurrentTab: false,
      surfaceSwitching: 'include',
      systemAudio: 'include',
      monitorTypeSurfaces: 'include',
    } as DisplayMediaStreamOptions;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(options);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return false;
      throw err;
    }
    if (this.destroyed) {
      stopAll(stream);
      return false;
    }
    try {
      controller?.setFocusBehavior('no-focus-change');
    } catch {
      // Focus behavior can only be set right after the picker; later calls throw and are harmless.
    }
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0] ?? null;
    if (!video) {
      stopAll(stream);
      return false;
    }
    video.contentHint = 'motion';
    if (audio) audio.contentHint = 'music';
    video.addEventListener('ended', () => this.stopScreenShare());
    this.screenStream = stream;
    this.replaceAll(SLOT_SCREEN);
    this.replaceAll(SLOT_SCREEN_AUDIO);
    useRoom.getState().patchCall({ localScreen: stream, screenNoAudio: audio === null });
    this.setFlags({ screen: true });
    return true;
  }

  stopScreenShare(): void {
    if (!this.screenStream) return;
    stopAll(this.screenStream);
    this.screenStream = null;
    this.replaceAll(SLOT_SCREEN);
    this.replaceAll(SLOT_SCREEN_AUDIO);
    useRoom.getState().patchCall({ localScreen: null, screenNoAudio: false });
    this.setFlags({ screen: false });
  }

  setGateMode(mode: GateMode): void {
    this.gateMode = mode;
    writePref('wp:gate', mode);
    useRoom.getState().patchCall({ gateMode: mode });
    this.applyGate();
  }

  setVadThreshold(db: number): void {
    this.vadDb = Math.min(-20, Math.max(-70, db));
    writePref('wp:vadDb', String(this.vadDb));
    useRoom.getState().patchCall({ vadThresholdDb: this.vadDb });
  }

  /** On-screen hold-to-talk button (touch devices). */
  setPushToTalk(down: boolean): void {
    if (this.pttTail) clearTimeout(this.pttTail);
    this.pttTail = null;
    if (down) {
      this.pttDown = true;
      this.applyGate();
    } else {
      this.pttTail = setTimeout(() => {
        this.pttDown = false;
        this.applyGate();
      }, PTT_TAIL_MS);
    }
  }

  getGain(peerId: string, kind: GainKind): number {
    const peer = this.peers.get(peerId);
    const node = kind === 'voice' ? peer?.voice?.gain : peer?.screenAudio?.gain;
    return node ? node.gain.value : this.storedGain(peerId, kind);
  }

  setGain(peerId: string, kind: GainKind, value: number): void {
    const v = Math.min(2, Math.max(0, value));
    const peer = this.peers.get(peerId);
    const node = kind === 'voice' ? peer?.voice?.gain : peer?.screenAudio?.gain;
    node?.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
    const key = this.gainKey(peerId);
    if (!key) return;
    const cur = this.readGains(key);
    writePref(key, JSON.stringify({ ...cur, [kind]: v }));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubStore();
    clearInterval(this.vadTimer);
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.pttTail) clearTimeout(this.pttTail);
    this.socket.off('rtc:offer', this.onOffer);
    this.socket.off('rtc:answer', this.onAnswer);
    this.socket.off('rtc:ice', this.onIce);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.releasePtt);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('pointerdown', this.resumeAudio);
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    for (const s of [this.micStream, this.camStream, this.screenStream]) if (s) stopAll(s);
    this.micAnalyser?.clone.stop();
    void this.ctx.close();
    useRoom.getState().patchCall({
      mic: false,
      cam: false,
      screen: false,
      talking: false,
      localCam: null,
      localScreen: null,
      remote: {},
      speaking: {},
      screenNoAudio: false,
    });
  }

  // ---------- local media ----------

  private localTrack(slot: number): MediaStreamTrack | null {
    if (slot === SLOT_MIC) return this.micStream?.getAudioTracks()[0] ?? null;
    if (slot === SLOT_CAM) return this.camStream?.getVideoTracks()[0] ?? null;
    if (slot === SLOT_SCREEN) return this.screenStream?.getVideoTracks()[0] ?? null;
    return this.screenStream?.getAudioTracks()[0] ?? null;
  }

  private replaceAll(slot: number): void {
    const track = this.localTrack(slot);
    for (const peer of this.peers.values()) {
      const t = peer.pc.getTransceivers()[slot];
      if (t) t.sender.replaceTrack(track).catch((err: unknown) => console.warn('replaceTrack failed', err));
      void this.tuneEncodings(peer);
    }
  }

  private setFlags(patch: Partial<MediaFlags>): void {
    this.flags = { ...this.flags, ...patch };
    this.socket.emit('rtc:media', this.flags);
    useRoom.getState().patchCall({ mic: this.flags.audio, cam: this.flags.video, screen: this.flags.screen });
    this.sync();
  }

  private gateOpen(): boolean {
    if (this.gateMode === 'open') return true;
    if (this.gateMode === 'ptt') return this.pttDown;
    return this.vadOpen;
  }

  private applyGate(): void {
    const open = this.gateOpen();
    const track = this.localTrack(SLOT_MIC);
    if (track) track.enabled = open;
    if (useRoom.getState().call.talking !== (open && !!track)) useRoom.getState().patchCall({ talking: open && !!track });
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.gateMode !== 'ptt' || e.code !== PTT_CODE || isTypingTarget(e.target)) return;
    e.preventDefault();
    if (!e.repeat) this.setPushToTalk(true);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (this.gateMode !== 'ptt' || e.code !== PTT_CODE) return;
    this.setPushToTalk(false);
  };

  private readonly releasePtt = (): void => {
    if (this.pttTail) clearTimeout(this.pttTail);
    this.pttTail = null;
    this.pttDown = false;
    this.applyGate();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.releasePtt();
  };

  private readonly resumeAudio = (): void => {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  };

  /** 20 ms: VAD gate (attack 2 frames, 300 ms hangover, 3 dB hysteresis) and speaking indicators. */
  private vadTick(): void {
    const now = performance.now();
    const speaking: Record<string, boolean> = {};
    if (this.micAnalyser) {
      const level = dbfs(this.micAnalyser.analyser, this.buf);
      if (!this.vadOpen) {
        this.vadAbove = level > this.vadDb ? this.vadAbove + 1 : 0;
        if (this.vadAbove >= VAD_ATTACK_FRAMES) {
          this.vadOpen = true;
          this.vadBelowMs = 0;
        }
      } else {
        this.vadBelowMs = level < this.vadDb - VAD_HYSTERESIS_DB ? this.vadBelowMs + VAD_TICK_MS : 0;
        if (this.vadBelowMs >= VAD_HANGOVER_MS) {
          this.vadOpen = false;
          this.vadAbove = 0;
        }
      }
      if (this.gateMode === 'vad') this.applyGate();
      if (this.gateOpen() && level > SPEAKING_DB) this.localSpeakingUntil = now + SPEAKING_HANGOVER_MS;
      speaking[this.userId] = now < this.localSpeakingUntil;
    }
    const participants = useRoom.getState().participants;
    for (const peer of this.peers.values()) {
      if (!peer.voice) continue;
      const audioOn = participants.find((p) => p.id === peer.id)?.media.audio ?? false;
      if (audioOn && dbfs(peer.voice.analyser, this.buf) > SPEAKING_DB) peer.speakingUntil = now + SPEAKING_HANGOVER_MS;
      speaking[peer.id] = now < peer.speakingUntil;
    }
    const key = Object.keys(speaking)
      .filter((k) => speaking[k])
      .sort()
      .join(',');
    if (key !== this.lastSpeaking) {
      this.lastSpeaking = key;
      useRoom.getState().patchCall({ speaking });
    }
  }

  // ---------- TURN ----------

  private async fetchIce(): Promise<RTCIceServer[]> {
    try {
      const q = new URLSearchParams({ roomCode: this.roomCode, userId: this.userId });
      const res = await fetch(`${SERVER_URL}/api/turn?${q.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = turnResponseSchema.parse(await res.json());
      const refreshS = Math.max(60, parsed.ttl - TURN_REFRESH_EARLY_S);
      this.scheduleTurnRefresh(refreshS * 1000);
      return parsed.iceServers;
    } catch (err: unknown) {
      // Host/srflx candidates still work on localhost and most LANs; try again later for TURN.
      console.warn('TURN credentials unavailable, using host candidates only', err);
      this.scheduleTurnRefresh(TURN_RETRY_MS);
      return [];
    }
  }

  private scheduleTurnRefresh(ms: number): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => {
      if (this.destroyed) return;
      const next = this.fetchIce();
      this.iceServers = next;
      void next.then((iceServers) => {
        if (iceServers.length === 0) return;
        for (const peer of this.peers.values()) {
          peer.pc.setConfiguration({ ...peer.pc.getConfiguration(), iceServers });
        }
      });
    }, ms);
  }

  // ---------- pair lifecycle ----------

  /** Lazy pairs: connected only while either side has media on; the lower userId initiates. */
  private sync(): void {
    if (this.destroyed) return;
    const others = useRoom.getState().participants.filter((p) => p.id !== this.userId);
    const present = new Set(others.map((p) => p.id));
    for (const id of [...this.peers.keys()]) if (!present.has(id)) this.closePeer(id);
    for (const p of others) {
      const wanted = anyMedia(this.flags) || anyMedia(p.media);
      const peer = this.peers.get(p.id);
      if (peer) {
        if (wanted && peer.idleTimer) {
          clearTimeout(peer.idleTimer);
          peer.idleTimer = null;
        } else if (!wanted && !peer.idleTimer) {
          peer.idleTimer = setTimeout(() => this.closeIfIdle(p.id), IDLE_CLOSE_MS);
        }
        void this.tuneEncodings(peer);
      } else if (wanted && this.userId < p.id) {
        void this.connect(p.id);
      }
    }
  }

  private closeIfIdle(id: string): void {
    const p = useRoom.getState().participants.find((x) => x.id === id);
    if (!p || !(anyMedia(this.flags) || anyMedia(p.media))) this.closePeer(id);
  }

  private async connect(id: string): Promise<void> {
    const iceServers = await this.iceServers;
    if (this.destroyed || this.peers.has(id)) return;
    const peer = this.createPeer(id, true, iceServers);
    for (let slot = 0; slot < 4; slot++) {
      const t = peer.pc.addTransceiver(slot === SLOT_MIC || slot === SLOT_SCREEN_AUDIO ? 'audio' : 'video', {
        direction: 'sendrecv',
      });
      const track = this.localTrack(slot);
      if (track) void t.sender.replaceTrack(track);
    }
    // negotiationneeded fires once the transceivers exist and sends the first offer.
  }

  private createPeer(id: string, initiator: boolean, iceServers: RTCIceServer[]): Peer {
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    const peer: Peer = {
      id,
      pc,
      initiator,
      pendingIce: this.orphanIce.get(id) ?? [],
      idleTimer: null,
      disconnectTimer: null,
      restarts: [],
      sinks: [],
      voice: null,
      screenAudio: null,
      speakingUntil: 0,
      media: { cam: null, screen: null },
    };
    this.orphanIce.delete(id);
    this.peers.set(id, peer);

    pc.onnegotiationneeded = () => {
      if (peer.initiator && pc.signalingState === 'stable') void this.sendOffer(peer);
    };
    // null candidate = end-of-candidates, sent as candidate '' (the schema's shape for it).
    pc.onicecandidate = (e) => this.socket.emit('rtc:ice', { to: id, candidate: { candidate: '', ...e.candidate?.toJSON() } });
    pc.ontrack = (e) => this.onTrack(peer, e);
    pc.onconnectionstatechange = () => this.onConnectionState(peer);
    return peer;
  }

  private async sendOffer(peer: Peer): Promise<void> {
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription({ type: 'offer', sdp: stereoOpus(offer.sdp ?? '') });
      const sdp = peer.pc.localDescription?.sdp;
      if (sdp) this.socket.emit('rtc:offer', { to: peer.id, sdp });
    } catch (err: unknown) {
      console.warn('offer failed', err);
    }
  }

  private readonly onOffer = (p: RtcOfferRelay): void => {
    void (async () => {
      let peer = this.peers.get(p.from);
      if (peer?.initiator) return; // only the lower userId offers; anything else is a protocol violation
      // A new DTLS fingerprint means the initiator rebuilt its PC (idle close or failed restarts): start over.
      if (peer?.pc.remoteDescription && fingerprint(peer.pc.remoteDescription.sdp) !== fingerprint(p.sdp)) {
        this.closePeer(p.from);
        peer = undefined;
      }
      if (!peer) {
        const iceServers = await this.iceServers;
        if (this.destroyed) return;
        peer = this.peers.get(p.from) ?? this.createPeer(p.from, false, iceServers);
      }
      const pc = peer.pc;
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: p.sdp });
        pc.getTransceivers().forEach((t, slot) => {
          if (slot > SLOT_SCREEN_AUDIO) return;
          t.direction = 'sendrecv';
          void t.sender.replaceTrack(this.localTrack(slot));
        });
        await this.flushIce(peer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription({ type: 'answer', sdp: stereoOpus(answer.sdp ?? '') });
        const sdp = pc.localDescription?.sdp;
        if (sdp) this.socket.emit('rtc:answer', { to: p.from, sdp });
        this.sync();
      } catch (err: unknown) {
        console.warn('answer failed', err);
      }
    })();
  };

  private readonly onAnswer = (p: RtcAnswerRelay): void => {
    const peer = this.peers.get(p.from);
    if (!peer?.initiator || peer.pc.signalingState !== 'have-local-offer') return;
    peer.pc
      .setRemoteDescription({ type: 'answer', sdp: p.sdp })
      .then(() => this.flushIce(peer))
      .catch((err: unknown) => console.warn('setRemoteDescription(answer) failed', err));
  };

  private readonly onIce = (p: RtcIceRelay): void => {
    const peer = this.peers.get(p.from);
    if (!peer) {
      const list = this.orphanIce.get(p.from) ?? [];
      list.push(p.candidate);
      this.orphanIce.set(p.from, list.slice(-50));
      return;
    }
    if (!peer.pc.remoteDescription) {
      peer.pendingIce.push(p.candidate);
      return;
    }
    peer.pc.addIceCandidate(p.candidate).catch(() => {
      // Stale candidates after an ICE restart are expected.
    });
  };

  private async flushIce(peer: Peer): Promise<void> {
    const list = peer.pendingIce;
    peer.pendingIce = [];
    for (const c of list) {
      await peer.pc.addIceCandidate(c).catch(() => {
        // Stale candidates after an ICE restart are expected.
      });
    }
  }

  private onConnectionState(peer: Peer): void {
    const state = peer.pc.connectionState;
    if (peer.disconnectTimer && state !== 'disconnected') {
      clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = null;
    }
    if (state === 'connected') void this.tuneEncodings(peer);
    if (!peer.initiator) return;
    if (state === 'disconnected' && !peer.disconnectTimer) {
      peer.disconnectTimer = setTimeout(() => {
        peer.disconnectTimer = null;
        if (peer.pc.connectionState === 'disconnected') peer.pc.restartIce();
      }, DISCONNECT_GRACE_MS);
    } else if (state === 'failed') {
      const now = Date.now();
      peer.restarts = peer.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      if (peer.restarts.length >= 2) {
        // Restarts keep failing: rebuild the pair from scratch with fresh TURN credentials.
        this.closePeer(peer.id);
        this.iceServers = this.fetchIce();
        this.sync();
        return;
      }
      peer.restarts.push(now);
      peer.pc.restartIce();
    }
  }

  private onTrack(peer: Peer, e: RTCTrackEvent): void {
    const slot = peer.pc.getTransceivers().indexOf(e.transceiver);
    const stream = new MediaStream([e.track]);
    if (slot === SLOT_MIC || slot === SLOT_SCREEN_AUDIO) {
      // Chrome: remote WebRTC audio fed only into Web Audio is silent unless a (muted) element also plays it.
      const sink = new Audio();
      sink.srcObject = stream;
      sink.muted = true;
      sink.play().catch(() => {
        // Muted playback is always allowed; a rejection means the element was torn down already.
      });
      peer.sinks.push(sink);
      const src = this.ctx.createMediaStreamSource(stream);
      const gain = this.ctx.createGain();
      if (slot === SLOT_MIC) {
        peer.voice?.src.disconnect();
        gain.gain.value = this.storedGain(peer.id, 'voice');
        src.connect(gain).connect(this.ctx.destination);
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0;
        src.connect(analyser);
        peer.voice = { src, gain, analyser };
      } else {
        peer.screenAudio?.src.disconnect();
        gain.gain.value = this.storedGain(peer.id, 'screen');
        src.connect(gain).connect(this.ctx.destination);
        peer.screenAudio = { src, gain };
      }
      return;
    }
    if (slot === SLOT_CAM) peer.media = { ...peer.media, cam: stream };
    else if (slot === SLOT_SCREEN) peer.media = { ...peer.media, screen: stream };
    this.publishRemote();
  }

  private closePeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    for (const t of [peer.idleTimer, peer.disconnectTimer]) if (t) clearTimeout(t);
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    for (const s of peer.sinks) {
      s.pause();
      s.srcObject = null;
    }
    peer.voice?.src.disconnect();
    peer.voice?.gain.disconnect();
    peer.screenAudio?.src.disconnect();
    peer.screenAudio?.gain.disconnect();
    this.publishRemote();
  }

  private publishRemote(): void {
    const remote: Record<string, RemoteMedia> = {};
    for (const p of this.peers.values()) remote[p.id] = p.media;
    useRoom.getState().patchCall({ remote });
  }

  /** Bitrate ladder (§8.2): screen splits the uplink budget per peer; camera drops to 250 kbps / half-res above 4. */
  private async tuneEncodings(peer: Peer): Promise<void> {
    const transceivers = peer.pc.getTransceivers();
    const peerCount = Math.max(1, [...this.peers.values()].filter((p) => p.pc.connectionState === 'connected').length);
    const videoPeers = useRoom.getState().participants.filter((p) => p.media.video).length;
    const crowded = videoPeers > 4;
    await setEncoding(transceivers[SLOT_CAM]?.sender, {
      maxBitrate: crowded ? 250_000 : 500_000,
      scaleResolutionDownBy: crowded ? 2 : 1,
    });
    await setEncoding(
      transceivers[SLOT_SCREEN]?.sender,
      {
        maxBitrate: Math.max(1_000_000, Math.min(6_000_000, Math.floor(UPLINK_BPS / peerCount))),
        maxFramerate: peerCount <= 3 ? 60 : 30,
      },
      'maintain-framerate',
    );
  }

  private gainKey(peerId: string): string | null {
    const nick = useRoom.getState().participants.find((p) => p.id === peerId)?.nickname;
    return nick ? `wp:gain:${nick}` : null;
  }

  private readGains(key: string): Partial<Record<GainKind, number>> {
    try {
      const raw: unknown = JSON.parse(readPref(key) ?? '{}');
      if (typeof raw !== 'object' || raw === null) return {};
      const out: Partial<Record<GainKind, number>> = {};
      for (const k of ['voice', 'screen'] as const) {
        const v: unknown = Reflect.get(raw, k);
        if (typeof v === 'number' && v >= 0 && v <= 2) out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  private storedGain(peerId: string, kind: GainKind): number {
    const key = this.gainKey(peerId);
    return (key ? this.readGains(key)[kind] : undefined) ?? 1;
  }
}

const fingerprint = (sdp: string) => /a=fingerprint:\S+ (\S+)/.exec(sdp)?.[1] ?? '';

function stopAll(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}

async function setEncoding(
  sender: RTCRtpSender | undefined,
  patch: Partial<RTCRtpEncodingParameters>,
  degradationPreference?: string,
): Promise<void> {
  if (!sender?.track) return;
  const params = sender.getParameters();
  const first = params.encodings[0];
  if (!first) return; // not negotiated yet; re-applied on 'connected'
  params.encodings[0] = { ...first, ...patch };
  if (degradationPreference) Object.assign(params, { degradationPreference });
  await sender.setParameters(params).catch((err: unknown) => console.warn('setParameters failed', err));
}

// ---------- page-wide instance ----------

let mesh: MeshManager | null = null;

export function startMesh(roomCode: string, userId: string): MeshManager {
  mesh?.destroy();
  mesh = new MeshManager(roomCode, userId);
  return mesh;
}

export function stopMesh(): void {
  mesh?.destroy();
  mesh = null;
}

export function getMesh(): MeshManager | null {
  return mesh;
}

export function mediaError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'Permission denied — check the site settings.';
    if (err.name === 'NotFoundError') return 'No device found.';
    if (err.name === 'NotReadableError') return 'The device is in use by another app.';
  }
  return err instanceof Error ? err.message : 'Could not start the device.';
}
